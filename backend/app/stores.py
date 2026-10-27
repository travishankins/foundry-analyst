from pathlib import Path

from .audit import AuditLog
from .approvals import ApprovalStore
from .incidents import IncidentStore
from .jsonstore import JsonStore
from .library import LibraryStore
from .sharing import ShareLog


class ThreadRegistry:
    """Maps agent thread ids to the user who created them, so one user cannot post into another's thread."""

    def __init__(self, path: Path | None = None):
        self._s = JsonStore(path, {})

    def register(self, thread_id: str, user_id: str) -> None:
        with self._s.lock:
            self._s.data[thread_id] = user_id
            self._s.save()

    def owner(self, thread_id: str) -> str | None:
        with self._s.lock:
            return self._s.data.get(thread_id)


class Stores:
    def __init__(self, data_dir: str | None = None):
        base = Path(data_dir) if data_dir else None
        if base:
            base.mkdir(parents=True, exist_ok=True)

        def path(name: str) -> Path | None:
            return base / f"{name}.json" if base else None

        self.audit = AuditLog(path("audit"))
        self.approvals = ApprovalStore(path("approvals"))
        self.incidents = IncidentStore(path("incidents"))
        self.library = LibraryStore(path("library"))
        self.threads = ThreadRegistry(path("threads"))
        self.shares = ShareLog()
