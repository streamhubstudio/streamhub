"""
Evidence capture — snapshot JPEG + optional HLS segment clip.

Path building, playlist parsing and the ffmpeg command are PURE (unit-tested);
only `save_snapshot`/`make_thumb_b64` (cv2) and `copy_clip`'s subprocess call
touch heavy/OS things, both lazily and best-effort — evidence trouble must
never break the detection loop (the runner logs and moves on).

The clip is deliberately cheap: the LAST HLS segments already on disk are
concatenated with `-c copy` (no re-encode), giving ~clipSeconds of video
ENDING at the intrusion. Requires the local HLS dir (a remote/edge worker
reading HLS over HTTP skips the clip).
"""
from __future__ import annotations

import base64
import os
import time
from typing import Any, Sequence

from .geometry import slugify_zone


def evidence_paths(data_dir: str, ts: float, zone_id: str) -> tuple[str, str]:
    """(snapshot_jpg, clip_mp4) under `<data_dir>/evidence/`.

    Filenames are UTC-stamped with milliseconds so same-second alerts in
    different (or the same, post-cooldown) zones never collide:
      evidence/20260709-233000-123-gate.jpg
    """
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime(ts))
    ms = int(round((ts % 1) * 1000)) % 1000
    base = f"{stamp}-{ms:03d}-{slugify_zone(zone_id)}"
    evidence_dir = os.path.join(data_dir, "evidence")
    return (
        os.path.join(evidence_dir, base + ".jpg"),
        os.path.join(evidence_dir, base + ".mp4"),
    )


def parse_playlist_segments(text: str) -> list[tuple[str, float]]:
    """HLS media playlist → [(segment_uri, duration_seconds)] in order."""
    out: list[tuple[str, float]] = []
    duration = 0.0
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("#EXTINF:"):
            try:
                duration = float(line[len("#EXTINF:"):].split(",", 1)[0])
            except (TypeError, ValueError):
                duration = 0.0
        elif line and not line.startswith("#"):
            out.append((line, duration))
            duration = 0.0
    return out


def segments_for_clip(
    segments: Sequence[tuple[str, float]],
    seconds: float,
) -> list[str]:
    """The trailing segment URIs whose durations cover >= `seconds` (at least
    one when any exist) — the "last ~10s" of the live stream.
    """
    if not segments or seconds <= 0:
        return []
    picked: list[str] = []
    total = 0.0
    for uri, duration in reversed(segments):
        picked.append(uri)
        total += max(0.0, duration)
        if total >= seconds:
            break
    picked.reverse()
    return picked


def build_clip_command(
    segment_paths: Sequence[str],
    out_path: str,
    ffmpeg: str = "ffmpeg",
) -> list[str]:
    """The `-c copy` concat command (no re-encode — cheap by design)."""
    return [
        ffmpeg,
        "-y",
        "-loglevel",
        "error",
        "-i",
        "concat:" + "|".join(segment_paths),
        "-c",
        "copy",
        out_path,
    ]


def copy_clip(
    playlist_path: str,
    seconds: float,
    out_path: str,
    run: Any = None,
) -> bool:
    """Best-effort: concat the last HLS segments into `out_path`.

    Returns True only when ffmpeg succeeded and the file exists. Any miss
    (no playlist, no segments, no ffmpeg) returns False without raising.
    `run` is injectable for tests; defaults to subprocess.run.
    """
    try:
        with open(playlist_path, "r", encoding="utf-8") as fh:
            segments = parse_playlist_segments(fh.read())
    except OSError:
        return False
    hls_dir = os.path.dirname(playlist_path)
    picked = [
        os.path.join(hls_dir, uri)
        for uri in segments_for_clip(segments, seconds)
    ]
    picked = [p for p in picked if os.path.exists(p)]
    if not picked:
        return False

    if run is None:
        import subprocess

        run = subprocess.run
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    try:
        result = run(
            build_clip_command(picked, out_path),
            capture_output=True,
            timeout=30,
        )
    except Exception:  # noqa: BLE001 - ffmpeg missing / timeout
        return False
    return getattr(result, "returncode", 1) == 0 and os.path.exists(out_path)


def save_snapshot(frame: Any, path: str, box_px: Sequence[float] | None = None) -> bool:
    """Write the triggering frame as JPEG evidence (cv2, lazy). When a pixel
    [x1,y1,x2,y2] person box is given it is drawn for at-a-glance review.
    """
    try:
        import cv2  # lazy: runtime only

        os.makedirs(os.path.dirname(path), exist_ok=True)
        img = frame
        if box_px is not None:
            img = frame.copy()
            x1, y1, x2, y2 = (int(v) for v in box_px[:4])
            cv2.rectangle(img, (x1, y1), (x2, y2), (0, 0, 255), 2)
        return bool(cv2.imwrite(path, img))
    except Exception:  # noqa: BLE001 - never break the loop on evidence I/O
        return False


def make_thumb_b64(frame: Any, width: int = 320, quality: int = 60) -> str:
    """Small base64 JPEG of a frame for the live payload (panel previews).

    Returns '' on any failure — thumbnails are decoration, not evidence.
    """
    try:
        import cv2  # lazy: runtime only

        h, w = frame.shape[:2]
        if w <= 0 or h <= 0:
            return ""
        scale = min(1.0, float(width) / float(w))
        if scale < 1.0:
            frame = cv2.resize(frame, (int(w * scale), int(h * scale)))
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
        if not ok:
            return ""
        return base64.b64encode(buf.tobytes()).decode("ascii")
    except Exception:  # noqa: BLE001
        return ""
