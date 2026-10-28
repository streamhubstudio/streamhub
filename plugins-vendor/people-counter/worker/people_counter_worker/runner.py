"""
Runner — wires the stream reader, person tracker, line-crossing counter,
SQLite store and the two delivery paths together, logging structured JSON
lines to stdout (the core worker-hook mirrors them into the plugin logs UI —
the dashboard tab reads its live counters from the `counters` lines).

The heavy pieces (reader/tracker) are injectable so the loop itself is tested
without OpenCV/torch; the default `run(config)` builds the real ones.

Per frame:
  track → for each track feed the LineCrossingCounter →
    on a crossing: sqlite `crossings` row + signed `count.in`/`count.out`
    event to the callback URL + live snapshot + `counters` log line;
    capacity edge → signed `occupancy.limit` event.
  Every `sample_interval` seconds: sqlite `occupancy_samples` row + live
  snapshot + heartbeat `counters` log line (so the dashboard sees fresh
  numbers even when nobody crosses).
"""
from __future__ import annotations

import json
import sys
import time
from typing import Any, Callable, Iterable

from .callback import build_envelope, build_live_payload, post_event, post_live
from .config import Config
from .counter import CapacityAlert, LineCrossingCounter
from .store import CountStore

EVENT_IN = "count.in"
EVENT_OUT = "count.out"
EVENT_LIMIT = "occupancy.limit"


def log(event: str, **fields: Any) -> None:
    """Emit one structured JSON log line to stdout."""
    rec = {"ts": round(time.time(), 3), "event": event, **fields}
    sys.stdout.write(json.dumps(rec, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _counters_fields(
    config: Config, counter: LineCrossingCounter, tracking: int
) -> dict[str, Any]:
    return {
        "room": config.room,
        "in": counter.total_in,
        "out": counter.total_out,
        "occupancy": counter.occupancy,
        "capacity": config.capacity,
        "tracking": tracking,
    }


def run_loop(
    config: Config,
    frames: Iterable[Any],
    track: Callable[[Any], list[dict[str, Any]]],
    counter: LineCrossingCounter,
    alert: CapacityAlert,
    store: CountStore,
    post_event_fn: Callable[..., int] = post_event,
    post_live_fn: Callable[..., int] = post_live,
    now: Callable[[], float] = time.time,
    emit: Callable[..., None] = log,
) -> dict[str, int]:
    """Core loop. Returns a stats dict (tests + the final summary log line)."""
    stats = {
        "frames": 0,
        "in": 0,
        "out": 0,
        "events": 0,
        "event_errors": 0,
        "samples": 0,
    }
    last_sample: float | None = None
    frame_num = 0

    def deliver(event: str, data: dict[str, Any], ts: float) -> None:
        """Signed event → callback URL (when configured); count + log."""
        if not config.callback_url:
            return
        envelope = build_envelope(config.app, config.room, event, data, ts)
        status = post_event_fn(
            config.callback_url, envelope, secret=config.callback_secret
        )
        stats["events"] += 1
        if not (200 <= status < 300):
            stats["event_errors"] += 1
            emit(
                "callback_error",
                callbackEvent=event,
                status=status,
                room=config.room,
            )

    def snapshot(ts: float, tracking: int) -> None:
        """Latest counters → framework live-data channel (when injected)."""
        if not config.ingest_url:
            return
        payload = build_live_payload(
            config.app,
            config.room,
            ts,
            counter.total_in,
            counter.total_out,
            counter.occupancy,
            config.capacity,
            tracking,
        )
        post_live_fn(config.ingest_url, payload, token=config.ingest_token)

    for frame in frames:
        frame_num += 1
        stats["frames"] += 1
        tracks = track(frame)
        tracking = len(tracks)
        active_ids: list[int] = []
        crossed = False

        for t in tracks:
            active_ids.append(t["id"])
            direction = counter.check(t["id"], (t["cx"], t["cy"]), frame_num)
            if not direction:
                continue
            crossed = True
            ts = now()
            stats[direction] += 1
            store.record_crossing(ts, direction, t["id"])
            data = {
                "room": config.room,
                "direction": direction,
                "trackId": t["id"],
                "confidence": t.get("conf"),
                "in": counter.total_in,
                "out": counter.total_out,
                "occupancy": counter.occupancy,
                "capacity": config.capacity,
            }
            deliver(EVENT_IN if direction == "in" else EVENT_OUT, data, ts)
            emit("crossing", direction=direction, trackId=t["id"],
                 **_counters_fields(config, counter, tracking))
            if alert.update(counter.occupancy):
                deliver(
                    EVENT_LIMIT,
                    {
                        "room": config.room,
                        "occupancy": counter.occupancy,
                        "capacity": config.capacity,
                    },
                    ts,
                )
                emit("occupancy_limit", occupancy=counter.occupancy,
                     capacity=config.capacity, room=config.room)

        counter.cleanup(active_ids)

        t_now = now()
        due = last_sample is None or (t_now - last_sample) >= config.sample_interval
        if due:
            last_sample = t_now
            stats["samples"] += 1
            store.record_occupancy(t_now, counter.occupancy)
            emit("counters", **_counters_fields(config, counter, tracking))
        if crossed or due:
            snapshot(t_now, tracking)

    return stats


def run(config: Config, reader=None, tracker=None, store=None) -> int:
    """Build the real reader/tracker/store (unless injected) and run until the
    stream ends or the process is signalled. Returns a process exit code."""
    problems = config.validate()
    if problems:
        for p in problems:
            log("config_error", message=p)
        return 2

    source = config.stream_source()
    if not source:
        log(
            "config_error",
            message="no HLS source resolvable (set PC_HLS_DIR or PC_PUBLIC_BASE)",
        )
        return 2

    (ax, ay), (bx, by) = config.line_points()
    log(
        "start",
        app=config.app,
        room=config.room,
        model=config.model,
        device=config.device,
        confidence=config.confidence,
        fps=config.fps,
        line=[ax, ay, bx, by],
        inDirection=config.in_side,
        capacity=config.capacity,
        tracker=config.tracker,
        db=config.db_path,
        source=source,
    )
    if config.device == "cpu":
        log(
            "note",
            message=(
                "running on CPU — yolov8n at ~3-6 FPS and <=720p input is the "
                "realistic budget; higher FPS/resolution or bigger models need "
                "CUDA (see README 'Minimum requirements')"
            ),
        )
    if not config.callback_url:
        log("note", message="PC_CALLBACK_URL unset — count events stay local "
                            "(sqlite + logs + live channel only)")

    if reader is None:
        from .stream import HlsFrameReader

        reader = HlsFrameReader(source, config.fps)
    if tracker is None:
        from .tracking import PersonTracker

        tracker = PersonTracker(
            config.model,
            config.device,
            config.confidence,
            config.tracker,
            config.imgsz,
        )
    if store is None:
        store = CountStore(config.db_path, app=config.app, room=config.room)

    counter = LineCrossingCounter(
        *config.line_points(),
        config.in_side,
        cooldown_frames=config.cooldown_frames,
        max_jump=config.max_jump,
    )
    alert = CapacityAlert(config.capacity)

    track = tracker.track if hasattr(tracker, "track") else tracker
    try:
        stats = run_loop(config, reader.frames(), track, counter, alert, store)
    except KeyboardInterrupt:
        stats = {}
    except Exception as exc:  # noqa: BLE001 - report + non-zero exit
        log("fatal", message=str(exc))
        return 1
    finally:
        try:
            store.close()
        except Exception:  # noqa: BLE001 - never mask the real exit path
            pass
    log("stop", **stats)
    return 0
