import json
import logging
import re
import uuid
from collections.abc import Iterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .mock_stream import mock_run
from .settings import settings

log = logging.getLogger("uvicorn.error")
THREAD_ID_PATTERN = r"^thread_[A-Za-z0-9]{1,64}$"

state: dict = {}


@asynccontextmanager
async def lifespan(_: FastAPI):
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
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


class MessageIn(BaseModel):
    content: str = Field(min_length=1, max_length=8000)
    artifact_context: dict | None = None


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "mode": "mock" if settings.mock_agents else "foundry"}


@app.post("/api/threads")
def create_thread() -> dict:
    if settings.mock_agents:
        return {"thread_id": f"thread_{uuid.uuid4().hex}"}
    return {"thread_id": state["client"].threads.create().id}


def _sse(events: Iterator[dict]) -> Iterator[str]:
    try:
        for event in events:
            yield f"data: {json.dumps(event)}\n\n"
    except Exception:
        log.exception("Agent stream failed")
        yield f"data: {json.dumps({'type': 'error', 'message': 'The agent run failed. Check the server logs.'})}\n\n"
    yield f"data: {json.dumps({'type': 'done'})}\n\n"


@app.post("/api/threads/{thread_id}/messages")
def post_message(thread_id: str, body: MessageIn) -> StreamingResponse:
    if not re.fullmatch(THREAD_ID_PATTERN, thread_id):
        raise HTTPException(status_code=400, detail="Invalid thread id")
    if body.artifact_context and len(json.dumps(body.artifact_context)) > 200_000:
        raise HTTPException(status_code=413, detail="Artifact context too large")

    if settings.mock_agents:
        events = mock_run(body.content, body.artifact_context)
    else:
        from .agent_stream import OrchestratorStream

        events = OrchestratorStream(state["client"]).run(thread_id, body.content, body.artifact_context)

    return StreamingResponse(
        _sse(events),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
