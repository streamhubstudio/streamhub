"""
Worker configuration — parsed from the environment set by the core plugin's
`worker.spawn(ctx)` (see streamhub-core/src/plugins/perimeter/plugin.meta.ts)
plus the framework-injected STREAMHUB_INGEST_* live-data channel vars.

Pure: `Config.from_env` takes an explicit mapping (defaults to os.environ) so
it is trivially unit-tested. No heavy deps.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Mapping

from .geometry import parse_zones
from .schedule import ARM_MODES, Window, parse_window

# ultralytics accepts these weight names directly (auto-downloads on first use).
_KNOWN_MODELS = {"yolov8n", "yolov8s"}
_DEVICES = {"cpu", "cuda"}
_ANCHORS = {"foot", "center"}


def _f(env: Mapping[str, str], key: str, default: float) -> float:
    try:
        return float(env.get(key, "") or default)
    except (TypeError, ValueError):
        return default


def _b(env: Mapping[str, str], key: str, default: bool) -> bool:
    raw = (env.get(key) or "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return default


@dataclass
class Config:
    app: str
    room: str
    model: str = "yolov8n"
    device: str = "cpu"                  # "cpu" | "cuda"
    confidence: float = 0.5
    fps: float = 1.0
    zones: list[dict[str, Any]] = field(default_factory=list)
    anchor: str = "foot"                 # "foot" | "center"
    arm_mode: str = "schedule"           # "schedule" | "armed" | "disarmed"
    arm_window: Window | None = (22 * 60, 6 * 60)
    arm_weekends: bool = True
    timezone: str = ""                   # IANA name; '' = host local
    cooldown: float = 60.0               # per-zone seconds between alerts
    clip_seconds: float = 10.0           # 0 = no evidence clip
    ack_through: float = 0.0             # unix seconds; alerts <= are acked on boot
    status_interval: float = 2.0         # live status push cadence (seconds)
    data_dir: str = ""                   # perimeter.db + evidence/ live here
    callback_url: str = ""               # operator webhook (optional)
    callback_secret: str = ""            # HMAC secret for the webhook
    ingest_url: str = ""                 # framework live-data channel
    ingest_token: str = ""
    hls_dir: str = ""                    # local <appDir>/hls
    public_base: str = ""                # e.g. https://streamhub.example.com
    livekit_url: str = ""

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Config":
        e = os.environ if env is None else env
        model = (e.get("PERIMETER_MODEL") or "yolov8n").strip()
        if model not in _KNOWN_MODELS:
            model = "yolov8n"
        device = (e.get("PERIMETER_DEVICE") or "cpu").strip().lower()
        if device not in _DEVICES:
            device = "cpu"
        anchor = (e.get("PERIMETER_ANCHOR") or "foot").strip().lower()
        if anchor not in _ANCHORS:
            anchor = "foot"
        arm_mode = (e.get("PERIMETER_ARM_MODE") or "schedule").strip().lower()
        if arm_mode not in ARM_MODES:
            arm_mode = "schedule"
        raw_window = e.get("PERIMETER_ARM_SCHEDULE")
        window = parse_window("22:00-06:00" if raw_window is None else raw_window)
        return cls(
            app=(e.get("PERIMETER_APP") or "").strip(),
            room=(e.get("PERIMETER_ROOM") or "").strip(),
            model=model,
            device=device,
            confidence=min(1.0, max(0.0, _f(e, "PERIMETER_CONFIDENCE", 0.5))),
            fps=min(10.0, max(0.1, _f(e, "PERIMETER_FPS", 1.0))),
            zones=parse_zones(e.get("PERIMETER_ZONES")),
            anchor=anchor,
            arm_mode=arm_mode,
            arm_window=window,
            arm_weekends=_b(e, "PERIMETER_ARM_WEEKENDS", True),
            timezone=(e.get("PERIMETER_TIMEZONE") or "").strip(),
            cooldown=min(3600.0, max(1.0, _f(e, "PERIMETER_COOLDOWN", 60.0))),
            clip_seconds=min(60.0, max(0.0, _f(e, "PERIMETER_CLIP_SECONDS", 10.0))),
            ack_through=max(0.0, _f(e, "PERIMETER_ACK_THROUGH", 0.0)),
            status_interval=min(30.0, max(0.5, _f(e, "PERIMETER_STATUS_INTERVAL", 2.0))),
            data_dir=(e.get("PERIMETER_DATA_DIR") or "").strip(),
            callback_url=(e.get("PERIMETER_CALLBACK_URL") or "").strip(),
            callback_secret=(e.get("PERIMETER_CALLBACK_SECRET") or "").strip(),
            ingest_url=(e.get("STREAMHUB_INGEST_URL") or "").strip(),
            ingest_token=(e.get("STREAMHUB_INGEST_TOKEN") or "").strip(),
            hls_dir=(e.get("PERIMETER_HLS_DIR") or "").strip(),
            public_base=(e.get("PERIMETER_PUBLIC_BASE") or "").strip(),
            livekit_url=(e.get("PERIMETER_LIVEKIT_URL") or "").strip(),
        )

    # -- derived -----------------------------------------------------------

    def db_path(self) -> str:
        """Per-plugin SQLite: <data_dir>/perimeter.db (README schema)."""
        return os.path.join(self.data_dir, "perimeter.db") if self.data_dir else ""

    def evidence_dir(self) -> str:
        return os.path.join(self.data_dir, "evidence") if self.data_dir else ""

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
            problems.append("PERIMETER_APP is required")
        if not self.room:
            problems.append("PERIMETER_ROOM is required")
        if not self.data_dir:
            problems.append("PERIMETER_DATA_DIR is required (perimeter.db + evidence)")
        if not self.zones:
            problems.append(
                "PERIMETER_ZONES has no usable zone — draw at least one zone "
                "in the dashboard (or pass zones JSON)"
            )
        return problems
