"""
faster-whisper engine wrapper. The heavy import happens INSIDE
`build_transcriber` so the pure-logic tests (and a worker whose config is
broken) never need faster-whisper installed.
"""
from __future__ import annotations

from typing import Callable

from .config import Config

# transcribe(path, language) -> (segments, detected_language)
Transcriber = Callable[[str, str | None], tuple[list[dict], str | None]]


def build_transcriber(config: Config) -> Transcriber:
    """Load the Whisper model once and return a per-file transcribe function."""
    from faster_whisper import WhisperModel  # heavy: only imported here

    model = WhisperModel(
        config.model,
        device=config.device,
        compute_type=config.compute_type,
        download_root=config.model_dir or None,
    )

    def transcribe(path: str, language: str | None) -> tuple[list[dict], str | None]:
        lang = None if not language or language == "auto" else language
        segments, info = model.transcribe(path, language=lang, vad_filter=True)
        out = [
            {
                "start": float(seg.start),
                "end": float(seg.end),
                "text": (seg.text or "").strip(),
            }
            for seg in segments
        ]
        return out, getattr(info, "language", None)

    return transcribe
