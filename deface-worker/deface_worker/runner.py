"""
Runner — wires the stream reader, CenterFace detector and callback together and
logs structured JSON lines to stdout (the core worker-hook mirrors these into
the plugin logs UI).

The heavy pieces (reader/detector) are injectable so the loop itself can be
tested without OpenCV/onnxruntime, but the default `run(config)` builds the
real ones.
"""
from __future__ import annotations

import json
import sys
import time
from typing import Any, Callable, Iterable

from .callback import build_payload, post_json
from .config import Config
from .geometry import faces_to_payload


def log(event: str, **fields: Any) -> None:
    """Emit one structured JSON log line to stdout."""
    rec = {"ts": round(time.time(), 3), "event": event, **fields}
    sys.stdout.write(json.dumps(rec, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def run_loop(
    config: Config,
    frames: Iterable[Any],
    detect: Callable[[Any], list[list[float]]],
    post: Callable[..., int] = post_json,
    now: Callable[[], float] = time.time,
    emit: Callable[..., None] = log,
) -> dict[str, int]:
    """Core loop: detect faces per frame and POST EVERY frame's result.

    Unlike yolo (which only posts frames with hits), an EMPTY faces list is
    posted too — the player overlay needs it to CLEAR masks when a face leaves
    the frame; a lingering stale mask is a rendering bug, a missing mask is a
    privacy bug, so freshness matters in both directions.

    To keep the 500-line log ring useful, a `faces` log line is emitted only
    when the face COUNT changes (POSTs still happen every frame).

    Returns a small stats dict (handy for tests + a final summary log).
    """
    stats = {"frames": 0, "faces": 0, "posts": 0, "post_errors": 0}
    prev_count = -1
    for frame in frames:
        stats["frames"] += 1
        try:
            h, w = frame.shape[:2]  # numpy at runtime; fakes in tests
        except AttributeError:
            h, w = 0, 0
        dets = detect(frame)
        faces = faces_to_payload(dets, float(w), float(h), config.mask_scale)
        stats["faces"] += len(faces)
        payload = build_payload(
            config.app, config.room, now(), faces, config.mask_scale
        )
        status = post(config.callback_url, payload, token=config.ingest_token)
        stats["posts"] += 1
        if not (200 <= status < 300):
            stats["post_errors"] += 1
            emit("callback_error", room=config.room, status=status)
        elif len(faces) != prev_count:
            emit("faces", room=config.room, count=len(faces), status=status)
        prev_count = len(faces)
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
            message="no HLS source resolvable (set DEFACE_HLS_DIR or DEFACE_PUBLIC_BASE)",
        )
        return 2

    log(
        "start",
        app=config.app,
        room=config.room,
        model="centerface",
        backend=config.backend,
        execution_provider=config.execution_provider,
        thresh=config.thresh,
        mask_scale=config.mask_scale,
        scale=list(config.scale) if config.scale else "native",
        fps=config.fps,
        source=source,
    )
    if config.execution_provider == "cpu":
        log(
            "note",
            message=(
                "running on CPU — CenterFace is light enough for a few FPS on "
                "CPU, but set a detection downscale (e.g. 640x360) for larger "
                "streams, or enable CUDA on a GPU host"
            ),
        )

    if reader is None:
        from .stream import HlsFrameReader

        reader = HlsFrameReader(source, config.fps)
    if detector is None:
        from .centerface import CenterFace, ensure_model

        try:
            model_path = ensure_model(config.model_dir, config.model_url)
        except Exception as exc:  # noqa: BLE001 - download/permission errors
            log("fatal", message=f"could not fetch centerface.onnx: {exc}")
            return 1
        log("model", path=model_path)
        detector = CenterFace(
            model_path,
            backend=config.backend,
            execution_provider=config.execution_provider,
            scale=config.scale,
            on_note=lambda msg: log("note", message=msg),
        )

    # An injected detector may be a bare callable (tests); the real CenterFace
    # exposes .detect(frame, thresh).
    if hasattr(detector, "detect"):
        detect = lambda frame: detector.detect(frame, config.thresh)  # noqa: E731
    else:
        detect = detector

    try:
        stats = run_loop(config, reader.frames(), detect)
    except KeyboardInterrupt:
        stats = {}
    except Exception as exc:  # noqa: BLE001 - report + non-zero exit
        log("fatal", message=str(exc))
        return 1
    log("stop", **stats)
    return 0
