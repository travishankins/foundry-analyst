import json

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.artifact_schema import parse_artifact
from app.mock_stream import _dashboard, _report

VALID = {
    "artifact_id": "sales-dash",
    "title": "Sales",
    "kind": "dashboard",
    "blocks": [
        {"type": "grid", "columns": 2, "blocks": [
            {"type": "kpi", "label": "Revenue", "value": "$1M", "trend": "up"},
            {"type": "markdown", "content": "hi"},
        ]},
        {"type": "chart", "title": "T", "chart_type": "bar", "x_key": "m",
         "series": [{"key": "v"}], "data": [{"m": "Jan", "v": 1}]},
        {"type": "table", "columns": ["a"], "rows": [[1]]},
    ],
}


def test_parses_plain_json():
    assert parse_artifact(json.dumps(VALID)).artifact_id == "sales-dash"


def test_parses_fenced_json_with_prose():
    art = parse_artifact(f"Here you go:\n```json\n{json.dumps(VALID)}\n```\nDone.")
    assert art.blocks[0].type == "grid"


@pytest.mark.parametrize("mutate", [
    lambda a: a["blocks"].append({"type": "script", "src": "x"}),
    lambda a: a.update(artifact_id="Bad ID!"),
    lambda a: a["blocks"][1].update(chart_type="radar"),
    lambda a: a.update(blocks=[]),
])
def test_rejects_invalid(mutate):
    bad = json.loads(json.dumps(VALID))
    mutate(bad)
    with pytest.raises(ValidationError):
        parse_artifact(json.dumps(bad))


def test_rejects_non_json():
    with pytest.raises(ValueError):
        parse_artifact("no artifact here")


def test_mock_specs_are_valid():
    parse_artifact(json.dumps(_dashboard("line", True)))
    parse_artifact(json.dumps(_report()))


@pytest.fixture
def client(monkeypatch):
    from app import main
    from app.settings import Settings

    monkeypatch.setattr(main, "settings", Settings(mock_agents=True))
    with TestClient(main.app) as c:
        yield c


def _events(resp):
    return [json.loads(line[6:]) for line in resp.text.splitlines() if line.startswith("data: ")]


def test_mock_stream_emits_artifact(client, monkeypatch):
    monkeypatch.setattr("app.mock_stream.time.sleep", lambda _: None)
    thread_id = client.post("/api/threads").json()["thread_id"]
    resp = client.post(f"/api/threads/{thread_id}/messages", json={"content": "Build a sales dashboard"})
    events = _events(resp)
    types = [e["type"] for e in events]
    assert "tool_call" in types and "artifact" in types and types[-1] == "done"


def test_edit_keeps_artifact_id(client, monkeypatch):
    monkeypatch.setattr("app.mock_stream.time.sleep", lambda _: None)
    resp = client.post("/api/threads/thread_abc/messages",
                       json={"content": "make it a line chart", "artifact_context": {"artifact_id": "my-dash"}})
    art = next(e for e in _events(resp) if e["type"] == "artifact")["artifact"]
    assert art["artifact_id"] == "my-dash"


def test_rejects_bad_thread_id(client):
    assert client.post("/api/threads/../x/messages", json={"content": "hi"}).status_code in (400, 404)
    assert client.post("/api/threads/abc/messages", json={"content": "hi"}).status_code == 400
