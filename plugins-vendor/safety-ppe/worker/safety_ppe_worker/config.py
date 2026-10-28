"""
Worker configuration — parsed from the environment set by the core plugin's
`worker.spawn(ctx)` (see streamhub-core/src/plugins/safety-ppe/plugin.meta.ts).

Pure: `Config.from_env` takes an explicit mapping (defaults to os.environ) so
it is trivially unit-tested. No heavy deps.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Mapping

from .classes import parse_class_names
from .schedule import Hours, parse_days, parse_hours
from .zones import Zone, parse_zones

_PROVIDERS = {"cpu", "cuda"}

# Shipped model: Hexmon/vyra-yolo-ppe-detection (YOLOv8m, 14 classes, ONNX
# export included in the repo — see the worker README for license notes).
DEFAULT_MODEL_URL = (
    "https://huggingface.co/Hexmon/vyra-yolo-ppe-detection/resolve/main/best.onnx"
)
MODEL_FILENAME = "safety-ppe.onnx"


def _f(env: Mapping[str, str], key: str, default: float) -> float:
    try:
        return float(env.get(key, "") or default)
    except (TypeError, ValueError):
        return default


def _i(env: Mapping[str, str], key: str, default: int) -> int:
    try:
        return int(float(env.get(key, "") or default))
    except (TypeError, ValueError):
        return default


def _b(env: Mapping[str, str], key: str, default: bool) -> bool:
    raw = (env.get(key) or "").strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    return default


@dataclass
class Config:
    app: str
    room: str
    confidence: float = 0.35
    fps: float = 1.0
    require_helmet: bool = True
    require_vest: bool = True
    zones: list[Zone] = field(default_factory=list)
    work_hours: Hours | None = None        # None = always on
    work_days: set[int] | None = None      # None = every day
    sustain_frames: int = 3
    cooldown_seconds: float = 120.0
    assoc_threshold: float = 0.5
    execution_provider: str = "cpu"        # "cpu" | "cuda"
    class_names: list[str] | None = None   # None = model metadata / shipped default
    model_dir: str = ""                    # where the .onnx is cached
    model_url: str = DEFAULT_MODEL_URL
    db_path: str = ""                      # <DATA_DIR>/safety-ppe.db
    evidence_dir: str = ""                 # <DATA_DIR>/evidence
    callback_url: str = ""                 # operator webhook for ppe.violation
    callback_secret: str = ""              # HMAC secret for the webhook
    hls_dir: str = ""                      # local <appDir>/hls
    public_base: str = ""                  # e.g. https://streamhub.example.com
    livekit_url: str = ""

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Config":
        e = os.environ if env is None else env
        provider = (e.get("SAFETY_PPE_EXECUTION_PROVIDER") or "cpu").strip().lower()
        if provider not in _PROVIDERS:
            provider = "cpu"
        confidence = min(1.0, max(0.0, _f(e, "SAFETY_PPE_CONFIDENCE", 0.35)))
        fps = min(30.0, max(0.1, _f(e, "SAFETY_PPE_FPS", 1.0)))
        sustain = max(0, _i(e, "SAFETY_PPE_SUSTAIN_FRAMES", 3))
        cooldown = max(0.0, _f(e, "SAFETY_PPE_COOLDOWN_SECONDS", 120.0))
        assoc = min(1.0, max(0.05, _f(e, "SAFETY_PPE_ASSOC_THRESHOLD", 0.5)))
        model_dir = (e.get("SAFETY_PPE_MODEL_DIR") or "").strip() or os.path.join(
            os.path.expanduser("~"), ".cache", "streamhub", "safety-ppe"
        )
        return cls(
            app=(e.get("SAFETY_PPE_APP") or "").strip(),
            room=(e.get("SAFETY_PPE_ROOM") or "").strip(),
            confidence=confidence,
            fps=fps,
            require_helmet=_b(e, "SAFETY_PPE_REQUIRE_HELMET", True),
            require_vest=_b(e, "SAFETY_PPE_REQUIRE_VEST", True),
            zones=parse_zones(e.get("SAFETY_PPE_ZONES")),
            work_hours=parse_hours(e.get("SAFETY_PPE_WORK_HOURS")),
            work_days=parse_days(e.get("SAFETY_PPE_WORK_DAYS")),
            sustain_frames=sustain,
            cooldown_seconds=cooldown,
            assoc_threshold=assoc,
            execution_provider=provider,
            class_names=parse_class_names(e.get("SAFETY_PPE_CLASS_NAMES")),
            model_dir=model_dir,
            model_url=(e.get("SAFETY_PPE_MODEL_URL") or DEFAULT_MODEL_URL).strip(),
            db_path=(e.get("SAFETY_PPE_DB") or "").strip(),
            evidence_dir=(e.get("SAFETY_PPE_EVIDENCE_DIR") or "").strip(),
            callback_url=(e.get("SAFETY_PPE_CALLBACK_URL") or "").strip(),
            callback_secret=(e.get("SAFETY_PPE_CALLBACK_SECRET") or "").strip(),
            hls_dir=(e.get("SAFETY_PPE_HLS_DIR") or "").strip(),
            public_base=(e.get("SAFETY_PPE_PUBLIC_BASE") or "").strip(),
            livekit_url=(e.get("SAFETY_PPE_LIVEKIT_URL") or "").strip(),
        )

    # -- derived -----------------------------------------------------------

    def require(self) -> list[str]:
        """Items to enforce, in stable order."""
        items: list[str] = []
        if self.require_helmet:
            items.append("helmet")
        if self.require_vest:
            items.append("vest")
        return items

    def model_path(self) -> str:
        """Where the ONNX model lives (downloaded on first run)."""
        return os.path.join(self.model_dir, MODEL_FILENAME)

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
            problems.append("SAFETY_PPE_APP is required")
        if not self.room:
            problems.append("SAFETY_PPE_ROOM is required")
        if not self.require():
            problems.append(
                "nothing to enforce (enable requireHelmet and/or requireVest)"
            )
        return problems
