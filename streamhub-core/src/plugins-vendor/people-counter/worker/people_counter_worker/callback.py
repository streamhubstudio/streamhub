"""
Event + live-data delivery — build, SIGN and POST payloads.

Two delivery paths, both stdlib-only (urllib + hmac, no requests):

  1. `post_event` — signed count events (`count.in`, `count.out`,
     `occupancy.limit`) to the operator-configured callback URL. The envelope
     and signature MIRROR the core CallbacksService webhook convention
     (streamhub-core/src/modules/callbacks/callbacks.service.ts):
     body `{id, event, app, room, ts, timestamp, data}`, headers
     `X-StreamHub-Event` / `-Delivery` / `-Timestamp` and, when a secret is
     configured, `X-StreamHub-Signature: sha256=<hex>` = HMAC-SHA256(secret,
     body). A consumer that already verifies StreamHub app callbacks verifies
     these identically — and because the worker signs them itself, delivery
     works unchanged on a remote edge/GRID node (no origin round-trip).

  2. `post_live` — the latest counters snapshot to the framework live-data
     channel (STREAMHUB_INGEST_URL + X-Plugin-Ingest-Token), same mechanism as
     the deface worker.

All pure builders are unit-tested; posters return the HTTP status and never
raise on network errors (the runner logs + continues).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from typing import Any

USER_AGENT = "streamhub-people-counter-worker/1.0"


def iso_ts(unix_ts: float) -> str:
    """Unix seconds → ISO-8601 UTC (matches the core's envelope `ts`)."""
    return (
        datetime.fromtimestamp(float(unix_ts), tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def build_envelope(
    app: str,
    room: str,
    event: str,
    data: dict[str, Any],
    ts: float,
    delivery_id: str | None = None,
) -> dict[str, Any]:
    """Assemble the callback envelope, shaped like the core's CallbackEnvelope
    (`{id, event, app, room, ts, timestamp, data}`) so consumers handle plugin
    events and core app callbacks with one code path."""
    when = iso_ts(ts)
    return {
        "id": delivery_id or str(uuid.uuid4()),
        "event": event,
        "app": app,
        "room": room or None,
        "ts": when,
        "timestamp": when,
        "data": data,
    }


def sign_body(secret: str, body: bytes) -> str:
    """`sha256=<hex>` HMAC-SHA256 signature, same format the core callbacks
    service emits in X-StreamHub-Signature."""
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def post_event(
    url: str,
    envelope: dict[str, Any],
    secret: str = "",
    timeout: float = 5.0,
    opener=urllib.request.urlopen,
) -> int:
    """POST one signed event envelope. Returns HTTP status (0 on transport
    error). `opener` is injectable so tests never touch the network."""
    body = json.dumps(envelope).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-StreamHub-Event": str(envelope.get("event", "")),
        "X-StreamHub-Delivery": str(envelope.get("id", "")),
        "X-StreamHub-Timestamp": str(envelope.get("timestamp", "")),
    }
    if secret:
        headers["X-StreamHub-Signature"] = sign_body(secret, body)
    req = urllib.request.Request(url, data=body, method="POST", headers=headers)
    try:
        with opener(req, timeout=timeout) as resp:
            return int(getattr(resp, "status", 0) or getattr(resp, "code", 0) or 0)
    except urllib.error.HTTPError as e:  # 4xx/5xx still reached the server
        return int(e.code)
    except (urllib.error.URLError, OSError, ValueError):
        return 0


def build_live_payload(
    app: str,
    room: str,
    ts: float,
    total_in: int,
    total_out: int,
    occupancy: int,
    capacity: int,
    tracking: int,
) -> dict[str, Any]:
    """Latest-counters snapshot for the framework live-data channel."""
    return {
        "app": app,
        "room": room,
        "ts": ts,
        "in": int(total_in),
        "out": int(total_out),
        "occupancy": int(occupancy),
        "capacity": int(capacity),
        "tracking": int(tracking),
    }


def post_live(
    url: str,
    payload: dict[str, Any],
    token: str = "",
    timeout: float = 5.0,
    opener=urllib.request.urlopen,
) -> int:
    """POST the live snapshot to the framework ingest channel (deface-style:
    the per-start token rides X-Plugin-Ingest-Token). Never raises."""
    body = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
    }
    if token:
        headers["X-Plugin-Ingest-Token"] = token
    req = urllib.request.Request(url, data=body, method="POST", headers=headers)
    try:
        with opener(req, timeout=timeout) as resp:
            return int(getattr(resp, "status", 0) or getattr(resp, "code", 0) or 0)
    except urllib.error.HTTPError as e:
        return int(e.code)
    except (urllib.error.URLError, OSError, ValueError):
        return 0
