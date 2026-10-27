import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .jsonstore import JsonStore

MAX_ENTRIES = 2000


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class AuditLog:
    """Append-only record of who did what: agent runs, shares, approvals, events, access denials."""

    def __init__(self, path: Path | None = None):
        self._s = JsonStore(path, [])

    def record(self, actor: str, type: str, summary: str, **detail: Any) -> dict:
        entry = {"id": new_id("evt"), "at": now_iso(), "actor": actor, "type": type, "summary": summary, "detail": detail}
        with self._s.lock:
            self._s.data.append(entry)
            del self._s.data[:-MAX_ENTRIES]
            self._s.save()
        return entry

    def recent(self, type: str | None = None, limit: int = 100) -> list[dict]:
        with self._s.lock:
            items = [e for e in self._s.data if type is None or e["type"] == type]
        return list(reversed(items[-limit:]))

    def all(self) -> list[dict]:
        with self._s.lock:
            return list(self._s.data)
