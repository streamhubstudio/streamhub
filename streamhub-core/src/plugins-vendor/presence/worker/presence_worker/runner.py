"""
Runner — wires the stream reader, person detector, zone occupancy, the
presence state machine, the SQLite store and the HTTP feeds together, logging
structured JSON lines to stdout (the core worker-hook mirrors these into the
plugin logs UI).

Delivery fan-out per emitted event:
  1. SQLite `events` table (worker-owned presence.db)
  2. POST to the core plugin-events endpoint (ingest-token auth) — the core
     wraps it into the app's SIGNED webhook callbacks + MQTT tap
  3. POST to the OPTIONAL external `callbackUrl` (raw JSON, no signature)

Plus a throttled state push to the core live-data channel (POST :id/live) that
feeds the dashboard presence panel: current per-zone occupancy, recent events
and the occupancy timeline.

The heavy pieces (reader/detector) are injectable so the loop itself is tested
without OpenCV/torch; the default `run(config)` builds the real ones.
"""
from __future__ import annotations

import json
import sys
import time
from collections import deque
from typing import Any, Callable, Iterable

from .callback import build_event_payload, build_live_payload, post_json
from .config import Config
from .monitor import PresenceMonitor
from .schedule import Schedule
from .store import PresenceStore
from .zones import count_occupancy

# Occupancy heartbeat: rows are written on count CHANGE, plus at least one row
# per zone every this-many seconds (keeps the step function anchored in time).
OCCUPANCY_HEARTBEAT_S = 60.0
# Live-data channel push cadence (the panel polls at a similar rate).
LIVE_PUSH_INTERVAL_S = 2.0
# In-memory rings pushed to the live channel (the DB keeps the full history).
RECENT_EVENTS_MAX = 30
TIMELINE_WINDOW_S = 3 * 3600.0
TIMELINE_MAX_POINTS = 500
# SQLite retention: prune rows older than this on start (and it's cheap).
RETENTION_S = 14 * 24 * 3600.0


def log(event: str, **fields: Any) -> None:
    """Emit one structured JSON log line to stdout."""
    rec = {"ts": round(time.time(), 3), "event": event, **fields}
    sys.stdout.write(json.dumps(rec, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def run_loop(
    config: Config,
    frames: Iterable[Any],
    detect: Callable[[Any], list[dict[str, Any]]],
    monitor: PresenceMonitor,
    store: PresenceStore,
    schedule: Schedule,
    post: Callable[..., int] = post_json,
    now: Callable[[], float] = time.time,
    emit: Callable[..., None] = log,
) -> dict[str, int]:
    """Core loop. Returns a small stats dict (tests + final summary log)."""
    stats = {
        "frames": 0,
        "events": 0,
        "posts": 0,
        "post_errors": 0,
        "occupancy_writes": 0,
        "live_pushes": 0,
    }
    last_counts: dict[str, int] = {}
    last_beat: dict[str, float] = {}
    last_live_push = float("-inf")

    # Seed the in-memory rings from the DB so a worker restart keeps the panel
    # timeline/history continuous. Both rings: `recent_events` newest-first
    # (events_since returns newest-first; appendleft keeps it), `timeline`
    # oldest-first (append keeps it).
    t0 = now()
    recent_events: deque[dict[str, Any]] = deque(
        store.events_since(t0 - TIMELINE_WINDOW_S, RECENT_EVENTS_MAX),
        maxlen=RECENT_EVENTS_MAX,
    )
    timeline: deque[dict[str, Any]] = deque(
        store.occupancy_since(t0 - TIMELINE_WINDOW_S, TIMELINE_MAX_POINTS),
        maxlen=TIMELINE_MAX_POINTS,
    )

    events_url = config.events_url()

    for frame in frames:
        stats["frames"] += 1
        t = now()
        boxes = detect(frame)
        counts = count_occupancy(monitor.zones, boxes)
        events = monitor.update(t, counts)

        for ev in events:
            stats["events"] += 1
            store.add_event(ev["ts"], ev["zone"], ev["event"])
            recent_events.appendleft(ev)
            body = build_event_payload(config.app, config.room, ev)
            if events_url:
                status = post(events_url, body, token=config.ingest_token)
                stats["posts"] += 1
                if not 200 <= status < 300:
                    stats["post_errors"] += 1
                    emit("event_post_error", target="core", status=status, **{
                        "type": ev["event"], "zone": ev["zone"],
                    })
            if config.callback_url:
                status = post(config.callback_url, body)
                stats["posts"] += 1
                if not 200 <= status < 300:
                    stats["post_errors"] += 1
                    emit("event_post_error", target="webhook", status=status, **{
                        "type": ev["event"], "zone": ev["zone"],
                    })
            emit(
                "presence_event",
                type=ev["event"],
                zone=ev["zone"],
                persons=counts.get(ev["zone"], 0),
            )

        # Occupancy persistence: on change + heartbeat (compact step function).
        for zone in monitor.zones:
            n = counts.get(zone.id, 0)
            if (
                last_counts.get(zone.id) != n
                or t - last_beat.get(zone.id, float("-inf")) >= OCCUPANCY_HEARTBEAT_S
            ):
                store.add_occupancy(t, zone.id, n)
                stats["occupancy_writes"] += 1
                last_beat[zone.id] = t
                timeline.append({"ts": t, "zone": zone.id, "persons": n})
            last_counts[zone.id] = n

        # Live-data channel push (throttled): the dashboard panel's feed.
        if config.ingest_url and t - last_live_push >= LIVE_PUSH_INTERVAL_S:
            payload = build_live_payload(
                room=config.room,
                ts=t,
                zones=monitor.snapshot(t),
                events=list(recent_events),
                timeline=list(timeline),
                threshold_min=config.threshold_min,
                schedule={
                    "window": config.schedule_window if schedule.enabled else "",
                    "days": config.schedule_days,
                    "tz": config.timezone,
                    "inSchedule": schedule.contains(t),
                },
            )
            status = post(config.ingest_url, payload, token=config.ingest_token)
            stats["live_pushes"] += 1
            if not 200 <= status < 300:
                stats["post_errors"] += 1
                emit("live_push_error", status=status)
            last_live_push = t

    return stats


def run(config: Config, reader=None, detector=None) -> int:
    """Build real reader/detector/store (unless injected) and run until the
    stream ends or the process is signalled. Returns a process exit code.
    """
    problems = config.validate()
    if problems:
        for p in problems:
            log("config_error", message=p)
        return 2

    source = config.stream_source()
    if not source:
        log(
            "config_error",
            message=(
                "no HLS source resolvable "
                "(set PRESENCE_HLS_DIR or PRESENCE_PUBLIC_BASE)"
            ),
        )
        return 2

    schedule = Schedule.from_strings(
        config.schedule_window, config.schedule_days, config.timezone
    )
    monitor = PresenceMonitor(
        config.zones,
        threshold_s=config.threshold_min * 60.0,
        in_schedule=schedule.contains,
        after_hours_enabled=config.after_hours,
    )

    log(
        "start",
        app=config.app,
        room=config.room,
        zones=[z.id for z in config.zones],
        model=config.model,
        device=config.device,
        confidence=config.confidence,
        fps=config.fps,
        threshold_min=config.threshold_min,
        schedule=config.schedule_window if schedule.enabled else "disabled",
        schedule_days=config.schedule_days,
        tz=config.timezone or "local",
        db=config.db_path(),
        source=source,
    )
    if config.device == "cpu":
        log(
            "note",
            message=(
                "running on CPU — yolov8n at ~2 fps is fine on 2 modern cores; "
                "higher FPS or bigger models need more cores or a CUDA GPU"
            ),
        )

    try:
        store = PresenceStore(config.db_path())
    except Exception as exc:  # noqa: BLE001 - disk/permission errors
        log("fatal", message=f"could not open presence.db: {exc}")
        return 1
    store.prune(time.time() - RETENTION_S)

    if reader is None:
        from .stream import HlsFrameReader

        reader = HlsFrameReader(source, config.fps)
    if detector is None:
        from .detector import PersonDetector

        detector = PersonDetector(config.model, config.device, config.confidence)

    detect = detector.detect if hasattr(detector, "detect") else detector

    try:
        stats = run_loop(config, reader.frames(), detect, monitor, store, schedule)
    except KeyboardInterrupt:
        stats = {}
    except Exception as exc:  # noqa: BLE001 - report + non-zero exit
        log("fatal", message=str(exc))
        store.close()
        return 1
    store.close()
    log("stop", **stats)
    return 0
