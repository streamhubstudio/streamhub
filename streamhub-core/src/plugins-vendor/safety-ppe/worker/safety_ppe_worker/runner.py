"""
Runner — wires stream reader, detector, association, tracker, store, evidence
and callback together; logs structured JSON lines to stdout (the core
worker-hook mirrors these into the plugin logs UI — the dashboard tab builds
its violations table from the `violation` lines).

The heavy pieces (reader/detector/snapshot writer) are injectable so the loop
itself is tested without onnxruntime/OpenCV, but the default `run(config)`
builds the real ones.
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import sys
import time
from typing import Any, Callable, Iterable

from .association import analyze_frame
from .callback import build_event, post_json
from .config import Config
from .evidence import snapshot_relpath
from .schedule import in_schedule
from .tracker import ViolationTracker


def log(event: str, **fields: Any) -> None:
    """Emit one structured JSON log line to stdout."""
    rec = {"ts": round(time.time(), 3), "event": event, **fields}
    sys.stdout.write(json.dumps(rec, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def run_loop(
    config: Config,
    frames: Iterable[Any],
    detect: Callable[[Any], list[dict[str, Any]]],
    post: Callable[..., int] = post_json,
    store: Any = None,
    save: Callable[[Any, str], bool] | None = None,
    now: Callable[[], float] = time.time,
    localtime: Callable[[], _dt.datetime] = _dt.datetime.now,
    emit: Callable[..., None] = log,
) -> dict[str, int]:
    """Core loop: analyze each sampled frame, fire sustained violations.

    Per frame: schedule gate → detect → per-zone association → tracker update.
    A fired violation writes the evidence snapshot (`save`), persists the row
    (`store`) and — when a callback URL is configured — POSTs the signed
    `ppe.violation` event. Every side effect is best-effort: one failing sink
    never blocks the others or the loop.

    To keep the 500-line log ring useful, a `zones` status line is emitted only
    when the offender signature changes; `violation` lines are always emitted.

    Returns a small stats dict (handy for tests + a final summary log).
    """
    stats = {
        "frames": 0,
        "analyzed": 0,
        "off_schedule": 0,
        "violations": 0,
        "posts": 0,
        "post_errors": 0,
    }
    tracker = ViolationTracker(config.sustain_frames, config.cooldown_seconds)
    require = config.require()
    was_active: bool | None = None
    prev_sig: tuple | None = None

    for frame in frames:
        stats["frames"] += 1
        active = in_schedule(localtime(), config.work_hours, config.work_days)
        if active != was_active:
            emit("schedule", room=config.room, active=active)
            was_active = active
        if not active:
            tracker.reset()
            prev_sig = None
            stats["off_schedule"] += 1
            continue

        dets = detect(frame)
        stats["analyzed"] += 1
        report = analyze_frame(dets, config.zones, require, config.assoc_threshold)

        sig = tuple(
            (name, entry["persons"], tuple(sorted(entry["missing"])))
            for name, entry in sorted(report.items())
        )
        if sig != prev_sig:
            emit(
                "zones",
                room=config.room,
                zones={
                    name: {
                        "persons": entry["persons"],
                        "missing": sorted(entry["missing"]),
                    }
                    for name, entry in report.items()
                },
            )
            prev_sig = sig

        ts = now()
        for zone_name, entry in report.items():
            event = tracker.update(
                zone_name, entry["missing"], entry["confidence"], ts
            )
            if not event:
                continue
            stats["violations"] += 1

            snapshot_path = ""
            if save is not None and config.evidence_dir:
                snapshot_path = os.path.join(
                    config.evidence_dir,
                    snapshot_relpath(
                        ts, config.app, config.room, zone_name, event["missing"]
                    ),
                )
                if not save(frame, snapshot_path):
                    emit("snapshot_error", room=config.room, path=snapshot_path)
                    snapshot_path = ""

            if store is not None:
                try:
                    store.insert(
                        ts,
                        config.app,
                        config.room,
                        zone_name,
                        event["missing"],
                        event["confidence"],
                        snapshot_path,
                    )
                except Exception as exc:  # noqa: BLE001 - store must not kill the loop
                    emit("store_error", room=config.room, message=str(exc))

            if config.callback_url:
                payload = build_event(
                    config.app,
                    config.room,
                    zone_name,
                    event["missing"],
                    event["confidence"],
                    snapshot_path,
                    ts,
                )
                status = post(
                    config.callback_url, payload, secret=config.callback_secret
                )
                stats["posts"] += 1
                if not (200 <= status < 300):
                    stats["post_errors"] += 1
                    emit("callback_error", room=config.room, status=status)

            emit(
                "violation",
                room=config.room,
                zone=zone_name,
                missing=event["missing"],
                confidence=event["confidence"],
                snapshot=snapshot_path,
            )
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
                "no HLS source resolvable (set SAFETY_PPE_HLS_DIR or "
                "SAFETY_PPE_PUBLIC_BASE)"
            ),
        )
        return 2

    log(
        "start",
        app=config.app,
        room=config.room,
        require=config.require(),
        zones=[{"name": z.name, "rect": list(z.rect)} for z in config.zones],
        confidence=config.confidence,
        fps=config.fps,
        sustain_frames=config.sustain_frames,
        cooldown_seconds=config.cooldown_seconds,
        execution_provider=config.execution_provider,
        source=source,
    )
    if config.execution_provider == "cpu":
        log(
            "note",
            message=(
                "running on CPU — the shipped YOLOv8m model costs roughly a "
                "second of one core per analyzed frame; keep fps at 1 (or "
                "below) per stream, or enable CUDA on a GPU host"
            ),
        )

    if reader is None:
        from .stream import HlsFrameReader

        reader = HlsFrameReader(source, config.fps)
    if detector is None:
        from .detector import PpeDetector, ensure_model

        try:
            model_path = ensure_model(config.model_dir, config.model_url)
        except Exception as exc:  # noqa: BLE001 - download/permission errors
            log("fatal", message=f"could not fetch the PPE model: {exc}")
            return 1
        log("model", path=model_path)
        detector = PpeDetector(
            model_path,
            class_names=config.class_names,
            execution_provider=config.execution_provider,
            confidence=config.confidence,
            on_note=lambda msg: log("note", message=msg),
        )

    store = None
    if config.db_path:
        from .store import ViolationStore

        try:
            store = ViolationStore(config.db_path)
        except Exception as exc:  # noqa: BLE001 - a broken DB must not stop monitoring
            log("store_error", message=f"could not open {config.db_path}: {exc}")

    from .evidence import save_snapshot

    # An injected detector may be a bare callable (tests); the real PpeDetector
    # exposes .detect(frame).
    detect = detector.detect if hasattr(detector, "detect") else detector

    try:
        stats = run_loop(
            config,
            reader.frames(),
            detect,
            store=store,
            save=save_snapshot if config.evidence_dir else None,
        )
    except KeyboardInterrupt:
        stats = {}
    except Exception as exc:  # noqa: BLE001 - report + non-zero exit
        log("fatal", message=str(exc))
        return 1
    finally:
        if store is not None:
            store.close()
    log("stop", **stats)
    return 0
