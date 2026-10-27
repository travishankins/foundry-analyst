"""Authentication and role-based access. Entra ID bearer tokens in production; demo personas in mock mode."""

import logging
from collections.abc import Mapping
from dataclasses import dataclass

import jwt
from jwt import PyJWKClient

from .errors import UserFacingError
from .settings import Settings

log = logging.getLogger("uvicorn.error")

ROLES = ("Viewer", "Analyst", "Approver", "Admin")

# Permission -> roles allowed. Entra app roles with these exact names are assigned in the app registration.
PERMISSIONS: dict[str, frozenset[str]] = {
    "library_read": frozenset(ROLES),
    "chat": frozenset({"Analyst", "Admin"}),
    "publish": frozenset({"Analyst", "Admin"}),
    "share": frozenset({"Analyst", "Admin"}),
    "incident_create": frozenset({"Analyst", "Admin"}),
    "operations_read": frozenset({"Analyst", "Approver", "Admin"}),
    "decide": frozenset({"Approver", "Admin"}),
    "audit_read": frozenset({"Approver", "Admin"}),
}


@dataclass(frozen=True)
class User:
    id: str
    name: str
    roles: frozenset[str]

    def can(self, permission: str) -> bool:
        return bool(self.roles & PERMISSIONS[permission])

    def public(self) -> dict:
        return {"id": self.id, "name": self.name, "roles": sorted(self.roles),
                "permissions": sorted(p for p in PERMISSIONS if self.can(p))}


class AuthError(UserFacingError):
    pass


MOCK_PERSONAS = {
    "alice": User("alice", "Alice Analyst", frozenset({"Analyst"})),
    "ada": User("ada", "Ada Approver", frozenset({"Analyst", "Approver"})),
    "victor": User("victor", "Victor Viewer", frozenset({"Viewer"})),
    "root": User("root", "Rae Admin", frozenset({"Admin"})),
}

_jwks_clients: dict[str, PyJWKClient] = {}


def _jwks(tenant: str) -> PyJWKClient:
    if tenant not in _jwks_clients:
        _jwks_clients[tenant] = PyJWKClient(
            f"https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys", cache_keys=True)
    return _jwks_clients[tenant]


def validate_entra_token(token: str, cfg: Settings, jwks_client: PyJWKClient | None = None) -> User:
    tenant, client = cfg.entra_tenant_id, cfg.entra_client_id
    if not (tenant and client):
        raise AuthError("Server is missing ENTRA_TENANT_ID / ENTRA_CLIENT_ID", 500)
    try:
        key = (jwks_client or _jwks(tenant)).get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token, key, algorithms=["RS256"],
            audience=[client, f"api://{client}"],
            issuer=[f"https://login.microsoftonline.com/{tenant}/v2.0", f"https://sts.windows.net/{tenant}/"],
            options={"require": ["exp", "iss", "aud"]},
        )
    except jwt.PyJWTError as exc:
        log.warning("Rejected bearer token: %s", exc)
        raise AuthError("Invalid or expired sign-in. Please sign in again.", 401) from exc
    roles = frozenset(r for r in claims.get("roles", []) if r in ROLES)
    if not roles:
        raise AuthError("Your account has no role for this application. Ask an administrator for access.", 403)
    uid = claims.get("oid") or claims.get("sub")
    if not uid:
        raise AuthError("Token has no user identifier", 401)
    return User(uid, claims.get("name") or claims.get("preferred_username") or uid, roles)


def authenticate(headers: Mapping[str, str], cfg: Settings, jwks_client: PyJWKClient | None = None) -> User:
    if cfg.effective_auth_mode == "mock":
        persona = MOCK_PERSONAS.get(headers.get("x-demo-user", ""))
        if not persona:
            raise AuthError("Choose a demo user to continue", 401)
        return persona
    scheme, _, token = headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise AuthError("Sign in required", 401)
    return validate_entra_token(token, cfg, jwks_client)


def client_config(cfg: Settings) -> dict:
    if cfg.effective_auth_mode == "mock":
        return {"mode": "mock", "personas": [p.public() for p in MOCK_PERSONAS.values()]}
    return {"mode": "entra", "tenantId": cfg.entra_tenant_id, "clientId": cfg.entra_client_id,
            "scope": f"api://{cfg.entra_client_id}/access_as_user"}
