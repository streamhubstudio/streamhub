"""
Evidence snapshots — one JPEG per fired violation.

`snapshot_relpath` is pure (unit-tested): a collision-safe, filesystem-safe
path under the evidence dir. `save_snapshot` does the actual cv2 write (lazy
import, injectable in the runner so the loop tests never need OpenCV).
"""
from __future__ import annotations

import os
import re
from typing import Iterable


def _slug(value: str, fallback: str = "x") -> str:
    s = re.sub(r"[^a-z0-9-]+", "-", str(value).lower()).strip("-")
    return s or fallback


def snapshot_relpath(
    ts: float, app: str, room: str, zone: str, missing: Iterable[str]
) -> str:
    """Relative path under the evidence dir for one violation snapshot:

        <app>/<ts_ms>-<room>-<zone>-<items>.jpg

    Millisecond timestamp keeps names unique and sortable; every free-text
    part (room/zone) is slugged so a zone named "Dock / North" can't escape
    the directory or break a filesystem.
    """
    items = "-".join(_slug(m) for m in sorted(set(missing))) or "none"
    name = f"{int(round(ts * 1000))}-{_slug(room)}-{_slug(zone)}-{items}.jpg"
    return os.path.join(_slug(app, "app"), name)


def save_snapshot(frame: object, path: str) -> bool:
    """Write a BGR frame as JPEG (creates parent dirs). Returns success.

    cv2 is imported lazily; any failure returns False rather than raising —
    a full disk must not kill the monitoring loop.
    """
    try:
        import cv2  # lazy: heavy

        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        return bool(cv2.imwrite(path, frame))
    except Exception:  # noqa: BLE001 - snapshot failure is non-fatal
        return False
