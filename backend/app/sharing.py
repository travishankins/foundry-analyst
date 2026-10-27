"""Share an artifact to Teams, SharePoint, OneDrive or email. `mock` mode simulates delivery for demos."""

import base64
import binascii
import html
import logging
import re
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Literal
from urllib.parse import quote

import httpx
from pydantic import BaseModel, Field, field_validator

from .artifact_schema import Artifact
from .errors import UserFacingError
from .settings import Settings

log = logging.getLogger("uvicorn.error")

Channel = Literal["teams", "sharepoint", "onedrive", "email"]
CHANNEL_LABELS = {"teams": "Teams", "sharepoint": "SharePoint", "onedrive": "OneDrive", "email": "Email"}
GRAPH = "https://graph.microsoft.com/v1.0"
MAX_PDF_BYTES = 8 * 1024 * 1024
EMAIL_PATTERN = re.compile(r"^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$")


class ShareError(UserFacingError):
    """A failure that is safe to show to the user."""


class ShareIn(BaseModel):
    artifact: Artifact
    channel: Channel
    recipients: list[str] = Field(default_factory=list, max_length=20)
    message: str = Field(default="", max_length=1000)
    pdf_base64: str | None = Field(default=None, max_length=MAX_PDF_BYTES * 4 // 3 + 16)

    @field_validator("recipients")
    @classmethod
    def _clean_recipients(cls, value: list[str]) -> list[str]:
        cleaned = [r.strip() for r in value if r.strip()]
        for r in cleaned:
            if not EMAIL_PATTERN.fullmatch(r):
                raise ValueError(f"Invalid email address: {r}")
        return list(dict.fromkeys(cleaned))


def available_channels(cfg: Settings) -> list[str]:
    if cfg.effective_share_mode == "mock":
        return list(CHANNEL_LABELS)
    ready = {
        "teams": bool(cfg.teams_webhook_url),
        "sharepoint": bool(cfg.sharepoint_drive_id),
        "onedrive": bool(cfg.onedrive_user),
        "email": bool(cfg.graph_sender),
    }
    return [c for c in CHANNEL_LABELS if ready[c]]


def decode_pdf(data: str | None) -> bytes | None:
    if not data:
        return None
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ShareError("Attachment is not valid base64") from exc
    if len(raw) > MAX_PDF_BYTES:
        raise ShareError("Attachment is too large", 413)
    if not raw.startswith(b"%PDF"):
        raise ShareError("Attachment must be a PDF")
    return raw


def file_name(artifact: Artifact) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", artifact.title.lower()).strip("-")[:60] or artifact.artifact_id
    return f"{slug}.pdf"


def summarize(artifact: Artifact) -> list[tuple[str, str]]:
    """Top-level KPI label/value pairs, used for Teams cards and email bodies."""
    facts: list[tuple[str, str]] = []

    def walk(blocks: list[Any]) -> None:
        for b in blocks:
            if b.type == "kpi":
                facts.append((b.label, b.value + (f" ({b.delta})" if b.delta else "")))
            elif b.type == "grid":
                walk(b.blocks)

    walk(artifact.blocks)
    return facts[:8]


def render_email_html(artifact: Artifact, message: str) -> str:
    e = html.escape
    rows = "".join(
        f"<tr><td style='padding:4px 12px 4px 0;color:#555'>{e(k)}</td><td><b>{e(v)}</b></td></tr>"
        for k, v in summarize(artifact)
    )
    note = f"<p style='white-space:pre-wrap'>{e(message)}</p>" if message else ""
    kind = "report" if artifact.kind == "report" else "dashboard"
    return (
        f"<div style='font-family:Segoe UI,Arial,sans-serif;font-size:14px'>{note}"
        f"<p>{e(artifact.title)} ({kind}) is attached as a PDF.</p>"
        f"<table>{rows}</table></div>"
    )


def teams_card(artifact: Artifact, message: str, link: str | None) -> dict:
    body: list[dict] = [{"type": "TextBlock", "text": artifact.title, "weight": "Bolder", "size": "Large", "wrap": True}]
    if message:
        body.append({"type": "TextBlock", "text": message, "wrap": True})
    facts = summarize(artifact)
    if facts:
        body.append({"type": "FactSet", "facts": [{"title": k, "value": v} for k, v in facts]})
    card: dict = {"type": "AdaptiveCard", "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                  "version": "1.4", "body": body}
    if link:
        card["actions"] = [{"type": "Action.OpenUrl", "title": "Open report", "url": link}]
    return {"type": "message", "attachments": [
        {"contentType": "application/vnd.microsoft.card.adaptive", "content": card}]}


class ShareLog:
    """In-memory audit trail of shares (feeds governance views); resets on restart."""

    def __init__(self) -> None:
        self._items: list[dict] = []
        self._lock = threading.Lock()

    def add(self, **entry: Any) -> dict:
        record = {"id": f"share_{uuid.uuid4().hex[:12]}",
                  "at": datetime.now(timezone.utc).isoformat(timespec="seconds"), **entry}
        with self._lock:
            self._items.append(record)
            del self._items[:-200]
        return record

    def recent(self, limit: int = 50) -> list[dict]:
        with self._lock:
            return list(reversed(self._items[-limit:]))


def _mock_deliver(req: ShareIn, pdf: bytes | None) -> dict:
    name = file_name(req.artifact)
    tenant = "contoso"
    if req.channel == "email":
        if not req.recipients:
            raise ShareError("Add at least one recipient")
        return {"summary": f"Emailed to {', '.join(req.recipients)}", "url": None}
    if req.channel == "teams":
        return {"summary": "Posted to the Teams channel", "url": None}
    host = f"https://{tenant}.sharepoint.com/sites/analytics/Shared%20Documents" if req.channel == "sharepoint" \
        else f"https://{tenant}-my.sharepoint.com/personal/you/Documents"
    return {"summary": f"Saved {name} to {CHANNEL_LABELS[req.channel]}", "url": f"{host}/Foundry%20Analyst/{quote(name)}"}


class GraphDelivery:
    def __init__(self, cfg: Settings, client: httpx.Client | None = None, token_provider=None):
        self.cfg = cfg
        self.client = client or httpx.Client(timeout=30)
        self._token_provider = token_provider

    def _token(self) -> str:
        if self._token_provider:
            return self._token_provider()
        from azure.identity import DefaultAzureCredential

        return DefaultAzureCredential().get_token("https://graph.microsoft.com/.default").token

    def _graph(self, method: str, path: str, **kwargs) -> httpx.Response:
        headers = {"Authorization": f"Bearer {self._token()}", **kwargs.pop("headers", {})}
        resp = self.client.request(method, f"{GRAPH}{path}", headers=headers, **kwargs)
        if resp.status_code >= 400:
            log.error("Graph %s %s failed: %s %s", method, path, resp.status_code, resp.text[:500])
            raise ShareError(f"Microsoft Graph rejected the request ({resp.status_code})", 502)
        return resp

    def deliver(self, req: ShareIn, pdf: bytes | None) -> dict:
        if req.channel == "teams":
            return self._teams(req)
        if req.channel == "email":
            return self._email(req, pdf)
        return self._upload(req, pdf)

    def _teams(self, req: ShareIn) -> dict:
        resp = self.client.post(self.cfg.teams_webhook_url, json=teams_card(req.artifact, req.message, None))
        if resp.status_code >= 400:
            log.error("Teams webhook failed: %s %s", resp.status_code, resp.text[:300])
            raise ShareError(f"Teams rejected the message ({resp.status_code})", 502)
        return {"summary": "Posted to the Teams channel", "url": None}

    def _email(self, req: ShareIn, pdf: bytes | None) -> dict:
        if not req.recipients:
            raise ShareError("Add at least one recipient")
        message: dict[str, Any] = {
            "subject": req.artifact.title,
            "body": {"contentType": "HTML", "content": render_email_html(req.artifact, req.message)},
            "toRecipients": [{"emailAddress": {"address": r}} for r in req.recipients],
        }
        if pdf:
            message["attachments"] = [{
                "@odata.type": "#microsoft.graph.fileAttachment", "name": file_name(req.artifact),
                "contentType": "application/pdf", "contentBytes": base64.b64encode(pdf).decode(),
            }]
        self._graph("POST", f"/users/{quote(self.cfg.graph_sender)}/sendMail",
                    json={"message": message, "saveToSentItems": True})
        return {"summary": f"Emailed to {', '.join(req.recipients)}", "url": None}

    def _upload(self, req: ShareIn, pdf: bytes | None) -> dict:
        if not pdf:
            raise ShareError("A PDF is required to save to SharePoint or OneDrive")
        drive = f"/drives/{quote(self.cfg.sharepoint_drive_id)}" if req.channel == "sharepoint" \
            else f"/users/{quote(self.cfg.onedrive_user)}/drive"
        folder = quote(self.cfg.sharepoint_folder.strip("/"))
        item = self._graph("PUT", f"{drive}/root:/{folder}/{quote(file_name(req.artifact))}:/content",
                           content=pdf, headers={"Content-Type": "application/pdf"}).json()
        url = item.get("webUrl")
        try:
            link = self._graph("POST", f"{drive}/items/{item['id']}/createLink",
                               json={"type": "view", "scope": "organization"}).json()
            url = link.get("link", {}).get("webUrl") or url
        except ShareError:
            log.warning("Could not create a sharing link; falling back to the item URL")
        return {"summary": f"Saved {file_name(req.artifact)} to {CHANNEL_LABELS[req.channel]}", "url": url}


def precheck(req: ShareIn, cfg: Settings) -> bytes | None:
    """Validate channel, recipients and attachment; returns the decoded PDF."""
    if req.channel not in available_channels(cfg):
        raise ShareError(f"{CHANNEL_LABELS[req.channel]} sharing is not configured", 400)
    if req.channel == "email" and not req.recipients:
        raise ShareError("Add at least one recipient")
    if req.channel == "email" and cfg.share_allowed_email_domains:
        blocked = [r for r in req.recipients if r.rsplit("@", 1)[1].lower() not in cfg.share_allowed_email_domains]
        if blocked:
            raise ShareError(f"Recipients outside allowed domains: {', '.join(blocked)}", 403)
    pdf = decode_pdf(req.pdf_base64)
    if req.channel in ("sharepoint", "onedrive") and cfg.effective_share_mode != "mock" and not pdf:
        raise ShareError("A PDF is required to save to SharePoint or OneDrive")
    return pdf


def share(req: ShareIn, cfg: Settings, log_store: ShareLog, graph: GraphDelivery | None = None,
          actor: str = "system") -> dict:
    pdf = precheck(req, cfg)
    simulated = cfg.effective_share_mode == "mock"
    result = _mock_deliver(req, pdf) if simulated else (graph or GraphDelivery(cfg)).deliver(req, pdf)
    record = log_store.add(
        artifact_id=req.artifact.artifact_id, title=req.artifact.title, channel=req.channel,
        recipients=req.recipients, simulated=simulated, actor=actor, **result,
    )
    return {**record, "channel_label": CHANNEL_LABELS[req.channel]}
