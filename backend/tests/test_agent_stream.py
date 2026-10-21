import json

from azure.ai.agents.models import (
    AgentStreamEvent,
    RunStep,
    RunStepConnectedAgent,
    RunStepConnectedAgentToolCall,
    RunStepMcpToolCall,
    RunStepToolCallDetails,
)

from app.agent_stream import OrchestratorStream
from app.mock_stream import _dashboard


def _step(tool_call, status="completed"):
    return RunStep(id="step_1", status=status, type="tool_calls",
                   step_details=RunStepToolCallDetails(tool_calls=[tool_call]))


def _translate(data, edit_id=None):
    stream = OrchestratorStream(client=None)
    return list(stream._translate(None, "thread_x", AgentStreamEvent.THREAD_RUN_STEP_COMPLETED, data, edit_id))


def test_report_builder_output_becomes_artifact_event():
    spec = _dashboard("bar", False)
    tc = RunStepConnectedAgentToolCall(id="call_1", connected_agent=RunStepConnectedAgent(
        name="report_builder", arguments="{}", output=f"```json\n{json.dumps(spec)}\n```"))
    events = _translate(_step(tc))
    assert events[0]["type"] == "tool_call" and events[0]["name"] == "report_builder"
    assert events[1] == {"type": "artifact", "artifact": spec}


def test_edit_forces_artifact_id():
    tc = RunStepConnectedAgentToolCall(id="call_1", connected_agent=RunStepConnectedAgent(
        name="report_builder", output=json.dumps(_dashboard("line", True))))
    assert _translate(_step(tc), edit_id="orig-id")[1]["artifact"]["artifact_id"] == "orig-id"


def test_mcp_tool_call_is_described():
    tc = RunStepMcpToolCall(id="call_2", server_label="microsoft_learn", name="search", arguments="{}", output="ok")
    event = _translate(_step(tc))[0]
    assert event["kind"] == "mcp" and event["name"] == "microsoft_learn.search" and event["output"] == "ok"


def test_in_progress_step_does_not_emit_artifact():
    tc = RunStepConnectedAgentToolCall(id="call_1", connected_agent=RunStepConnectedAgent(name="report_builder"))
    events = _translate(_step(tc, status="in_progress"))
    assert [e["type"] for e in events] == ["tool_call"]
