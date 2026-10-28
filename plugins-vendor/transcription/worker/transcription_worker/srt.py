"""
Segment → SubRip (SRT) helpers + the per-track speaker merge.

MIRRORS streamhub-core/src/modules/transcription/transcription.util.ts — the
core builds the canonical SRT it uploads to S3, the worker uses the same
logic for its local debugging artifact; keep both in sync:
  - cues sorted by start time, 1-based numbering,
  - empty-text segments dropped,
  - `[speaker] ` prefix when a segment carries a speaker,
  - minimum cue duration 0.5s so zero-length cues still render,
  - `HH:MM:SS,mmm` timecodes (ms-rounded, clamped at 0).
"""
from __future__ import annotations

from typing import Any

MIN_CUE_SECONDS = 0.5


def format_timestamp(seconds: float) -> str:
    """Format seconds as an SRT timecode `HH:MM:SS,mmm` (clamped at 0)."""
    try:
        total_ms = max(0, round(float(seconds) * 1000))
    except (TypeError, ValueError):
        total_ms = 0
    ms = total_ms % 1000
    s = (total_ms // 1000) % 60
    m = (total_ms // 60_000) % 60
    h = total_ms // 3_600_000
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def merge_tracks(tracks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge per-track transcripts into one chronological segment list.

    Each track is `{ speaker, segments: [{start, end, text}] }`; the track's
    speaker label is attached to each of its segments.
    """
    merged: list[dict[str, Any]] = []
    for track in tracks:
        speaker = track.get("speaker")
        for seg in track.get("segments") or []:
            merged.append(
                {
                    "start": float(seg.get("start") or 0),
                    "end": float(seg.get("end") or 0),
                    "text": str(seg.get("text") or ""),
                    "speaker": speaker,
                }
            )
    return sorted(merged, key=lambda s: (s["start"], s["end"]))


def build_srt(segments: list[dict[str, Any]]) -> str:
    """Build a SubRip document from `{start, end, text, speaker?}` segments."""
    ordered = sorted(
        (s for s in segments if str(s.get("text") or "").strip()),
        key=lambda s: (float(s.get("start") or 0), float(s.get("end") or 0)),
    )
    cues: list[str] = []
    for i, seg in enumerate(ordered, start=1):
        start = float(seg.get("start") or 0)
        end = max(float(seg.get("end") or 0), start + MIN_CUE_SECONDS)
        text = str(seg["text"]).strip()
        speaker = seg.get("speaker")
        if speaker:
            text = f"[{speaker}] {text}"
        cues.append(f"{i}\n{format_timestamp(start)} --> {format_timestamp(end)}\n{text}")
    return "\n\n".join(cues) + "\n" if cues else ""


def plain_text(segments: list[dict[str, Any]]) -> str:
    """Plain-text transcript: one `[speaker] text` line per non-empty segment."""
    lines: list[str] = []
    for seg in segments:
        text = str(seg.get("text") or "").strip()
        if not text:
            continue
        speaker = seg.get("speaker")
        lines.append(f"[{speaker}] {text}" if speaker else text)
    return "\n".join(lines)
