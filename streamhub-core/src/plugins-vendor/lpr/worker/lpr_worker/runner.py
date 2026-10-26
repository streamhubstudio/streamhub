"""
Runner — wires the stream reader, ALPR reader, dedupe window, SQLite store,
snapshots and the three delivery channels together, logging structured JSON
lines to stdout (the core worker-hook mirrors these into the plugin logs UI).

The heavy pieces (reader/ALPR/cv2) are injectable so the loop itself is fully
tested without OpenCV/onnxruntime; the default `run(config)` builds the real
ones.

Per ACCEPTED read (normalized, above min confidence, outside the dedupe
window) the loop:
  1. matches whitelist/blacklist → events: plate.detected (always) +
     plate.allowed | plate.denied,
  2. saves a JPEG snapshot (optional) + INSERTs the read into lpr.db,
  3. POSTs each event to the framework EVENT channel (→ app signed callbacks)
     and to the operator's direct callback URL (barrier opener) when set,
  4. pushes the rolling "recent reads" ring (+ a thumbnail of the latest
     frame) to the live-data channel for the dashboard panel.
"""
from __future__ import annotations

import json
import sys
import time
from collections import deque
from typing import Any, Callable, Iterable, Optional

from .callback import (
    build_direct,
    build_event,
    build_live,
    post_json,
    read_payload,
)
from .config import Config
from .dedupe import DedupeWindow
from .plates import events_for, match_list, normalize_plate

RING_SIZE = 25


def log(event: str, **fields: Any) -> None:
    """Emit one structured JSON log line to stdout."""
    rec = {"ts": round(time.time(), 3), "event": event, **fields}
    sys.stdout.write(json.dumps(rec, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def run_loop(
    config: Config,
    frames: Iterable[Any],
    read_plates: Callable[[Any], list[dict[str, Any]]],
    post: Callable[..., int] = post_json,
    store: Any = None,
    save_snapshot: Optional[Callable[[Any, str, float], Optional[str]]] = None,
    make_thumb: Optional[Callable[[Any], str]] = None,
    now: Callable[[], float] = time.time,
    emit: Callable[..., None] = log,
    dedupe: Optional[DedupeWindow] = None,
    ring: Optional[deque] = None,
) -> dict[str, int]:
    """Core loop. Returns a small stats dict (tests + final summary log)."""
    stats = {
        "frames": 0,
        "reads": 0,
        "events": 0,
        "duplicates": 0,
        "low_confidence": 0,
        "post_errors": 0,
    }
    dedupe = dedupe or DedupeWindow(config.dedupe_sec)
    ring = ring if ring is not None else deque(maxlen=RING_SIZE)
    whitelist = set(config.whitelist)
    blacklist = set(config.blacklist)

    def deliver(url: str, payload: dict[str, Any], token: str = "") -> None:
        status = post(url, payload, token=token)
        if not (200 <= status < 300):
            stats["post_errors"] += 1
            emit("callback_error", url=url, status=status)

    # Seed the dashboard feed on (re)start so history survives restarts.
    if ring and config.ingest_url and config.room:
        deliver(
            config.ingest_url,
            build_live(config.room, now(), dict(ring[0]), list(ring)),
            token=config.ingest_token,
        )

    for frame in frames:
        stats["frames"] += 1
        for candidate in read_plates(frame) or []:
            plate = normalize_plate(candidate.get("plate"))
            if not plate:
                continue
            confidence = float(candidate.get("confidence") or 0.0)
            if confidence < config.confidence:
                stats["low_confidence"] += 1
                continue
            ts = now()
            if not dedupe.should_emit(plate, ts):
                stats["duplicates"] += 1
                continue

            list_match = match_list(plate, whitelist, blacklist)
            snapshot_path: Optional[str] = None
            if config.snapshots and save_snapshot is not None:
                snapshot_path = save_snapshot(frame, plate, ts)
            if store is not None:
                store.add(ts, plate, confidence, list_match, snapshot_path)

            payload = read_payload(plate, confidence, ts, list_match, snapshot_path)
            events = events_for(list_match)
            for event in events:
                if config.events_url:
                    deliver(
                        config.events_url,
                        build_event(event, config.room, payload),
                        token=config.ingest_token,
                    )
                if config.callback_url:
                    deliver(
                        config.callback_url,
                        build_direct(config.app, config.room, event, payload),
                    )

            ring.appendleft(dict(payload))
            if config.ingest_url and config.room:
                last = dict(payload)
                if make_thumb is not None:
                    thumb = make_thumb(frame)
                    if thumb:
                        last["thumb"] = thumb
                deliver(
                    config.ingest_url,
                    build_live(config.room, ts, last, list(ring)),
                    token=config.ingest_token,
                )

            stats["reads"] += 1
            stats["events"] += len(events)
            emit(
                "plate",
                plate=plate,
                confidence=round(confidence, 3),
                listMatch=list_match,
                events=events,
                snapshot=snapshot_path,
            )
            dedupe.prune(ts)
    return stats


def run(config: Config, reader=None, plate_reader=None) -> int:
    """Build real reader/ALPR/store (unless injected) and run until the
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
                "no stream source resolvable (set LPR_SOURCE, LPR_HLS_DIR or "
                "LPR_PUBLIC_BASE)"
            ),
        )
        return 2

    log(
        "start",
        app=config.app,
        room=config.room,
        detector=config.detector,
        ocr_model=config.ocr_model,
        device=config.device,
        confidence=config.confidence,
        fps=config.fps,
        dedupe_sec=config.dedupe_sec,
        whitelist=len(config.whitelist),
        blacklist=len(config.blacklist),
        snapshots=config.snapshots,
        source=source,
        db=config.db_path(),
    )
    if config.device == "cpu":
        log(
            "note",
            message=(
                "running on CPU — fast-alpr (YOLOv9-t + CCT OCR, ONNX) handles "
                "a few FPS per core at gate-camera resolution; keep sample FPS "
                "low (2-4) or enable CUDA on a GPU host for more"
            ),
        )

    if reader is None:
        from .stream import HlsFrameReader

        reader = HlsFrameReader(source, config.fps)
    if plate_reader is None:
        from .alpr import PlateReader

        plate_reader = PlateReader(
            config.detector,
            config.ocr_model,
            device=config.device,
            model_dir=config.model_dir,
            on_note=lambda msg: log("note", message=msg),
        )

    from .snapshot import save_snapshot as save_snap, thumb_b64
    from .store import ReadsStore

    store = ReadsStore(config.db_path())
    ring: deque = deque(store.recent(RING_SIZE), maxlen=RING_SIZE)

    read = plate_reader.read if hasattr(plate_reader, "read") else plate_reader
    snap_dir = config.snapshots_dir()

    try:
        stats = run_loop(
            config,
            reader.frames(),
            read,
            store=store,
            save_snapshot=lambda frame, plate, ts: save_snap(
                frame, plate, ts, snap_dir
            ),
            make_thumb=thumb_b64,
            ring=ring,
        )
    except KeyboardInterrupt:
        stats = {}
    except Exception as exc:  # noqa: BLE001 - report + non-zero exit
        log("fatal", message=str(exc))
        return 1
    finally:
        store.close()
    log("stop", **stats)
    return 0
