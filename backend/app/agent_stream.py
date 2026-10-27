"""Runs the orchestrator and translates Foundry stream events into the app's SSE event shape."""

import json
import logging
from collections.abc import Iterator
from typing import Any

from azure.ai.agents import AgentsClient
from azure.ai.agents.models import (
    AgentStreamEvent,
    AgentThreadCreationOptions,
    MessageDeltaChunk,
    RunStep,
    RunStepDeltaChunk,
    SubmitToolApprovalAction,
    ThreadMessageOptions,
    ThreadRun,
    ToolApproval,
)
from pydantic import ValidationError

from .artifact_schema import Artifact, parse_artifact
from .settings import settings

log = logging.getLogger("uvicorn.error")

REPORT_TOOL_NAME = "report_builder"
TERMINAL_RUN_STATUSES = {"completed", "failed", "cancelled", "expired", "incomplete"}


def _status(value: Any) -> str:
    return str(value).split(".")[-1].lower()


def _plain(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if hasattr(value, "as_dict"):
        return value.as_dict()
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_plain(v) for v in value]
    return str(value)


def _describe_tool_call(tc: Any) -> dict:
    """Normalize a run-step tool call into {id, kind, name, arguments, output}."""
    kind = getattr(tc, "type", "unknown")
    info: dict[str, Any] = {"id": getattr(tc, "id", None), "kind": kind, "name": kind, "arguments": None, "output": None}
    if kind == "connected_agent" and getattr(tc, "connected_agent", None):
        ca = tc.connected_agent
        # Agent names use hyphens (report-builder) while tool names use underscores; normalize for matching
        name = (getattr(ca, "name", None) or kind).replace("-", "_")
        info.update(name=name, arguments=getattr(ca, "arguments", None), output=getattr(ca, "output", None))
    elif kind == "mcp":
        info.update(name=f"{getattr(tc, 'server_label', 'mcp')}.{getattr(tc, 'name', '') or ''}".rstrip("."),
                    arguments=getattr(tc, "arguments", None), output=getattr(tc, "output", None))
    elif kind == "fabric_dataagent" or hasattr(tc, "microsoft_fabric"):
        info.update(name="fabric_dataagent", output=_plain(getattr(tc, "microsoft_fabric", None)))
    return info


class OrchestratorStream:
    def __init__(self, client: AgentsClient):
        self.client = client
        self._run_id: str | None = None
        self._run_finished = False

    def run(self, thread_id: str, content: str, artifact_context: dict | None) -> Iterator[dict]:
        if artifact_context:
            content = (
                f"{content}\n\nCurrent artifact (edit this, keep artifact_id "
                f"\"{artifact_context.get('artifact_id')}\"):\n```json\n{json.dumps(artifact_context)}\n```"
            )
        self.client.messages.create(thread_id=thread_id, role="user", content=content)
        edit_id = artifact_context.get("artifact_id") if artifact_context else None

        try:
            with self.client.runs.stream(thread_id=thread_id, agent_id=settings.orchestrator_agent_id) as stream:
                for event_type, data, _ in stream:
                    yield from self._translate(stream, thread_id, event_type, data, edit_id)
        finally:
            self._cancel_if_active(thread_id)

    def _cancel_if_active(self, thread_id: str) -> None:
        """Client disconnects (Stop button) close this generator; cancel so the thread accepts the next message."""
        if not self._run_id or self._run_finished:
            return
        try:
            self.client.runs.cancel(thread_id=thread_id, run_id=self._run_id)
        except Exception:
            log.warning("Could not cancel run %s", self._run_id, exc_info=True)

    def _translate(self, stream, thread_id, event_type, data, edit_id) -> Iterator[dict]:
        if isinstance(data, MessageDeltaChunk):
            if data.text:
                yield {"type": "text_delta", "text": data.text}

        elif isinstance(data, RunStepDeltaChunk):
            details = getattr(data.delta, "step_details", None)
            for tc in getattr(details, "tool_calls", None) or []:
                if getattr(tc, "id", None):
                    info = _describe_tool_call(tc)
                    yield {"type": "tool_call", "status": "in_progress", **{k: info[k] for k in ("id", "kind", "name")}}

        elif isinstance(data, RunStep):
            details = data.step_details
            if getattr(details, "type", None) != "tool_calls":
                return
            status = _status(data.status)
            for tc in details.tool_calls or []:
                info = _describe_tool_call(tc)
                yield {"type": "tool_call", "status": status, **info}
                if status == "completed" and info["name"] == REPORT_TOOL_NAME and info["output"]:
                    yield from self._artifact_event(info["output"], edit_id)

        elif isinstance(data, ThreadRun):
            status = _status(data.status)
            self._run_id = data.id
            self._run_finished = status in TERMINAL_RUN_STATUSES
            yield {"type": "run_status", "status": status, "run_id": data.id}
            if event_type == AgentStreamEvent.THREAD_RUN_REQUIRES_ACTION and isinstance(data.required_action, SubmitToolApprovalAction):
                approvals = [
                    # Only the configured read-only MCP server is auto-approved; anything else is denied
                    ToolApproval(tool_call_id=tc.id, approve=getattr(tc, "server_label", None) == settings.mcp_server_label)
                    for tc in data.required_action.submit_tool_approval.tool_calls
                ]
                self.client.runs.submit_tool_outputs_stream(
                    thread_id=thread_id, run_id=data.id, tool_approvals=approvals, event_handler=stream
                )
            elif status in {"failed", "cancelled", "expired", "incomplete"}:
                err = data.last_error
                yield {"type": "error", "message": getattr(err, "message", None) or f"Run {status}"}

        elif event_type == AgentStreamEvent.ERROR:
            yield {"type": "error", "message": str(data)}

    def _artifact_event(self, output: str, edit_id: str | None) -> Iterator[dict]:
        try:
            artifact = parse_artifact(output)
        except (ValueError, ValidationError) as exc:
            artifact = self._repair(output, str(exc))
            if artifact is None:
                yield {"type": "error", "message": "Report builder returned an invalid artifact."}
                return
        if edit_id:
            artifact.artifact_id = edit_id
        yield {"type": "artifact", "artifact": artifact.model_dump(mode="json", exclude_none=True)}

    def _repair(self, output: str, error: str) -> Artifact | None:
        if not settings.report_builder_agent_id:
            return None
        run = self.client.create_thread_and_process_run(
            agent_id=settings.report_builder_agent_id,
            thread=AgentThreadCreationOptions(messages=[ThreadMessageOptions(
                role="user",
                content=f"This artifact JSON failed validation: {error[:2000]}\nReturn a corrected artifact.\n\n{output[:100_000]}",
            )]),
        )
        if _status(run.status) != "completed":
            return None
        msg = self.client.messages.get_last_message_text_by_role(thread_id=run.thread_id, role="assistant")
        try:
            return parse_artifact(msg.text.value) if msg else None
        except (ValueError, ValidationError):
            return None
        finally:
            self.client.threads.delete(run.thread_id)
