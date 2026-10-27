import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def app_env(monkeypatch):
    """Builds the app with fresh in-memory stores and the given settings overrides (mock agents + mock auth)."""
    from app import main
    from app.settings import Settings
    from app.stores import Stores

    def build(**overrides):
        monkeypatch.setattr(main, "settings", Settings(mock_agents=True, **overrides))
        monkeypatch.setattr(main, "stores", Stores(None))
        monkeypatch.setattr(main.time, "sleep", lambda _: None)
        return main

    return build


@pytest.fixture
def client(app_env):
    main = app_env()
    with TestClient(main.app, headers={"X-Demo-User": "alice"}) as c:
        yield c


def as_user(user: str) -> dict:
    return {"X-Demo-User": user}
