import hmac
import json
import logging
import os
import re
import time
import uuid
from collections.abc import Iterator
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import approvals as approvals_mod
from .artifact_schema import Artifact
from .auth import AuthError, User, authenticate, client_config
from .errors import UserFacingError
from .incidents import (
    MAX_CONCURRENT_ANALYSES, AnomalyEvent, create_work_order, analysis_prompt, mock_analysis, work_order_proposal,
)
from .mock_stream import mock_run
from .settings import settings
from .sharing import ShareIn, available_channels, precheck, share as share_artifact
from .stores import Stores

log = logging.getLogger("uvicorn.error")
THREAD_ID_PATTERN = r"^thread_[A-Za-z0-9]{1,64}$"
ARTIFACT_ID_PATTERN = r"^[a-z0-9][a-z0-9-]{0,63}$"
SYSTEM_USER = User("system", "Automated monitor", frozenset())

state: dict = {}
stores = Stores(settings.data_dir or None)


@asynccontextmanager
async def lifespan(_: FastAPI):
    if settings.effective_auth_mode == "entra" and not (settings.entra_tenant_id and settings.entra_client_id):
        raise RuntimeError("Set ENTRA_TENANT_ID and ENTRA_CLIENT_ID, or set AUTH_MODE=mock for demo sign-in.")
    if settings.effective_auth_mode == "mock" and not settings.mock_agents:
        log.warning("AUTH_MODE=mock with real agents: demo personas are NOT secure. Do not expose this server.")
    if not settings.mock_agents:
        if not (settings.project_endpoint and settings.orchestrator_agent_id):
            raise RuntimeError("Set PROJECT_ENDPOINT and run `python -m agents.setup_agents`, or set MOCK_AGENTS=1.")
        from azure.ai.agents import AgentsClient
        from azure.identity import DefaultAzureCredential

        state["client"] = AgentsClient(endpoint=settings.project_endpoint, credential=DefaultAzureCredential())
    yield
    if "client" in state:
        state["client"].close()


app = FastAPI(title="Foundry multi-agent demo", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type", "Authorization", "X-Demo-User"],
)


class SecurityHeaders:
    """Pure ASGI middleware, so streaming responses and disconnect handling are untouched."""

    HEADERS = [(b"x-content-type-options", b"nosniff"), (b"x-frame-options", b"DENY"), (b"referrer-policy", b"same-origin")]

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                message.setdefault("headers", [])
                present = {name.lower() for name, _ in message["headers"]}
                message["headers"] += [(n, v) for n, v in self.HEADERS if n not in present]
            await send(message)

        return await self.app(scope, receive, send_with_headers)


app.add_middleware(SecurityHeaders)


# ---------- auth ----------

def current_user(request: Request) -> User:
    try:
        return authenticate(request.headers, settings)
    except AuthError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc


def need(permission: str):
    def dependency(user: User = Depends(current_user)) -> User:
        if not user.can(permission):
            stores.audit.record(user.name, "access_denied", f"Blocked: {permission}", permission=permission,
                                roles=sorted(user.roles))
            raise HTTPException(status_code=403, detail="Your role does not allow this action")
        return user

    return dependency


def _http(exc: UserFacingError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=str(exc))


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "mode": "mock" if settings.mock_agents else "foundry"}


@app.get("/api/auth/config")
def auth_config() -> dict:
    return client_config(settings)


@app.get("/api/me")
def me(user: User = Depends(current_user)) -> dict:
    return user.public()


# ---------- chat ----------

class MessageIn(BaseModel):
    content: str = Field(min_length=1, max_length=8000)
    artifact_context: dict | None = None


@app.post("/api/threads")
def create_thread(user: User = Depends(need("chat"))) -> dict:
    thread_id = f"thread_{uuid.uuid4().hex}" if settings.mock_agents else state["client"].threads.create().id
    stores.threads.register(thread_id, user.id)
    return {"thread_id": thread_id}


def _sse(events: Iterator[dict], on_finish) -> Iterator[str]:
    started = time.monotonic()
    tools: dict[str, str] = {}
    stats = {"artifacts": 0, "error": None, "status": "cancelled"}
    try:
        for event in events:
            if event["type"] == "tool_call" and event.get("id"):
                tools[event["id"]] = event.get("name") or "tool"
            elif event["type"] == "artifact":
                stats["artifacts"] += 1
            elif event["type"] == "error":
                stats["error"] = event.get("message")
            yield f"data: {json.dumps(event)}\n\n"
        stats["status"] = "error" if stats["error"] else "completed"
    except Exception:
        log.exception("Agent stream failed")
        stats.update(status="error", error="Agent stream failed")
        yield f"data: {json.dumps({'type': 'error', 'message': 'The agent run failed. Check the server logs.'})}\n\n"
    finally:
        # Runs on client disconnect too, which lets the orchestrator cancel the in-flight run
        close = getattr(events, "close", None)
        if close:
            close()
        on_finish(status=stats["status"], error=stats["error"], artifacts=stats["artifacts"],
                  tools=sorted(set(tools.values())), duration_ms=int((time.monotonic() - started) * 1000))
    yield f"data: {json.dumps({'type': 'done'})}\n\n"


@app.post("/api/threads/{thread_id}/messages")
def post_message(thread_id: str, body: MessageIn, user: User = Depends(need("chat"))) -> StreamingResponse:
    if not re.fullmatch(THREAD_ID_PATTERN, thread_id):
        raise HTTPException(status_code=400, detail="Invalid thread id")
    if stores.threads.owner(thread_id) != user.id:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if body.artifact_context:
        if len(json.dumps(body.artifact_context)) > 200_000:
            raise HTTPException(status_code=413, detail="Artifact context too large")
        if not re.fullmatch(ARTIFACT_ID_PATTERN, str(body.artifact_context.get("artifact_id", ""))):
            raise HTTPException(status_code=400, detail="Invalid artifact id")

    if settings.mock_agents:
        events = mock_run(body.content, body.artifact_context)
    else:
        from .agent_stream import OrchestratorStream

        events = OrchestratorStream(state["client"]).run(thread_id, body.content, body.artifact_context)

    def finish(**run):
        stores.audit.record(user.name, "agent_run", f"Agent run {run['status']}", thread_id=thread_id,
                            prompt=body.content[:200], editing=bool(body.artifact_context), **run)

    return StreamingResponse(
        _sse(events, finish),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------- sharing ----------

@app.get("/api/share/channels")
def share_channels(_: User = Depends(need("share"))) -> dict:
    return {"mode": settings.effective_share_mode, "channels": available_channels(settings),
            "requires_approval": settings.share_requires_approval}


@app.get("/api/shares")
def list_shares(_: User = Depends(need("operations_read"))) -> dict:
    return {"shares": stores.shares.recent()}


@app.post("/api/share")
def share_endpoint(body: ShareIn, user: User = Depends(need("share"))):
    try:
        precheck(body, settings)
        if settings.share_requires_approval:
            label = body.channel if not body.recipients else f"{body.channel} to {', '.join(body.recipients)}"
            apr = stores.approvals.create(
                "share", f"Share “{body.artifact.title}”", f"Share via {label}",
                {"channel": body.channel, "recipients": body.recipients, "artifact": body.artifact.title},
                body.model_dump(mode="json", exclude={"pdf_base64"}), user, settings.approval_ttl_minutes,
                blob=body.pdf_base64)
            stores.audit.record(user.name, "approval_requested", apr["title"], approval_id=apr["id"], kind="share")
            return JSONResponse(status_code=202, content={
                "status": "pending_approval", "approval_id": apr["id"],
                "summary": "Sent for approval. It will be shared once an approver signs off."})
        result = share_artifact(body, settings, stores.shares, actor=user.name)
    except UserFacingError as exc:
        raise _http(exc) from exc
    stores.audit.record(user.name, "share", result["summary"], channel=body.channel, artifact=body.artifact.title,
                        simulated=result["simulated"])
    return {**result, "status": "sent"}


# ---------- shared library ----------

class PublishIn(BaseModel):
    artifact: Artifact
    note: str = Field(default="", max_length=500)


@app.get("/api/library")
def library_list(_: User = Depends(need("library_read"))) -> dict:
    return {"items": stores.library.list()}


@app.get("/api/library/{library_id}")
def library_get(library_id: str, _: User = Depends(need("library_read"))) -> dict:
    entry = stores.library.get(library_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Not found")
    return entry


@app.post("/api/library")
def library_publish(body: PublishIn, user: User = Depends(need("publish"))) -> dict:
    entry = stores.library.publish(user, body.artifact.model_dump(mode="json", exclude_none=True), body.note)
    stores.audit.record(user.name, "publish", f"Published “{entry['title']}” v{entry['version']}",
                        library_id=entry["id"], artifact=entry["title"])
    return entry


@app.delete("/api/library/{library_id}")
def library_remove(library_id: str, user: User = Depends(need("library_read"))) -> dict:
    try:
        stores.library.remove(library_id, user)
    except UserFacingError as exc:
        raise _http(exc) from exc
    stores.audit.record(user.name, "unpublish", "Removed an artifact from the library", library_id=library_id)
    return {"ok": True}


# ---------- approvals ----------

class DecisionIn(BaseModel):
    decision: Literal["approve", "reject"]
    comment: str | None = Field(default=None, max_length=500)


def _execute(kind: str, payload: dict, blob: str | None, actor: str) -> dict:
    if kind == "share":
        return share_artifact(ShareIn.model_validate({**payload, "pdf_base64": blob}), settings, stores.shares, actor=actor)
    if kind == "work_order":
        return create_work_order(payload, settings)
    raise UserFacingError(f"Unknown action type: {kind}")


@app.get("/api/approvals")
def approvals_list(_: User = Depends(need("operations_read"))) -> dict:
    return {"items": [approvals_mod.public(a) for a in stores.approvals.list()]}


@app.post("/api/approvals/{approval_id}/decision")
def approvals_decide(approval_id: str, body: DecisionIn, user: User = Depends(need("decide"))) -> dict:
    existing = stores.approvals.get(approval_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Approval not found")
    kind = existing["kind"]
    try:
        rec = stores.approvals.decide(approval_id, user, body.decision, body.comment,
                                      lambda payload, blob: _execute(kind, payload, blob, existing["requested_by"]["name"]),
                                      settings.allow_self_approval)
    except UserFacingError as exc:
        raise _http(exc) from exc
    stores.audit.record(user.name, "approval_decided", f"{rec['status'].capitalize()}: {rec['title']}",
                        approval_id=approval_id, kind=kind, status=rec["status"], comment=body.comment,
                        requested_by=rec["requested_by"]["name"])
    if kind == "work_order" and rec["ref"]:
        outcome = {"approved": "resolved", "rejected": "dismissed"}.get(rec["status"], "action_failed")
        stores.incidents.update(rec["ref"], status=outcome, work_order=rec["result"], error=rec["error"])
    return approvals_mod.public(rec)


# ---------- event-driven incidents ----------

def _analyze(event: AnomalyEvent) -> dict:
    if settings.mock_agents:
        time.sleep(1.5)
        return mock_analysis(event)
    from .agent_stream import OrchestratorStream

    client = state["client"]
    thread_id = client.threads.create().id
    text: list[str] = []
    artifact = None
    for e in OrchestratorStream(client).run(thread_id, analysis_prompt(event), None):
        if e["type"] == "text_delta":
            text.append(e["text"])
        elif e["type"] == "artifact":
            artifact = e["artifact"]
        elif e["type"] == "error":
            raise RuntimeError(e["message"])
    return {"summary": "".join(text).strip() or "The agent returned no summary.", "artifact": artifact}


def _run_incident(incident_id: str, event: AnomalyEvent) -> None:
    try:
        result = _analyze(event)
        artifact = result.get("artifact")
        if artifact:
            artifact = {**artifact, "artifact_id": f"incident-{incident_id.removeprefix('inc_')}"}
        proposal = work_order_proposal(event, result["summary"])
        proposal["source_incident"] = incident_id
        apr = stores.approvals.create(
            "work_order", proposal["title"], result["summary"][:300],
            {"priority": proposal["priority"], "scope": event.scope, "incident_id": incident_id},
            proposal, SYSTEM_USER, settings.approval_ttl_minutes, ref=incident_id)
        stores.incidents.update(incident_id, status="awaiting_approval", summary=result["summary"], artifact=artifact,
                                approval_id=apr["id"])
        stores.audit.record("system", "incident_analyzed", f"Analysis ready: {proposal['title']}",
                            incident_id=incident_id, approval_id=apr["id"])
    except Exception:
        log.exception("Incident analysis failed")
        stores.incidents.update(incident_id, status="failed", error="Analysis failed. Check the server logs.")
        stores.audit.record("system", "incident_failed", "Incident analysis failed", incident_id=incident_id)


@app.post("/api/events/anomaly", status_code=202)
def anomaly_event(body: AnomalyEvent, request: Request, background: BackgroundTasks) -> dict:
    secret = request.headers.get("x-webhook-secret")
    if secret is not None:
        # Machine callers (Fabric Activator, Event Grid, Logic Apps) authenticate with a shared secret
        if not settings.event_webhook_secret or not hmac.compare_digest(secret, settings.event_webhook_secret):
            raise HTTPException(status_code=401, detail="Invalid webhook secret")
        actor = f"event:{body.source}"
    else:
        user = current_user(request)
        if not user.can("incident_create"):
            stores.audit.record(user.name, "access_denied", "Blocked: incident_create", permission="incident_create")
            raise HTTPException(status_code=403, detail="Your role does not allow this action")
        actor = user.name
    if stores.incidents.analyzing_count() >= MAX_CONCURRENT_ANALYSES:
        raise HTTPException(status_code=429, detail="Too many analyses in progress. Try again shortly.")
    incident = stores.incidents.create(body, actor)
    stores.audit.record(actor, "event_received", f"Anomaly: {body.metric} {body.change_pct:+.1f}%",
                        incident_id=incident["id"], scope=body.scope, source=body.source)
    background.add_task(_run_incident, incident["id"], body)
    return {"incident_id": incident["id"], "status": incident["status"]}


@app.get("/api/incidents")
def incidents_list(_: User = Depends(need("operations_read"))) -> dict:
    return {"items": stores.incidents.list()}


@app.get("/api/incidents/{incident_id}")
def incidents_get(incident_id: str, _: User = Depends(need("operations_read"))) -> dict:
    incident = stores.incidents.get(incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Not found")
    return incident


# ---------- governance ----------

@app.get("/api/audit")
def audit_list(type: str | None = None, limit: int = 100, _: User = Depends(need("audit_read"))) -> dict:
    return {"items": stores.audit.recent(type, max(1, min(limit, 500)))}


def _percentile(values: list[int], pct: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(len(ordered) * pct))]


@app.get("/api/metrics")
def metrics(_: User = Depends(need("audit_read"))) -> dict:
    entries = stores.audit.all()
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat(timespec="seconds")
    runs = [e for e in entries if e["type"] == "agent_run"]
    recent = [e for e in runs if e["at"] >= cutoff]
    durations = [e["detail"].get("duration_ms", 0) for e in recent if e["detail"].get("status") != "cancelled"]
    tool_counts: dict[str, int] = {}
    for e in recent:
        for name in e["detail"].get("tools", []):
            tool_counts[name] = tool_counts.get(name, 0) + 1
    approvals = stores.approvals.list()
    incidents = stores.incidents.list()
    return {
        "runs_24h": len(recent),
        "run_errors_24h": sum(1 for e in recent if e["detail"].get("status") == "error"),
        "run_cancelled_24h": sum(1 for e in recent if e["detail"].get("status") == "cancelled"),
        "avg_run_ms": int(sum(durations) / len(durations)) if durations else 0,
        "p95_run_ms": _percentile(durations, 0.95),
        "artifacts_24h": sum(e["detail"].get("artifacts", 0) for e in recent),
        "tool_usage_24h": dict(sorted(tool_counts.items(), key=lambda kv: -kv[1])),
        "shares_total": sum(1 for e in entries if e["type"] == "share"),
        "published_total": sum(1 for e in entries if e["type"] == "publish"),
        "access_denied_total": sum(1 for e in entries if e["type"] == "access_denied"),
        "approvals": {s: sum(1 for a in approvals if a["status"] == s)
                      for s in ("pending", "approved", "rejected", "expired", "failed")},
        "incidents_open": sum(1 for i in incidents if i["status"] in ("analyzing", "awaiting_approval")),
        "incidents_total": len(incidents),
    }


# ---------- web app (served from the same origin in deployment) ----------

def find_static_dir() -> Path | None:
    """The built SPA: STATIC_DIR, then backend/static (deployment package), then ../dist (local `vite build`)."""
    root = Path(__file__).resolve().parent.parent
    for candidate in (os.getenv("STATIC_DIR"), root / "static", root.parent / "dist"):
        if candidate and (Path(candidate) / "index.html").is_file():
            return Path(candidate).resolve()
    return None


@app.get("/{path:path}", include_in_schema=False)
def web_app(path: str):
    static = find_static_dir()
    if static is None or path.startswith("api/") or path == "api":
        raise HTTPException(status_code=404, detail="Not found")
    candidate = (static / path).resolve()
    if path and candidate.is_file() and static in candidate.parents:
        # Vite fingerprints files under /assets, so they can be cached for a year
        cache = "public, max-age=31536000, immutable" if path.startswith("assets/") else "no-cache"
        return FileResponse(candidate, headers={"Cache-Control": cache})
    return FileResponse(static / "index.html", headers={"Cache-Control": "no-cache"})
