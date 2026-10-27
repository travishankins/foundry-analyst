import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app import auth
from conftest import as_user

TENANT, CLIENT = "tenant-1", "client-1"


def test_requires_a_user(client):
    assert client.get("/api/me", headers={"X-Demo-User": ""}).status_code == 401
    assert client.get("/api/me", headers={"X-Demo-User": "mallory"}).status_code == 401


def test_auth_config_lists_demo_personas_in_mock_mode(client):
    cfg = client.get("/api/auth/config").json()
    assert cfg["mode"] == "mock" and {p["id"] for p in cfg["personas"]} == {"alice", "ada", "victor", "root"}


@pytest.mark.parametrize("user,method,path,body,expected", [
    ("victor", "post", "/api/threads", None, 403),
    ("victor", "get", "/api/library", None, 200),
    ("victor", "get", "/api/approvals", None, 403),
    ("victor", "get", "/api/audit", None, 403),
    ("alice", "post", "/api/threads", None, 200),
    ("alice", "get", "/api/audit", None, 403),
    ("alice", "post", "/api/approvals/apr_x/decision", {"decision": "approve"}, 403),
    ("ada", "get", "/api/audit", None, 200),
    ("ada", "post", "/api/threads", None, 200),
    ("root", "get", "/api/metrics", None, 200),
])
def test_role_matrix(client, user, method, path, body, expected):
    resp = getattr(client, method)(path, headers=as_user(user), **({"json": body} if body else {}))
    assert resp.status_code == expected


def test_denied_access_is_audited(client):
    client.post("/api/threads", headers=as_user("victor"))
    entries = client.get("/api/audit?type=access_denied", headers=as_user("ada")).json()["items"]
    assert entries and entries[0]["actor"] == "Victor Viewer"


def test_threads_are_private_to_their_creator(client):
    thread = client.post("/api/threads").json()["thread_id"]
    other = client.post(f"/api/threads/{thread}/messages", json={"content": "hi"}, headers=as_user("ada"))
    assert other.status_code == 404
    assert client.post(f"/api/threads/{thread}/messages", json={"content": "hi"}).status_code == 200


# ---- Entra ID token validation ----

@pytest.fixture
def entra(app_env, monkeypatch):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    class FakeJwks:
        def get_signing_key_from_jwt(self, _token):
            return type("K", (), {"key": key.public_key()})()

    monkeypatch.setitem(auth._jwks_clients, TENANT, FakeJwks())
    main = app_env(auth_mode="entra", entra_tenant_id=TENANT, entra_client_id=CLIENT)

    def token(**overrides):
        claims = {"iss": f"https://login.microsoftonline.com/{TENANT}/v2.0", "aud": CLIENT, "exp": int(time.time()) + 600,
                  "oid": "user-1", "name": "Erin Entra", "roles": ["Analyst"], **overrides}
        claims = {k: v for k, v in claims.items() if v is not None}
        return jwt.encode(claims, key, algorithm="RS256")

    with TestClient(main.app) as c:
        yield c, token


def _bearer(t):
    return {"Authorization": f"Bearer {t}"}


def test_valid_entra_token_maps_roles(entra):
    client, token = entra
    body = client.get("/api/me", headers=_bearer(token())).json()
    assert body["name"] == "Erin Entra" and body["roles"] == ["Analyst"] and "share" in body["permissions"]
    assert client.get("/api/auth/config").json()["scope"] == f"api://{CLIENT}/access_as_user"


def test_entra_rejects_bad_tokens(entra):
    client, token = entra
    assert client.get("/api/me").status_code == 401
    assert client.get("/api/me", headers={"X-Demo-User": "root"}).status_code == 401  # demo header ignored
    assert client.get("/api/me", headers=_bearer(token(exp=int(time.time()) - 10))).status_code == 401
    assert client.get("/api/me", headers=_bearer(token(aud="someone-else"))).status_code == 401
    assert client.get("/api/me", headers=_bearer(token(iss="https://evil.example/"))).status_code == 401
    assert client.get("/api/me", headers=_bearer("not.a.jwt")).status_code == 401


def test_entra_token_without_a_known_role_is_forbidden(entra):
    client, token = entra
    assert client.get("/api/me", headers=_bearer(token(roles=None))).status_code == 403
    assert client.get("/api/me", headers=_bearer(token(roles=["Hacker"]))).status_code == 403


def test_entra_token_signed_with_a_different_key_is_rejected(entra):
    client, _ = entra
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    forged = jwt.encode({"iss": f"https://login.microsoftonline.com/{TENANT}/v2.0", "aud": CLIENT,
                         "exp": int(time.time()) + 600, "roles": ["Admin"], "oid": "x"}, other, algorithm="RS256")
    assert client.get("/api/me", headers=_bearer(forged)).status_code == 401
