"""Tiny thread-safe JSON persistence so demo state (library, approvals, audit) survives restarts."""

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any

log = logging.getLogger("uvicorn.error")


class JsonStore:
    def __init__(self, path: Path | None, default: Any):
        self.path = path
        self.lock = threading.RLock()
        self.data = default
        if path and path.exists():
            try:
                self.data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                log.warning("Could not read %s; starting empty", path, exc_info=True)

    def save(self) -> None:
        if not self.path:
            return
        tmp = self.path.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(self.data), encoding="utf-8")
            os.replace(tmp, self.path)
        except OSError:
            log.warning("Could not persist %s", self.path, exc_info=True)
