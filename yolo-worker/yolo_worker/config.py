"""
Worker configuration — parsed from the environment set by the core plugin's
`worker.spawn(ctx)` (see streamhub-core/src/plugins/yolo/plugin.meta.ts).

Pure: `Config.from_env` takes an explicit mapping (defaults to os.environ) so it
is trivially unit-tested. No heavy deps.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Mapping

from .coco import parse_classes

# ultralytics accepts these weight names directly (auto-downloads on first use).
_KNOWN_MODELS = {"yolov8n", "yolov8s", "yolov8m", "yolov8l", "yolov8x"}


def _f(env: Mapping[str, str], key: str, default: float) -> float:
    try:
        return float(env.get(key, "") or default)
    except (TypeError, ValueError):
        return default


@dataclass
class Config:
    app: str
    room: str
    model: str = "yolov8n"
    device: str = "cpu"          # "cpu" | "cuda"
    confidence: float = 0.35
    fps: float = 2.0
    classes: list[str] = field(default_factory=list)   # empty = all
    callback_url: str = ""
    hls_dir: str = ""            # local <appDir>/hls
    public_base: str = ""        # e.g. https://streamhub.example.com
    livekit_url: str = ""

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Config":
        e = os.environ if env is None else env
        model = (e.get("YOLO_MODEL") or "yolov8n").strip()
        if model not in _KNOWN_MODELS:
            model = "yolov8n"
        device = (e.get("YOLO_DEVICE") or "cpu").strip().lower()
        if device not in ("cpu", "cuda"):
            device = "cpu"
        confidence = min(1.0, max(0.0, _f(e, "YOLO_CONFIDENCE", 0.35)))
        fps = min(30.0, max(0.1, _f(e, "YOLO_FPS", 2.0)))
        return cls(
            app=(e.get("YOLO_APP") or "").strip(),
            room=(e.get("YOLO_ROOM") or "").strip(),
            model=model,
            device=device,
            confidence=confidence,
            fps=fps,
            classes=parse_classes(e.get("YOLO_CLASSES")),
            callback_url=(e.get("YOLO_CALLBACK_URL") or "").strip(),
            hls_dir=(e.get("YOLO_HLS_DIR") or "").strip(),
            public_base=(e.get("YOLO_PUBLIC_BASE") or "").strip(),
            livekit_url=(e.get("YOLO_LIVEKIT_URL") or "").strip(),
        )

    # -- derived -----------------------------------------------------------

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
            problems.append("YOLO_APP is required")
        if not self.room:
            problems.append("YOLO_ROOM is required")
        if not self.callback_url:
            problems.append("YOLO_CALLBACK_URL is required")
        return problems
