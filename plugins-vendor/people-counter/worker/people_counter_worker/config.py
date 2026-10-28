"""
Worker configuration — parsed from the environment set by the core plugin's
`worker.spawn(ctx)` (streamhub-core/src/plugins/people-counter/plugin.meta.ts)
plus the framework-injected STREAMHUB_INGEST_* live-data channel vars.

Pure: `Config.from_env` takes an explicit mapping (defaults to os.environ) so
it is trivially unit-tested. No heavy deps. Every input arrives via env/args —
the worker is a pure process (edge/GRID friendly, see README).
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping

# ultralytics accepts these weight names directly (auto-downloads on first use).
_KNOWN_MODELS = {"yolov8n", "yolov8s", "yolov8m", "yolov8l", "yolov8x"}
_IN_SIDES = {"right", "left"}

DEFAULT_LINE = (0.2, 0.5, 0.8, 0.5)

# Bundled Vision One tracker config (see trackers/custom_bytetrack_persons.yaml).
def default_tracker_path() -> str:
    return os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "trackers",
        "custom_bytetrack_persons.yaml",
    )


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


def clamp01(v: float) -> float:
    return min(1.0, max(0.0, v))


def parse_line(raw: str | None) -> tuple[float, float, float, float]:
    """Parse 'x1,y1,x2,y2' (normalized 0–1) → clamped tuple.

    Malformed input or a DEGENERATE line (both points equal after clamping)
    falls back to the default horizontal mid-line, so a bad config can never
    crash the worker or count against a zero-length line.
    """
    if raw:
        parts = [p.strip() for p in raw.split(",")]
        if len(parts) == 4:
            try:
                vals = tuple(clamp01(float(p)) for p in parts)
            except (TypeError, ValueError):
                vals = None
            if vals and (vals[0], vals[1]) != (vals[2], vals[3]):
                return vals  # type: ignore[return-value]
    return DEFAULT_LINE


@dataclass
class Config:
    app: str
    room: str
    model: str = "yolov8n"
    device: str = "cpu"  # "cpu" | "cuda"
    confidence: float = 0.3
    fps: float = 5.0
    imgsz: int = 640
    line: tuple[float, float, float, float] = DEFAULT_LINE
    in_side: str = "right"  # side of line p1→p2 that is INSIDE ('in' direction)
    capacity: int = 0  # 0 = no capacity alert
    tracker: str = ""  # path to a tracker yaml (default: bundled Vision One)
    cooldown_frames: int = 15
    max_jump: float = 0.15
    sample_interval: float = 10.0  # seconds between occupancy_samples rows
    db_path: str = ""  # per-plugin SQLite (crossings + occupancy_samples)
    callback_url: str = ""  # where signed count.* events are POSTed
    callback_secret: str = ""  # HMAC-SHA256 secret for X-StreamHub-Signature
    ingest_url: str = ""  # framework live-data channel (counters snapshot)
    ingest_token: str = ""
    hls_dir: str = ""  # local <appDir>/hls
    public_base: str = ""  # e.g. https://streamhub.example.com
    livekit_url: str = ""

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Config":
        e = os.environ if env is None else env
        model = (e.get("PC_MODEL") or "yolov8n").strip()
        if model not in _KNOWN_MODELS:
            model = "yolov8n"
        device = (e.get("PC_DEVICE") or "cpu").strip().lower()
        if device not in ("cpu", "cuda"):
            device = "cpu"
        in_side = (e.get("PC_IN_DIRECTION") or "right").strip().lower()
        if in_side not in _IN_SIDES:
            in_side = "right"
        db_path = (e.get("PC_DB_PATH") or "").strip() or os.path.join(
            os.path.expanduser("~"), ".cache", "streamhub", "people-counter.db"
        )
        tracker = (e.get("PC_TRACKER") or "").strip() or default_tracker_path()
        return cls(
            app=(e.get("PC_APP") or "").strip(),
            room=(e.get("PC_ROOM") or "").strip(),
            model=model,
            device=device,
            confidence=min(1.0, max(0.0, _f(e, "PC_CONFIDENCE", 0.3))),
            fps=min(30.0, max(0.1, _f(e, "PC_FPS", 5.0))),
            imgsz=max(160, min(1920, _i(e, "PC_IMGSZ", 640))),
            line=parse_line(e.get("PC_LINE")),
            in_side=in_side,
            capacity=max(0, _i(e, "PC_CAPACITY", 0)),
            tracker=tracker,
            cooldown_frames=max(0, _i(e, "PC_COOLDOWN_FRAMES", 15)),
            max_jump=min(1.0, max(0.01, _f(e, "PC_MAX_JUMP", 0.15))),
            sample_interval=min(3600.0, max(1.0, _f(e, "PC_SAMPLE_INTERVAL", 10.0))),
            db_path=db_path,
            callback_url=(e.get("PC_CALLBACK_URL") or "").strip(),
            callback_secret=(e.get("PC_CALLBACK_SECRET") or "").strip(),
            ingest_url=(e.get("STREAMHUB_INGEST_URL") or "").strip(),
            ingest_token=(e.get("STREAMHUB_INGEST_TOKEN") or "").strip(),
            hls_dir=(e.get("PC_HLS_DIR") or "").strip(),
            public_base=(e.get("PC_PUBLIC_BASE") or "").strip(),
            livekit_url=(e.get("PC_LIVEKIT_URL") or "").strip(),
        )

    # -- derived -------------------------------------------------------------

    def line_points(self) -> tuple[tuple[float, float], tuple[float, float]]:
        x1, y1, x2, y2 = self.line
        return (x1, y1), (x2, y2)

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
            problems.append("PC_APP is required")
        if not self.room:
            problems.append("PC_ROOM is required")
        return problems
