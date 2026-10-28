"""
Event snapshots — JPEG frame per emitted event + a small base64 thumbnail for
the live-data feed.

`snapshot_filename` is PURE (unit-tested). The savers import cv2 lazily so
importing this module never requires OpenCV.
"""
from __future__ import annotations

import base64
import os
from typing import Any, Optional


def snapshot_filename(plate: str, ts: float) -> str:
    """Deterministic, filesystem-safe name: `<unix-ms>-<PLATE>.jpg`.

    `plate` is already normalized (A-Z0-9) so no escaping is needed; a
    defensive filter keeps the name safe even for raw input.
    """
    safe = "".join(c for c in plate if c.isalnum()) or "UNKNOWN"
    return f"{int(ts * 1000)}-{safe}.jpg"


def save_snapshot(
    frame: Any,
    plate: str,
    ts: float,
    directory: str,
    quality: int = 85,
) -> Optional[str]:
    """Write the full frame as JPEG under `directory`. Returns the absolute
    path, or None when the write failed (never raises — a missing snapshot
    must not kill the read pipeline)."""
    try:
        import cv2  # lazy: only needed at runtime

        os.makedirs(directory, exist_ok=True)
        path = os.path.join(directory, snapshot_filename(plate, ts))
        ok = cv2.imwrite(path, frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
        return path if ok else None
    except Exception:  # noqa: BLE001 - snapshot is best-effort
        return None


def thumb_b64(frame: Any, width: int = 160, quality: int = 60) -> str:
    """Small base64 JPEG of the frame (~5-10 KB) for the live-data `last`
    read. '' on any failure — the payload simply ships without a thumb."""
    try:
        import cv2  # lazy

        h, w = frame.shape[:2]
        if not w or not h:
            return ""
        scale = width / float(w)
        resized = cv2.resize(frame, (width, max(1, int(h * scale))))
        ok, buf = cv2.imencode(
            ".jpg", resized, [int(cv2.IMWRITE_JPEG_QUALITY), quality]
        )
        if not ok:
            return ""
        return base64.b64encode(buf.tobytes()).decode("ascii")
    except Exception:  # noqa: BLE001 - thumb is best-effort
        return ""
