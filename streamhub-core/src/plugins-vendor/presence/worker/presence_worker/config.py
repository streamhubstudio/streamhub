"""
Worker configuration — parsed from the environment set by the core plugin's
`worker.spawn(ctx)` (see streamhub-core/src/plugins/presence/plugin.meta.ts)
plus the framework-injected STREAMHUB_INGEST_* live-data channel vars.

Pure: `Config.from_env` takes an explicit mapping (defaults to os.environ) so
it is trivially unit-tested. No heavy deps. EDGE-READY: nothing here assumes
the core's filesystem — every path/URL arrives via env, and the public HLS URL
is the fallback when the local HLS dir isn't mounted (remote GRID node).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Mapping

from .zones import Zone, parse_zones

# ultralytics accepts these weight names directly (auto-downloads on first use).
_KNOWN_MODELS = {"yolov8n", "yolov8s", "yolov8m", "yolov8l", "yolov8x"}


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
    zones: list[Zone] = field(default_factory=list)
    schedule_window: str = "08:00-18:00"
    schedule_days: str = "mon-fri"
    timezone: str = ""               # IANA name; '' = server local time
    threshold_min: float = 5.0       # zone empty longer than this → absent
    after_hours: bool = True         # emit presence.after_hours events
    model: str = "yolov8n"
    device: str = "cpu"              # "cpu" | "cuda"
    confidence: float = 0.35
    fps: float = 2.0
    callback_url: str = ""           # optional EXTERNAL webhook for events
    ingest_url: str = ""             # framework live-data channel (POST :id/live)
    ingest_token: str = ""           # framework live-data channel auth
    data_dir: str = ""               # where presence.db lives
    hls_dir: str = ""                # local <appDir>/hls
    public_base: str = ""            # e.g. https://streamhub.example.com
    livekit_url: str = ""

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Config":
        e = os.environ if env is None else env
        model = (e.get("PRESENCE_MODEL") or "yolov8n").strip()
        if model not in _KNOWN_MODELS:
            model = "yolov8n"
        device = (e.get("PRESENCE_DEVICE") or "cpu").strip().lower()
        if device not in ("cpu", "cuda"):
            device = "cpu"
        confidence = min(1.0, max(0.0, _f(e, "PRESENCE_CONFIDENCE", 0.35)))
        fps = min(10.0, max(0.1, _f(e, "PRESENCE_FPS", 2.0)))
        threshold_min = min(24 * 60.0, max(0.1, _f(e, "PRESENCE_THRESHOLD_MIN", 5.0)))
        data_dir = (e.get("PRESENCE_DATA_DIR") or "").strip() or os.path.join(
            os.path.expanduser("~"),
            ".cache",
            "streamhub",
            "presence",
            (e.get("PRESENCE_APP") or "default").strip() or "default",
        )
        return cls(
            app=(e.get("PRESENCE_APP") or "").strip(),
            room=(e.get("PRESENCE_ROOM") or "").strip(),
            zones=parse_zones(e.get("PRESENCE_ZONES")),
            schedule_window=(e.get("PRESENCE_SCHEDULE") or "08:00-18:00").strip(),
            schedule_days=(e.get("PRESENCE_SCHEDULE_DAYS") or "mon-fri").strip(),
            timezone=(e.get("PRESENCE_TZ") or "").strip(),
            threshold_min=threshold_min,
            after_hours=_b(e, "PRESENCE_AFTER_HOURS", True),
            model=model,
            device=device,
            confidence=confidence,
            fps=fps,
            callback_url=(e.get("PRESENCE_CALLBACK_URL") or "").strip(),
            ingest_url=(e.get("STREAMHUB_INGEST_URL") or "").strip(),
            ingest_token=(e.get("STREAMHUB_INGEST_TOKEN") or "").strip(),
            data_dir=data_dir,
            hls_dir=(e.get("PRESENCE_HLS_DIR") or "").strip(),
            public_base=(e.get("PRESENCE_PUBLIC_BASE") or "").strip(),
            livekit_url=(e.get("PRESENCE_LIVEKIT_URL") or "").strip(),
        )

    # -- derived -----------------------------------------------------------

    def db_path(self) -> str:
        """The worker-owned SQLite database: <data_dir>/presence.db."""
        return os.path.join(self.data_dir, "presence.db")

    def events_url(self) -> str:
        """Framework plugin-events endpoint, derived from the ingest URL the
        worker-hook injected (…/plugins/presence/live → …/plugins/presence/events).
        Empty when no ingest channel was provided.
        """
        if self.ingest_url.endswith("/live"):
            return self.ingest_url[: -len("/live")] + "/events"
        return ""

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
            problems.append("PRESENCE_APP is required")
        if not self.room:
            problems.append("PRESENCE_ROOM is required")
        if not self.zones:
            problems.append(
                "PRESENCE_ZONES must define at least one zone "
                '([{"id","name","x","y","w","h"}] with 0-1 coordinates)'
            )
        return problems
