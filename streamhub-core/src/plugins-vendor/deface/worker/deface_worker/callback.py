"""
Face-payload callback — build + POST the per-frame payload.

`build_payload` is pure (unit-tested). `post_json` uses only the stdlib
(urllib) so the worker has no hard `requests` dependency; it returns the HTTP
status and never raises on a network error (the runner logs + continues).

Same callback mechanism as yolo-worker, with two deface twists:
  - the payload carries `maskScale` so any consumer (the player overlay, an
    external hook) knows the posted boxes are ALREADY expanded — it must not
    re-expand them;
  - the framework live-data channel authenticates via the per-start ingest
    token, sent as the `X-Plugin-Ingest-Token` header.
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
    faces: list[dict[str, Any]],
    mask_scale: float,
) -> dict[str, Any]:
    """Assemble the callback body.

    Shape:
      { "app", "room", "ts" (unix seconds, float),
        "maskScale" (already applied to every bbox),
        "faces": [ { "bbox": [x, y, w, h] (normalized 0–1), "score": float } ] }

    Posted for EVERY sampled frame — an empty `faces` list is meaningful (it
    clears the overlay masks), unlike yolo which only posts hits.
    """
    return {
        "app": app,
        "room": room,
        "ts": ts,
        "maskScale": mask_scale,
        "faces": faces,
    }


def post_json(
    url: str,
    payload: dict[str, Any],
    token: str = "",
    timeout: float = 5.0,
    opener=urllib.request.urlopen,
) -> int:
    """POST `payload` as JSON. Returns the HTTP status (0 on transport error).

    `opener` is injectable so tests never touch the network. `token` (when
    set) rides the X-Plugin-Ingest-Token header the core live-data endpoint
    requires.
    """
    data = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "streamhub-deface-worker/1.0",
    }
    if token:
        headers["X-Plugin-Ingest-Token"] = token
    req = urllib.request.Request(url, data=data, method="POST", headers=headers)
    try:
        with opener(req, timeout=timeout) as resp:
            return int(getattr(resp, "status", 0) or getattr(resp, "code", 0) or 0)
    except urllib.error.HTTPError as e:  # 4xx/5xx still reached the server
        return int(e.code)
    except (urllib.error.URLError, OSError, ValueError):
        return 0
