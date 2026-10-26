"""
Runner — wires the stream reader, detector and callback together and logs
structured JSON lines to stdout (the core worker-hook mirrors these into the
plugin logs UI).

The heavy pieces (reader/detector) are injectable so the loop itself can be
tested without OpenCV/torch, but the default `run(config)` builds the real ones.
"""
from __future__ import annotations

import json
import sys
import time
from typing import Any, Callable, Iterable, Optional

from .callback import build_payload, post_json
from .config import Config


def log(event: str, **fields: Any) -> None:
    """Emit one structured JSON log line to stdout."""
    rec = {"ts": round(time.time(), 3), "event": event, **fields}
    sys.stdout.write(json.dumps(rec, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def run_loop(
    config: Config,
    frames: Iterable[Any],
    detect: Callable[[Any], list[dict[str, Any]]],
    post: Callable[[str, dict[str, Any]], int] = post_json,
    now: Callable[[], float] = time.time,
) -> dict[str, int]:
    """Core loop: for each frame, detect, and POST when there are detections.

    Returns a small stats dict (handy for tests + a final summary log).
    """
    stats = {"frames": 0, "detections": 0, "posts": 0, "post_errors": 0}
    for frame in frames:
        stats["frames"] += 1
        detections = detect(frame)
        if not detections:
            continue
        stats["detections"] += len(detections)
        payload = build_payload(config.app, config.room, now(), detections)
        status = post(config.callback_url, payload)
        stats["posts"] += 1
        if 200 <= status < 300:
            log(
                "detections",
                room=config.room,
                count=len(detections),
                classes=sorted({d["class"] for d in detections}),
                callback_status=status,
            )
        else:
            stats["post_errors"] += 1
            log("callback_error", room=config.room, status=status)
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
            message="no HLS source resolvable (set YOLO_HLS_DIR or YOLO_PUBLIC_BASE)",
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
        classes=config.classes or "all",
        source=source,
    )
    if config.device == "cpu":
        log(
            "note",
            message=(
                "running on CPU — heavier models (medium/large/xlarge) and higher "
                "FPS will fall behind real time; use nano/small + low FPS on CPU, "
                "or enable CUDA on a GPU host for real-time detection"
            ),
        )

    if reader is None:
        from .stream import HlsFrameReader

        reader = HlsFrameReader(source, config.fps)
    if detector is None:
        from .detector import Detector

        detector = Detector(
            config.model, config.device, config.confidence, config.classes
        )

    try:
        stats = run_loop(config, reader.frames(), detector.detect)
    except KeyboardInterrupt:
        stats = {}
    except Exception as exc:  # noqa: BLE001 - report + non-zero exit
        log("fatal", message=str(exc))
        return 1
    log("stop", **stats)
    return 0
