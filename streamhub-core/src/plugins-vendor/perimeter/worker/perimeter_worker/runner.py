"""
Runner — wires stream reader, person detector, arming schedule, zone geometry,
cooldown, evidence and delivery together; logs structured JSON lines to stdout
(the core worker-hook mirrors them into the plugin logs UI).

Per sampled frame:
  1. detect persons (YOLO, lazy) → normalized boxes;
  2. evaluate the arming state (manual override / schedule, in the configured
     timezone);
  3. while ARMED, test each person's anchor point against the restricted
     zones; a hit on a zone whose per-zone COOLDOWN has elapsed fires an
     intrusion: evidence snapshot (+ optional HLS `-c copy` clip), a row in
     perimeter.db, and a `perimeter.intrusion` POST to the operator webhook;
  4. push the live STATUS (armed state, person boxes, recent alerts with
     small thumbnails) to the framework live-data channel on a heartbeat
     cadence — and immediately when an alert fires.

Everything heavy is injectable so the loop is tested without torch/cv2.
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime
from typing import Any, Callable, Iterable

from . import alerts_db
from .callback import build_event, post_json
from .config import Config
from .evidence import copy_clip, evidence_paths, make_thumb_b64, save_snapshot
from .geometry import persons_to_payload, zones_hit
from .schedule import effective_armed, resolve_tz

# Stay well under the core's 64 KiB live-payload cap (MAX_LIVE_PAYLOAD_BYTES).
MAX_STATUS_BYTES = 56 * 1024
# At most this many alerts ride the live status payload…
STATUS_ALERTS = 20
# …and only the newest few carry an inline thumbnail.
STATUS_THUMBS = 3


def log(event: str, **fields: Any) -> None:
    """Emit one structured JSON log line to stdout."""
    rec = {"ts": round(time.time(), 3), "event": event, **fields}
    sys.stdout.write(json.dumps(rec, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class ZoneCooldown:
    """Per-zone alert gate: a zone re-fires only after `seconds` since ITS
    last alert (other zones are independent), killing alert storms while a
    person stands in frame.
    """

    def __init__(self, seconds: float) -> None:
        self.seconds = max(0.0, float(seconds))
        self._last: dict[str, float] = {}

    def try_fire(self, zone_id: str, now: float) -> bool:
        last = self._last.get(zone_id)
        if last is not None and (now - last) < self.seconds:
            return False
        self._last[zone_id] = now
        return True


def build_status(
    config: Config,
    ts: float,
    armed: bool,
    persons: list[dict[str, Any]],
    alerts: list[dict[str, Any]],
    unacked: int,
    frame_b64: str = "",
) -> dict[str, Any]:
    """The live-data payload the dashboard app-tab polls. Carries `room` (the
    channel key), the effective arming state, live person boxes for the zone
    editor overlay, and the recent alert queue.
    """
    return {
        "room": config.room,
        "ts": ts,
        "armed": armed,
        "mode": config.arm_mode,
        "zones": len(config.zones),
        "persons": persons,
        "alerts": alerts,
        "unacked": unacked,
        "ackThrough": config.ack_through,
        "frame": frame_b64,
    }


def fit_status(payload: dict[str, Any], max_bytes: int = MAX_STATUS_BYTES) -> dict[str, Any]:
    """Keep the payload under the live-channel cap: drop alert thumbnails
    (oldest first), then the frame preview. Alert METADATA is never dropped.
    Pure — returns the (possibly trimmed) payload.
    """

    def size(p: dict[str, Any]) -> int:
        return len(json.dumps(p))

    if size(payload) <= max_bytes:
        return payload
    for alert in reversed(payload.get("alerts", [])):
        if alert.get("thumb"):
            alert["thumb"] = ""
            if size(payload) <= max_bytes:
                return payload
    if payload.get("frame"):
        payload["frame"] = ""
    return payload


def default_armed_fn(config: Config) -> Callable[[float], bool]:
    """unix-seconds → armed?, honoring the manual override, the daily window,
    the weekend rule and the configured timezone (see schedule.py).
    """
    tz = resolve_tz(config.timezone)

    def armed_now(t: float) -> bool:
        dt = datetime.fromtimestamp(t, tz) if tz else datetime.fromtimestamp(t)
        return effective_armed(config.arm_mode, dt, config.arm_window, config.arm_weekends)

    return armed_now


def run_loop(
    config: Config,
    frames: Iterable[Any],
    detect: Callable[[Any], list[list[float]]],
    db: Any,
    post: Callable[..., int] = post_json,
    now: Callable[[], float] = time.time,
    armed_fn: Callable[[float], bool] | None = None,
    snapshot: Callable[..., bool] = save_snapshot,
    clip: Callable[[str], bool] | None = None,
    thumb: Callable[[Any], str] | None = None,
    emit: Callable[..., None] = log,
) -> dict[str, int]:
    """Core loop (see module docstring). Returns a small stats dict."""
    stats = {
        "frames": 0,
        "persons": 0,
        "intrusions": 0,
        "event_posts": 0,
        "status_posts": 0,
        "post_errors": 0,
    }
    if armed_fn is None:
        armed_fn = default_armed_fn(config)
    cooldown = ZoneCooldown(config.cooldown)
    thumbs: dict[int, str] = {}  # alert id → base64 thumb (this run only)
    last_status = float("-inf")
    prev_armed: bool | None = None

    for frame in frames:
        stats["frames"] += 1
        t = now()
        try:
            h, w = frame.shape[:2]  # numpy at runtime; fakes in tests
        except AttributeError:
            h, w = 0, 0
        dets = detect(frame)
        persons = persons_to_payload(dets, float(w), float(h))
        stats["persons"] += len(persons)

        armed = armed_fn(t)
        if armed != prev_armed:
            emit("armed", armed=armed, mode=config.arm_mode)
            prev_armed = armed

        fired = False
        if armed and persons:
            for zone_id, conf in zones_hit(persons, config.zones, config.anchor):
                if not cooldown.try_fire(zone_id, t):
                    continue
                fired = True
                stats["intrusions"] += 1
                jpg_path, mp4_path = evidence_paths(config.data_dir, t, zone_id)
                if not snapshot(frame, jpg_path):
                    jpg_path = ""
                clip_path = mp4_path if (clip is not None and clip(mp4_path)) else ""
                alert_id = alerts_db.insert_alert(
                    db, t, zone_id, conf, jpg_path, clip_path
                )
                if thumb is not None:
                    thumbs[alert_id] = thumb(frame)
                    while len(thumbs) > STATUS_THUMBS * 2:
                        thumbs.pop(min(thumbs))
                event = build_event(
                    config.app, config.room, t, zone_id, conf, jpg_path, clip_path
                )
                status = 0
                if config.callback_url:
                    status = post(
                        config.callback_url, event, secret=config.callback_secret
                    )
                    stats["event_posts"] += 1
                    if not (200 <= status < 300):
                        stats["post_errors"] += 1
                emit(
                    "intrusion",
                    zone=zone_id,
                    confidence=conf,
                    snapshot=jpg_path,
                    clip=clip_path,
                    callback_status=status if config.callback_url else None,
                )

        if config.ingest_url and (fired or (t - last_status) >= config.status_interval):
            last_status = t
            alerts = alerts_db.recent_alerts(db, STATUS_ALERTS)
            for i, alert in enumerate(alerts):
                alert["thumb"] = thumbs.get(alert["id"], "") if i < STATUS_THUMBS else ""
            payload = fit_status(
                build_status(
                    config,
                    t,
                    armed,
                    persons,
                    alerts,
                    alerts_db.unacked_count(db),
                    frame_b64=thumb(frame) if thumb is not None else "",
                )
            )
            status = post(config.ingest_url, payload, token=config.ingest_token)
            stats["status_posts"] += 1
            if not (200 <= status < 300):
                stats["post_errors"] += 1
                emit("status_error", room=config.room, status=status)
    return stats


def run(config: Config, reader=None, detector=None) -> int:
    """Build real reader/detector (unless injected) and run until the stream
    ends or the process is signalled. Returns a process exit code.
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
            message="no HLS source resolvable (set PERIMETER_HLS_DIR or PERIMETER_PUBLIC_BASE)",
        )
        return 2

    log(
        "start",
        app=config.app,
        room=config.room,
        model=config.model,
        device=config.device,
        confidence=config.confidence,
        fps=config.fps,
        zones=[z["id"] for z in config.zones],
        arm_mode=config.arm_mode,
        arm_window=list(config.arm_window) if config.arm_window else None,
        arm_weekends=config.arm_weekends,
        timezone=config.timezone or "host-local",
        cooldown=config.cooldown,
        source=source,
    )
    if config.device == "cpu":
        log(
            "note",
            message=(
                "running on CPU — yolov8n at ~1-2 fps is the honest budget; "
                "higher FPS or bigger models need CUDA on a GPU host"
            ),
        )
    if config.timezone and resolve_tz(config.timezone) is None:
        log(
            "note",
            message=(
                f"unknown timezone '{config.timezone}' — falling back to host "
                "local time for the arming schedule"
            ),
        )

    db = alerts_db.connect(config.db_path())
    if config.ack_through > 0:
        n = alerts_db.ack_through(db, config.ack_through)
        if n:
            log("acked", through=config.ack_through, count=n)

    if reader is None:
        from .stream import HlsFrameReader

        reader = HlsFrameReader(source, config.fps)
    if detector is None:
        detector = PersonDetectorProxy(config)

    # Evidence clip only works off the LOCAL playlist (segments on disk).
    clip_fn = None
    local = config.local_playlist()
    if config.clip_seconds > 0 and local and source == local:
        clip_fn = lambda out: copy_clip(local, config.clip_seconds, out)  # noqa: E731

    detect = detector.detect if hasattr(detector, "detect") else detector
    try:
        stats = run_loop(
            config,
            reader.frames(),
            detect,
            db,
            clip=clip_fn,
            thumb=make_thumb_b64,
        )
    except KeyboardInterrupt:
        stats = {}
    except Exception as exc:  # noqa: BLE001 - report + non-zero exit
        log("fatal", message=str(exc))
        return 1
    finally:
        db.close()
    log("stop", **stats)
    return 0


class PersonDetectorProxy:
    """Deferred construction of the real detector so `run` stays importable
    without torch — the model loads on the first frame.
    """

    def __init__(self, config: Config) -> None:
        self._config = config
        self._detector = None

    def detect(self, frame: Any) -> list[list[float]]:
        if self._detector is None:
            from .detector import PersonDetector

            self._detector = PersonDetector(
                self._config.model, self._config.device, self._config.confidence
            )
        return self._detector.detect(frame)
