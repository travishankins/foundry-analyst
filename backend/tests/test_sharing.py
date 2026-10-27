import base64
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.artifact_schema import Artifact
from app.mock_stream import _dashboard
from app.settings import Settings
from app.sharing import GraphDelivery, ShareError, ShareIn, ShareLog, available_channels, share

PDF = base64.b64encode(b"%PDF-1.4 fake").decode()
ARTIFACT = _dashboard("bar", True)


def _req(**kw):
    return ShareIn.model_validate({"artifact": ARTIFACT, "channel": "email", "recipients": ["a@contoso.com"], **kw})


@pytest.fixture
def client(app_env):
    main = app_env()
    with TestClient(main.app, headers={"X-Demo-User": "alice"}) as c:
        yield c


def test_mock_mode_offers_all_channels(client):
    body = client.get("/api/share/channels").json()
    assert body["mode"] == "mock" and set(body["channels"]) == {"teams", "sharepoint", "onedrive", "email"}


@pytest.mark.parametrize("channel", ["teams", "sharepoint", "onedrive", "email"])
def test_mock_share_is_simulated_and_logged(client, channel):
    resp = client.post("/api/share", json={"artifact": ARTIFACT, "channel": channel,
                                           "recipients": ["a@contoso.com"], "pdf_base64": PDF})
    assert resp.status_code == 200
    body = resp.json()
    assert body["simulated"] is True and body["channel"] == channel
    if channel in ("sharepoint", "onedrive"):
        assert body["url"].startswith("https://")
    assert client.get("/api/shares").json()["shares"][0]["id"] == body["id"]


@pytest.mark.parametrize("payload", [
    {"channel": "email", "recipients": ["not-an-email"]},
    {"channel": "email", "recipients": []},
    {"channel": "email", "recipients": ["a@contoso.com"], "pdf_base64": "!!!"},
    {"channel": "email", "recipients": ["a@contoso.com"], "pdf_base64": base64.b64encode(b"<html>").decode()},
    {"channel": "fax"},
])
def test_rejects_bad_input(client, payload):
    resp = client.post("/api/share", json={"artifact": ARTIFACT, **payload})
    assert resp.status_code in (400, 422)


def test_invalid_artifact_is_rejected(client):
    bad = {**ARTIFACT, "blocks": [{"type": "script"}]}
    assert client.post("/api/share", json={"artifact": bad, "channel": "teams"}).status_code == 422


def test_allowed_email_domains_are_enforced():
    cfg = Settings(mock_agents=True, share_allowed_email_domains=("contoso.com",))
    with pytest.raises(ShareError) as exc:
        share(_req(recipients=["x@evil.com"]), cfg, ShareLog())
    assert exc.value.status == 403
    share(_req(recipients=["x@CONTOSO.com"]), cfg, ShareLog())


def test_graph_mode_only_offers_configured_channels():
    cfg = Settings(share_mode="graph", teams_webhook_url="https://hook", graph_sender="bot@contoso.com")
    assert available_channels(cfg) == ["teams", "email"]
    with pytest.raises(ShareError):
        share(_req(channel="sharepoint"), cfg, ShareLog())


def _graph(handler, cfg):
    return GraphDelivery(cfg, client=httpx.Client(transport=httpx.MockTransport(handler)), token_provider=lambda: "tok")


def test_graph_email_sends_pdf_attachment():
    seen = {}

    def handler(request):
        seen["url"], seen["auth"], seen["body"] = str(request.url), request.headers["authorization"], json.loads(request.content)
        return httpx.Response(202)

    cfg = Settings(share_mode="graph", graph_sender="bot@contoso.com")
    result = share(_req(pdf_base64=PDF, message="Hi <b>team</b>"), cfg, ShareLog(), graph=_graph(handler, cfg))
    msg = seen["body"]["message"]
    assert seen["url"].endswith("/users/bot%40contoso.com/sendMail") and seen["auth"] == "Bearer tok"
    assert msg["attachments"][0]["contentType"] == "application/pdf"
    assert "&lt;b&gt;" in msg["body"]["content"] and "<b>team" not in msg["body"]["content"]
    assert result["simulated"] is False


def test_graph_sharepoint_uploads_then_links():
    calls = []

    def handler(request):
        calls.append((request.method, request.url.path))
        if request.method == "PUT":
            return httpx.Response(201, json={"id": "item1", "webUrl": "https://sp/item"})
        return httpx.Response(201, json={"link": {"webUrl": "https://sp/share"}})

    cfg = Settings(share_mode="graph", sharepoint_drive_id="drv1")
    result = share(_req(channel="sharepoint", recipients=[], pdf_base64=PDF), cfg, ShareLog(), graph=_graph(handler, cfg))
    assert calls[0][0] == "PUT" and calls[0][1].startswith("/v1.0/drives/drv1/root:/Foundry Analyst/")
    assert calls[1] == ("POST", "/v1.0/drives/drv1/items/item1/createLink")
    assert result["url"] == "https://sp/share"


def test_graph_upload_requires_pdf_and_surfaces_graph_errors():
    cfg = Settings(share_mode="graph", sharepoint_drive_id="drv1", graph_sender="bot@contoso.com")
    ok = _graph(lambda r: httpx.Response(500, text="boom"), cfg)
    with pytest.raises(ShareError, match="PDF is required"):
        share(_req(channel="sharepoint", recipients=[]), cfg, ShareLog(), graph=ok)
    with pytest.raises(ShareError) as exc:
        share(_req(), cfg, ShareLog(), graph=ok)
    assert exc.value.status == 502 and "boom" not in str(exc.value)


def test_teams_webhook_posts_adaptive_card():
    seen = {}

    def handler(request):
        seen["url"], seen["body"] = str(request.url), json.loads(request.content)
        return httpx.Response(202)

    cfg = Settings(share_mode="graph", teams_webhook_url="https://hook.example/x")
    share(_req(channel="teams", recipients=[], message="FYI"), cfg, ShareLog(), graph=_graph(handler, cfg))
    card = seen["body"]["attachments"][0]["content"]
    assert seen["url"] == "https://hook.example/x" and card["type"] == "AdaptiveCard"
    assert any(f["title"] == "Revenue (Q3)" for f in card["body"][-1]["facts"])
