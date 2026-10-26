"""
Worker configuration — parsed from the environment set by the core plugin's
`worker.spawn(ctx)` (see streamhub-core/src/plugins/transcription/plugin.meta.ts).

Pure: `Config.from_env` takes an explicit mapping (defaults to os.environ) so
it is trivially unit-tested. No heavy deps.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping

# faster-whisper accepts these model names directly (auto-downloads).
_KNOWN_MODELS = {"tiny", "base", "small", "medium", "large-v3"}
_KNOWN_DEVICES = {"auto", "cpu", "cuda"}


def _f(env: Mapping[str, str], key: str, default: float) -> float:
    try:
        return float(env.get(key, "") or default)
    except (TypeError, ValueError):
        return default


@dataclass
class Config:
    app: str
    jobs_dir: str
    results_dir: str
    model: str = "small"
    language: str = "auto"      # 'auto' = let whisper detect
    device: str = "auto"        # auto | cpu | cuda
    compute_type: str = "auto"  # ctranslate2 compute type (int8/float16/auto)
    model_dir: str = ""         # download_root for the model cache
    poll_seconds: float = 2.0   # jobs-dir scan cadence

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Config":
        e = os.environ if env is None else env
        model = (e.get("TRANSCRIBE_MODEL") or "small").strip()
        if model not in _KNOWN_MODELS:
            model = "small"
        device = (e.get("TRANSCRIBE_DEVICE") or "auto").strip().lower()
        if device not in _KNOWN_DEVICES:
            device = "auto"
        poll = min(30.0, max(0.5, _f(e, "TRANSCRIBE_POLL_S", 2.0)))
        return cls(
            app=(e.get("TRANSCRIBE_APP") or "").strip(),
            jobs_dir=(e.get("TRANSCRIBE_JOBS_DIR") or "").strip(),
            results_dir=(e.get("TRANSCRIBE_RESULTS_DIR") or "").strip(),
            model=model,
            language=(e.get("TRANSCRIBE_LANGUAGE") or "auto").strip() or "auto",
            device=device,
            compute_type=(e.get("TRANSCRIBE_COMPUTE") or "auto").strip() or "auto",
            model_dir=(e.get("TRANSCRIBE_MODEL_DIR") or "").strip(),
            poll_seconds=poll,
        )

    def validate(self) -> list[str]:
        """Return a list of human-readable problems ([] == OK)."""
        problems: list[str] = []
        if not self.app:
            problems.append("TRANSCRIBE_APP is required")
        if not self.jobs_dir:
            problems.append("TRANSCRIBE_JOBS_DIR is required")
        if not self.results_dir:
            problems.append("TRANSCRIBE_RESULTS_DIR is required")
        return problems
