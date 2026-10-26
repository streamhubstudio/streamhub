"""
Event/live payload delivery — build + POST JSON bodies.

`build_event_payload` / `build_live_payload` are pure (unit-tested).
`post_json` uses only the stdlib (urllib) so the worker has no hard `requests`
dependency; it returns the HTTP status and never raises on a network error
(the runner logs + continues). Same mechanism as yolo/deface workers: the
optional `token` rides the X-Plugin-Ingest-Token header the core framework
endpoints (POST :id/live and POST :id/events) authenticate with.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Mapping, Sequence


def build_event_payload(
    app: str,
    room: str,
    event: Mapping[str, Any],
) -> dict[str, Any]:
    """One presence event → the POST body.

    Shape (both for the core events endpoint, which wraps it into the app's
    SIGNED callback envelope, and for the optional external webhook):

      { "event": "presence.absent" | "presence.returned" | "presence.after_hours",
        "app", "room", "ts" (unix seconds, float),
        "zone", "zoneName",
        ...event-specific extras (persons / emptyForSec / absentForSec /
        thresholdMin) }
    """
    out: dict[str, Any] = {"app": app, "room": room}
    out.update(event)
    return out


def build_live_payload(
    room: str,
    ts: float,
    zones: Sequence[Mapping[str, Any]],
    events: Sequence[Mapping[str, Any]],
    timeline: Sequence[Mapping[str, Any]],
    threshold_min: float,
    schedule: Mapping[str, Any],
) -> dict[str, Any]:
    """The live-data channel state payload the dashboard panel polls.

    { "room", "ts", "thresholdMin", "schedule": {window, days, tz, inSchedule},
      "zones": [ per-zone monitor snapshot ],
      "events": [ recent events, newest first ],
      "timeline": [ {ts, zone, persons} occupancy change points, oldest first ] }
    """
    return {
        "room": room,
        "ts": ts,
        "thresholdMin": threshold_min,
        "schedule": dict(schedule),
        "zones": list(zones),
        "events": list(events),
        "timeline": list(timeline),
    }


def post_json(
    url: str,
    payload: Mapping[str, Any],
    token: str = "",
    timeout: float = 5.0,
    opener=urllib.request.urlopen,
) -> int:
    """POST `payload` as JSON. Returns the HTTP status (0 on transport error).

    `opener` is injectable so tests never touch the network. `token` (when
    set) rides the X-Plugin-Ingest-Token header the core framework endpoints
    require.
    """
    data = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "streamhub-presence-worker/1.0",
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
