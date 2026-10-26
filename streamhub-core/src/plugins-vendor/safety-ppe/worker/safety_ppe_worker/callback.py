"""
`ppe.violation` event callback — build + sign + POST (stdlib only).

`build_event` and `sign_body` are pure (unit-tested). `post_json` mirrors the
yolo/deface worker poster (urllib, returns HTTP status, never raises on
transport errors) with one addition: when a callback secret is configured the
body is HMAC-SHA256 signed EXACTLY like the core's app callbacks —

    X-StreamHub-Signature: sha256=<hex>
    X-StreamHub-Event:     ppe.violation

— so a receiver can verify both StreamHub-core webhooks and this worker's
posts with the same code path.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import urllib.error
import urllib.request
from typing import Any, Iterable


def build_event(
    app: str,
    room: str,
    zone: str,
    missing: Iterable[str],
    confidence: float,
    snapshot_path: str,
    ts: float,
) -> dict[str, Any]:
    """Assemble the `ppe.violation` payload.

    Shape:
      { "event": "ppe.violation", "app", "room", "ts" (unix seconds, float),
        "zone", "missing": ["helmet"|"vest", …], "confidence",
        "snapshot_path" ('' when the snapshot could not be written) }
    """
    return {
        "event": "ppe.violation",
        "app": app,
        "room": room,
        "ts": ts,
        "zone": zone,
        "missing": sorted(set(missing)),
        "confidence": round(float(confidence), 4),
        "snapshot_path": snapshot_path or "",
    }


def sign_body(secret: str, body: bytes) -> str:
    """HMAC-SHA256 signature in the core callbacks format: 'sha256=<hex>'."""
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def post_json(
    url: str,
    payload: dict[str, Any],
    token: str = "",
    secret: str = "",
    timeout: float = 5.0,
    opener=urllib.request.urlopen,
) -> int:
    """POST `payload` as JSON. Returns the HTTP status (0 on transport error).

    `opener` is injectable so tests never touch the network. `token` (when
    set) rides the X-Plugin-Ingest-Token header of the core live-data channel;
    `secret` (when set) signs the body core-callbacks-style.
    """
    data = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "streamhub-safety-ppe-worker/1.0",
    }
    event = payload.get("event")
    if isinstance(event, str) and event:
        headers["X-StreamHub-Event"] = event
    if token:
        headers["X-Plugin-Ingest-Token"] = token
    if secret:
        headers["X-StreamHub-Signature"] = sign_body(secret, data)
    req = urllib.request.Request(url, data=data, method="POST", headers=headers)
    try:
        with opener(req, timeout=timeout) as resp:
            return int(getattr(resp, "status", 0) or getattr(resp, "code", 0) or 0)
    except urllib.error.HTTPError as e:  # 4xx/5xx still reached the server
        return int(e.code)
    except (urllib.error.URLError, OSError, ValueError):
        return 0
