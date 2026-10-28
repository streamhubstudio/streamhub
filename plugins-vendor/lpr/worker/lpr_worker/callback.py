"""
Payload builders + HTTP POST — the delivery half of the worker.

Builders are PURE (unit-tested). `post_json` uses only the stdlib (urllib) so
the worker has no hard `requests` dependency; it returns the HTTP status and
never raises on a network error (the runner logs + continues). Same mechanism
as yolo/deface workers; the framework channels authenticate via the per-start
ingest token sent as `X-Plugin-Ingest-Token`.

Three payload shapes:
  - `read_payload`     one read, camelCase (rides inside events + live ring);
  - `build_event`      framework event-channel body  {event, room, data};
  - `build_direct`     flat self-describing body for the operator's own
                       callback URL (barrier opener):
                       {app, room, event, ts, plate, confidence, listMatch, snapshot};
  - `build_live`       live-data channel body {room, ts, last, recent} — the
                       dashboard panel's rolling "recent reads" feed.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Optional


def read_payload(
    plate: str,
    confidence: float,
    ts: float,
    list_match: Optional[str],
    snapshot_path: Optional[str],
) -> dict[str, Any]:
    return {
        "plate": plate,
        "confidence": round(float(confidence), 4),
        "ts": ts,
        "listMatch": list_match,
        "snapshot": snapshot_path or None,
    }


def build_event(event: str, room: str, read: dict[str, Any]) -> dict[str, Any]:
    """Framework event-channel body (POST STREAMHUB_EVENTS_URL). The core
    validates `event` against the plugin manifest's declared `events` and
    relays `data` through the app's signed callbacks."""
    return {"event": event, "room": room, "data": read}


def build_direct(
    app: str,
    room: str,
    event: str,
    read: dict[str, Any],
) -> dict[str, Any]:
    """Flat body for the operator's direct callback URL — self-describing so
    a dumb barrier webhook needs no envelope parsing."""
    return {"app": app, "room": room, "event": event, **read}


def build_live(
    room: str,
    ts: float,
    last: dict[str, Any],
    recent: list[dict[str, Any]],
) -> dict[str, Any]:
    """Live-data channel body: the latest read (optionally with a `thumb`
    base64 JPEG) + the newest-first ring the dashboard table renders."""
    return {"room": room, "ts": ts, "last": last, "recent": recent}


def post_json(
    url: str,
    payload: dict[str, Any],
    token: str = "",
    timeout: float = 5.0,
    opener=urllib.request.urlopen,
) -> int:
    """POST `payload` as JSON. Returns the HTTP status (0 on transport error).

    `opener` is injectable so tests never touch the network. `token` (when
    set) rides the X-Plugin-Ingest-Token header the core framework channels
    require.
    """
    data = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "streamhub-lpr-worker/1.0",
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
