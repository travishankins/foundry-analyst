from pathlib import Path

from .audit import new_id, now_iso
from .auth import User
from .errors import UserFacingError
from .jsonstore import JsonStore


class LibraryStore:
    """Artifacts published for everyone who can sign in to see."""

    def __init__(self, path: Path | None = None):
        self._s = JsonStore(path, {})

    @staticmethod
    def _meta(entry: dict) -> dict:
        return {k: v for k, v in entry.items() if k != "artifact"}

    def publish(self, user: User, artifact: dict, note: str = "") -> dict:
        with self._s.lock:
            existing = next((e for e in self._s.data.values()
                             if e["owner"]["id"] == user.id and e["artifact_id"] == artifact["artifact_id"]), None)
            entry = existing or {"id": new_id("lib"), "artifact_id": artifact["artifact_id"],
                                 "owner": {"id": user.id, "name": user.name}, "version": 0}
            entry.update(title=artifact["title"], kind=artifact["kind"], note=note, artifact=artifact,
                         version=entry["version"] + 1, published_at=now_iso())
            self._s.data[entry["id"]] = entry
            self._s.save()
            return self._meta(entry)

    def list(self) -> list[dict]:
        with self._s.lock:
            items = [self._meta(e) for e in self._s.data.values()]
        return sorted(items, key=lambda e: e["published_at"], reverse=True)

    def get(self, library_id: str) -> dict | None:
        with self._s.lock:
            return self._s.data.get(library_id)

    def remove(self, library_id: str, user: User) -> None:
        with self._s.lock:
            entry = self._s.data.get(library_id)
            if not entry:
                raise UserFacingError("Not found", 404)
            if entry["owner"]["id"] != user.id and "Admin" not in user.roles:
                raise UserFacingError("Only the publisher or an admin can unpublish this", 403)
            del self._s.data[library_id]
            self._s.save()
