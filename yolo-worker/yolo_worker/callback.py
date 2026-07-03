"""
Detection callback — build + POST the per-frame payload.

`build_payload` is pure (unit-tested). `post_json` uses only the stdlib
(urllib) so the worker has no hard `requests` dependency; it returns the HTTP
status and never raises on a network error (the runner logs + continues).
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any


def build_payload(
    app: str,
    room: str,
    ts: float,
    detections: list[dict[str, Any]],
) -> dict[str, Any]:
    """Assemble the callback body.

    Shape (per the plugin contract):
      { "app", "room", "ts" (unix seconds, float),
        "detections": [ { "class": str, "conf": float, "bbox": [x1,y1,x2,y2] } ] }
    """
    return {
        "app": app,
        "room": room,
        "ts": ts,
        "detections": detections,
    }


def post_json(
    url: str,
    payload: dict[str, Any],
    timeout: float = 5.0,
    opener=urllib.request.urlopen,
) -> int:
    """POST `payload` as JSON. Returns the HTTP status (0 on transport error).

    `opener` is injectable so tests never touch the network.
    """
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "User-Agent": "streamhub-yolo-worker/1.0",
        },
    )
    try:
        with opener(req, timeout=timeout) as resp:
            return int(getattr(resp, "status", 0) or getattr(resp, "code", 0) or 0)
    except urllib.error.HTTPError as e:  # 4xx/5xx still reached the server
        return int(e.code)
    except (urllib.error.URLError, OSError, ValueError):
        return 0
