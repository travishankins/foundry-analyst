"""Human-in-the-loop approvals. Nothing registered here executes until an authorized approver decides."""

import logging
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .audit import new_id, now_iso
from .auth import User
from .errors import UserFacingError
from .jsonstore import JsonStore

log = logging.getLogger("uvicorn.error")

Executor = Callable[[dict, str | None], dict]


class ApprovalError(UserFacingError):
    pass


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts)


def public(rec: dict) -> dict:
    """API view: never exposes the private execution payload."""
    return {k: v for k, v in rec.items() if k != "payload"}


class ApprovalStore:
    def __init__(self, path: Path | None = None):
        self._s = JsonStore(path, {})
        self._blobs: dict[str, str] = {}  # large attachments stay in memory only

    def create(self, kind: str, title: str, summary: str, details: dict, payload: dict, requested_by: User,
               ttl_minutes: int, blob: str | None = None, ref: str | None = None) -> dict:
        now = datetime.now(timezone.utc)
        rec = {
            "id": new_id("apr"), "kind": kind, "title": title, "summary": summary, "details": details,
            "payload": payload, "ref": ref, "status": "pending",
            "requested_by": {"id": requested_by.id, "name": requested_by.name},
            "created_at": now_iso(), "expires_at": (now + timedelta(minutes=ttl_minutes)).isoformat(timespec="seconds"),
            "decided_by": None, "decided_at": None, "comment": None, "result": None, "error": None,
        }
        with self._s.lock:
            self._s.data[rec["id"]] = rec
            if blob:
                self._blobs[rec["id"]] = blob
            self._s.save()
        return rec

    def _expire(self) -> None:
        now = datetime.now(timezone.utc)
        changed = False
        for rec in self._s.data.values():
            if rec["status"] == "pending" and _parse(rec["expires_at"]) <= now:
                rec["status"] = "expired"
                self._blobs.pop(rec["id"], None)
                changed = True
        if changed:
            self._s.save()

    def list(self, status: str | None = None) -> list[dict]:
        with self._s.lock:
            self._expire()
            items = [r for r in self._s.data.values() if status is None or r["status"] == status]
        return sorted(items, key=lambda r: r["created_at"], reverse=True)

    def get(self, approval_id: str) -> dict | None:
        with self._s.lock:
            self._expire()
            return self._s.data.get(approval_id)

    def decide(self, approval_id: str, user: User, decision: str, comment: str | None,
               execute: Executor, allow_self_approval: bool) -> dict:
        with self._s.lock:
            self._expire()
            rec = self._s.data.get(approval_id)
            if not rec:
                raise ApprovalError("Approval not found", 404)
            if rec["status"] != "pending":
                raise ApprovalError(f"This request is already {rec['status']}", 409)
            if not allow_self_approval and rec["requested_by"]["id"] == user.id:
                raise ApprovalError("You cannot approve your own request", 403)
            # Claim the request while holding the lock so concurrent clicks cannot execute it twice
            rec["status"] = "executing" if decision == "approve" else "rejected"
            rec["decided_by"] = {"id": user.id, "name": user.name}
            rec["decided_at"] = now_iso()
            rec["comment"] = comment
            blob = self._blobs.pop(approval_id, None)
            payload = rec["payload"]
            self._s.save()
        if decision == "approve":
            try:
                result, error, status = execute(payload, blob), None, "approved"
            except UserFacingError as exc:
                result, error, status = None, str(exc), "failed"
            except Exception:
                log.exception("Approved action %s failed", approval_id)
                result, error, status = None, "The approved action failed. Check the server logs.", "failed"
            with self._s.lock:
                rec.update(status=status, result=result, error=error)
                self._s.save()
        return rec
