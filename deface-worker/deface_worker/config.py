"""
Worker configuration — parsed from the environment set by the core plugin's
`worker.spawn(ctx)` (see streamhub-core/src/plugins/deface/plugin.meta.ts) plus
the framework-injected STREAMHUB_INGEST_* live-data channel vars.

Pure: `Config.from_env` takes an explicit mapping (defaults to os.environ) so it
is trivially unit-tested. No heavy deps.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping

from .geometry import parse_scale

_BACKENDS = {"auto", "onnxrt", "opencv"}
_PROVIDERS = {"cpu", "cuda"}

# centerface.onnx as shipped by deface (~7.4 MB) — downloaded on first run.
DEFAULT_MODEL_URL = (
    "https://github.com/ORB-HD/deface/raw/master/deface/centerface.onnx"
)


def _f(env: Mapping[str, str], key: str, default: float) -> float:
    try:
        return float(env.get(key, "") or default)
    except (TypeError, ValueError):
        return default


@dataclass
class Config:
    app: str
    room: str
    thresh: float = 0.2
    mask_scale: float = 1.3
    scale: tuple[int, int] | None = None  # detection size (w, h); None = native
    backend: str = "auto"                 # "auto" | "onnxrt" | "opencv"
    execution_provider: str = "cpu"       # "cpu" | "cuda"
    fps: float = 2.0
    callback_url: str = ""                # where face payloads are POSTed
    ingest_token: str = ""                # framework live-data channel auth
    model_dir: str = ""                   # where centerface.onnx is cached
    model_url: str = DEFAULT_MODEL_URL
    hls_dir: str = ""                     # local <appDir>/hls
    public_base: str = ""                 # e.g. https://streamhub.example.com
    livekit_url: str = ""

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Config":
        e = os.environ if env is None else env
        backend = (e.get("DEFACE_BACKEND") or "auto").strip().lower()
        if backend not in _BACKENDS:
            backend = "auto"
        provider = (e.get("DEFACE_EXECUTION_PROVIDER") or "cpu").strip().lower()
        if provider not in _PROVIDERS:
            provider = "cpu"
        thresh = min(1.0, max(0.0, _f(e, "DEFACE_THRESH", 0.2)))
        mask_scale = min(3.0, max(1.0, _f(e, "DEFACE_MASK_SCALE", 1.3)))
        fps = min(30.0, max(0.1, _f(e, "DEFACE_FPS", 2.0)))
        # Callback: explicit override wins; otherwise the framework live-data
        # channel the worker-hook injected (STREAMHUB_INGEST_URL + token).
        callback_url = (
            e.get("DEFACE_CALLBACK_URL") or e.get("STREAMHUB_INGEST_URL") or ""
        ).strip()
        model_dir = (e.get("DEFACE_MODEL_DIR") or "").strip() or os.path.join(
            os.path.expanduser("~"), ".cache", "streamhub", "deface"
        )
        return cls(
            app=(e.get("DEFACE_APP") or "").strip(),
            room=(e.get("DEFACE_ROOM") or "").strip(),
            thresh=thresh,
            mask_scale=mask_scale,
            scale=parse_scale(e.get("DEFACE_SCALE")),
            backend=backend,
            execution_provider=provider,
            fps=fps,
            callback_url=callback_url,
            ingest_token=(e.get("STREAMHUB_INGEST_TOKEN") or "").strip(),
            model_dir=model_dir,
            model_url=(e.get("DEFACE_MODEL_URL") or DEFAULT_MODEL_URL).strip(),
            hls_dir=(e.get("DEFACE_HLS_DIR") or "").strip(),
            public_base=(e.get("DEFACE_PUBLIC_BASE") or "").strip(),
            livekit_url=(e.get("DEFACE_LIVEKIT_URL") or "").strip(),
        )

    # -- derived -----------------------------------------------------------

    def model_path(self) -> str:
        """Where centerface.onnx lives (downloaded on first run)."""
        return os.path.join(self.model_dir, "centerface.onnx")

    def local_playlist(self) -> str:
        """On-disk HLS playlist path: <hls_dir>/<room>/index.m3u8 (may not exist)."""
        if not self.hls_dir or not self.room:
            return ""
        return os.path.join(self.hls_dir, self.room, "index.m3u8")

    def public_playlist(self) -> str:
        """Public HLS URL: <base>/hls/<app>/<room>/index.m3u8 (may be empty)."""
        if not self.public_base or not self.app or not self.room:
            return ""
        base = self.public_base.rstrip("/")
        return f"{base}/hls/{self.app}/{self.room}/index.m3u8"

    def stream_source(self, exists=os.path.exists) -> str:
        """Resolve the stream source: prefer a present local playlist, else the
        public URL. `exists` is injectable for testing. Returns '' if neither.
        """
        local = self.local_playlist()
        if local and exists(local):
            return local
        return self.public_playlist() or local

    def validate(self) -> list[str]:
        """Return a list of human-readable problems ([] == OK)."""
        problems: list[str] = []
        if not self.app:
            problems.append("DEFACE_APP is required")
        if not self.room:
            problems.append("DEFACE_ROOM is required")
        if not self.callback_url:
            problems.append(
                "no callback target (set DEFACE_CALLBACK_URL, or run via the "
                "plugin worker-hook which injects STREAMHUB_INGEST_URL)"
            )
        return problems
