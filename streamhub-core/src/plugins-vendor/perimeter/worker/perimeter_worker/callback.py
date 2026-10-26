"""
Delivery — intrusion events + live status, both over stdlib urllib.

Two targets, following the shipped worker patterns:
  - the OPERATOR WEBHOOK (yolo pattern): each `perimeter.intrusion` event is
    POSTed to the configured `callbackUrl`. When `callbackSecret` is set the
    body is HMAC-SHA256 signed into `X-StreamHub-Signature: sha256=<hex>` —
    the SAME header + scheme the core's signed app callbacks use, so a
    receiver can verify both with one code path.
  - the FRAMEWORK LIVE-DATA CHANNEL (deface pattern): the armed state + recent
    alerts are pushed to STREAMHUB_INGEST_URL with the per-start ingest token
    (`X-Plugin-Ingest-Token`); the dashboard app-tab polls the authenticated
    read endpoint.

`build_event`/`sign_body` are pure (unit-tested); `post_json` never raises on
network errors (the runner logs + continues).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import urllib.error
import urllib.request
from typing import Any

EVENT_INTRUSION = "perimeter.intrusion"


def build_event(
    app: str,
    room: str,
    ts: float,
    zone: str,
    confidence: float,
    snapshot: str = "",
    clip: str = "",
) -> dict[str, Any]:
    """The `perimeter.intrusion` webhook body. Paths are server-side evidence
    locations (under the app's perimeter data dir), not URLs.
    """
    return {
        "event": EVENT_INTRUSION,
        "app": app,
        "room": room,
        "ts": ts,
        "zone": zone,
        "confidence": confidence,
        "snapshot": snapshot,
        "clip": clip,
    }


def sign_body(body: bytes, secret: str) -> str:
    """HMAC-SHA256 signature in the core callbacks format: `sha256=<hex>`."""
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

    `opener` is injectable so tests never touch the network. `token` rides the
    X-Plugin-Ingest-Token header (framework live channel); `secret` signs the
    body into X-StreamHub-Signature (operator webhook).
    """
    data = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "streamhub-perimeter-worker/1.0",
    }
    if token:
        headers["X-Plugin-Ingest-Token"] = token
    if secret:
        headers["X-StreamHub-Signature"] = sign_body(data, secret)
    req = urllib.request.Request(url, data=data, method="POST", headers=headers)
    try:
        with opener(req, timeout=timeout) as resp:
            return int(getattr(resp, "status", 0) or getattr(resp, "code", 0) or 0)
    except urllib.error.HTTPError as e:  # 4xx/5xx still reached the server
        return int(e.code)
    except (urllib.error.URLError, OSError, ValueError):
        return 0
