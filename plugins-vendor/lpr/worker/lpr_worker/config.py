"""
Worker configuration — parsed from the environment set by the core plugin's
`worker.spawn(ctx)` (see streamhub-core/src/plugins/lpr/plugin.meta.ts) plus
the framework-injected STREAMHUB_INGEST_*/STREAMHUB_EVENTS_URL channel vars.

EDGE-READY: the worker never touches core code — everything arrives via env
(or a JSON override, see `merge_json_config`), so the same process runs on the
origin, on a GRID node, or on a standalone edge box next to the gate camera
(`LPR_SOURCE=rtsp://…` + `LPR_CALLBACK_URL=…`).

Pure: `Config.from_env` takes an explicit mapping (defaults to os.environ) so
it is trivially unit-tested. No heavy deps.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, replace
from typing import Mapping

from .plates import parse_plate_list

_DEVICES = {"cpu", "cuda"}

DEFAULT_DETECTOR = "yolo-v9-t-384-license-plate-end2end"
DEFAULT_OCR_MODEL = "cct-xs-v1-global-model"

_KNOWN_DETECTORS = {
    "yolo-v9-t-256-license-plate-end2end",
    "yolo-v9-t-384-license-plate-end2end",
    "yolo-v9-t-512-license-plate-end2end",
}


def _f(env: Mapping[str, str], key: str, default: float) -> float:
    try:
        return float(env.get(key, "") or default)
    except (TypeError, ValueError):
        return default


def _b(env: Mapping[str, str], key: str, default: bool) -> bool:
    raw = (env.get(key) or "").strip().lower()
    if raw in ("true", "1", "yes", "on"):
        return True
    if raw in ("false", "0", "no", "off"):
        return False
    return default


@dataclass
class Config:
    app: str
    room: str
    detector: str = DEFAULT_DETECTOR
    ocr_model: str = DEFAULT_OCR_MODEL
    device: str = "cpu"                      # "cpu" | "cuda"
    confidence: float = 0.5                  # min OCR confidence 0..1
    fps: float = 2.0
    dedupe_sec: float = 10.0
    whitelist: list[str] = field(default_factory=list)  # normalized plates
    blacklist: list[str] = field(default_factory=list)
    callback_url: str = ""                   # optional direct webhook (barrier)
    snapshots: bool = True
    source: str = ""                         # explicit stream URL (RTSP/HLS/…)
    data_dir: str = ""                       # holds lpr.db + snapshots/
    model_dir: str = ""                      # ONNX model cache
    hls_dir: str = ""                        # local <appDir>/hls
    public_base: str = ""                    # e.g. https://streamhub.example.com
    livekit_url: str = ""
    events_url: str = ""                     # framework event channel (signed callbacks)
    ingest_url: str = ""                     # framework live-data channel (dashboard)
    ingest_token: str = ""                   # auth for BOTH framework channels

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Config":
        e = os.environ if env is None else env
        detector = (e.get("LPR_DETECTOR") or DEFAULT_DETECTOR).strip()
        if detector not in _KNOWN_DETECTORS:
            detector = DEFAULT_DETECTOR
        device = (e.get("LPR_DEVICE") or "cpu").strip().lower()
        if device not in _DEVICES:
            device = "cpu"
        confidence = min(1.0, max(0.0, _f(e, "LPR_CONFIDENCE", 0.5)))
        fps = min(30.0, max(0.1, _f(e, "LPR_FPS", 2.0)))
        dedupe_sec = min(300.0, max(0.0, _f(e, "LPR_DEDUPE_SEC", 10.0)))
        data_dir = (e.get("LPR_DATA_DIR") or "").strip() or os.path.join(
            os.path.expanduser("~"), ".cache", "streamhub", "lpr"
        )
        model_dir = (e.get("LPR_MODEL_DIR") or "").strip() or os.path.join(
            data_dir, "models"
        )
        return cls(
            app=(e.get("LPR_APP") or "").strip(),
            room=(e.get("LPR_ROOM") or "").strip(),
            detector=detector,
            ocr_model=(e.get("LPR_OCR_MODEL") or DEFAULT_OCR_MODEL).strip(),
            device=device,
            confidence=confidence,
            fps=fps,
            dedupe_sec=dedupe_sec,
            whitelist=parse_plate_list(e.get("LPR_WHITELIST")),
            blacklist=parse_plate_list(e.get("LPR_BLACKLIST")),
            callback_url=(e.get("LPR_CALLBACK_URL") or "").strip(),
            snapshots=_b(e, "LPR_SNAPSHOTS", True),
            source=(e.get("LPR_SOURCE") or "").strip(),
            data_dir=data_dir,
            model_dir=model_dir,
            hls_dir=(e.get("LPR_HLS_DIR") or "").strip(),
            public_base=(e.get("LPR_PUBLIC_BASE") or "").strip(),
            livekit_url=(e.get("LPR_LIVEKIT_URL") or "").strip(),
            events_url=(e.get("LPR_EVENTS_URL") or e.get("STREAMHUB_EVENTS_URL") or "").strip(),
            ingest_url=(e.get("LPR_INGEST_URL") or e.get("STREAMHUB_INGEST_URL") or "").strip(),
            ingest_token=(e.get("STREAMHUB_INGEST_TOKEN") or "").strip(),
        )

    # -- derived -----------------------------------------------------------

    def db_path(self) -> str:
        """Per-worker SQLite read log: <data_dir>/lpr.db."""
        return os.path.join(self.data_dir, "lpr.db")

    def snapshots_dir(self) -> str:
        return os.path.join(self.data_dir, "snapshots")

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
        """Resolve the stream source: an explicit LPR_SOURCE (edge: RTSP/any
        URL OpenCV opens) wins; else prefer a present local playlist, else the
        public URL. `exists` is injectable for testing. Returns '' if none.
        """
        if self.source:
            return self.source
        local = self.local_playlist()
        if local and exists(local):
            return local
        return self.public_playlist() or local

    def validate(self) -> list[str]:
        """Return a list of human-readable problems ([] == OK)."""
        problems: list[str] = []
        if not self.app:
            problems.append("LPR_APP is required")
        if not self.room and not self.source:
            problems.append("LPR_ROOM (or an explicit LPR_SOURCE) is required")
        if not self.events_url and not self.callback_url:
            problems.append(
                "no event target: set LPR_CALLBACK_URL, or run via the plugin "
                "worker-hook which injects STREAMHUB_EVENTS_URL"
            )
        return problems


# JSON keys (the plugin configSchema keys) → Config attribute + coercion.
_JSON_KEYS = {
    "room": ("room", str),
    "detector": ("detector", str),
    "ocrModel": ("ocr_model", str),
    "confidence": ("confidence", float),
    "fps": ("fps", float),
    "dedupeWindowSec": ("dedupe_sec", float),
    "whitelist": ("whitelist", None),  # string or list — parsed below
    "blacklist": ("blacklist", None),
    "callbackUrl": ("callback_url", str),
    "snapshots": ("snapshots", bool),
    "cuda": ("device", None),          # boolean → cpu/cuda
    "source": ("source", str),
}


def merge_json_config(config: Config, json_text: str | None) -> Config:
    """Overlay a JSON config blob (LPR_CONFIG_JSON / --config file — the same
    camelCase keys as the plugin configSchema) over an env-derived Config.
    Returns a NEW Config; unknown keys are ignored, bad JSON raises ValueError.
    """
    if not json_text or not json_text.strip():
        return config
    try:
        data = json.loads(json_text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid config JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("config JSON must be an object")

    updates: dict[str, object] = {}
    for key, value in data.items():
        mapped = _JSON_KEYS.get(key)
        if mapped is None:
            continue
        attr, coerce = mapped
        if key in ("whitelist", "blacklist"):
            raw = ",".join(str(v) for v in value) if isinstance(value, list) else value
            updates[attr] = parse_plate_list(raw)
        elif key == "cuda":
            updates[attr] = "cuda" if value in (True, "true", 1) else "cpu"
        elif coerce is bool:
            updates[attr] = bool(value)
        elif coerce is float:
            try:
                updates[attr] = float(value)  # type: ignore[arg-type]
            except (TypeError, ValueError):
                continue
        else:
            updates[attr] = str(value)
    merged = replace(config, **updates)  # type: ignore[arg-type]
    # Re-apply the same clamps from_env enforces.
    merged.confidence = min(1.0, max(0.0, merged.confidence))
    merged.fps = min(30.0, max(0.1, merged.fps))
    merged.dedupe_sec = min(300.0, max(0.0, merged.dedupe_sec))
    if merged.detector not in _KNOWN_DETECTORS:
        merged.detector = DEFAULT_DETECTOR
    return merged
