"""
Runtime configuration — env-driven, pure (``from_env`` takes an explicit
mapping so it is trivially unit-tested; no heavy deps).

Two run modes (Wave-2 contract §"Assignment spawn"):

* WORKER — a single model bound to one room, spawned co-located by a per-app
  worker-manager OR by the edge supervisor. Config arrives as the env the
  master (or the manager) resolves:
    VISION_MODEL, VISION_APP, VISION_ROOM, VISION_HLS_URL, VISION_CONFIG_JSON
    (resolved per-stream settings), VISION_DEVICE, VISION_ENGINE (demography),
    VISION_MODEL_DIR, VISION_DB, VISION_SNAPSHOT_DIR, VISION_NODE_ID, VISION_TAGS.
  The delivery target is the framework EVENT channel: ``STREAMHUB_EVENTS_URL`` +
  ``STREAMHUB_INGEST_TOKEN`` when the framework/edge resolver injects them
  (edge assignments carry these), falling back to the legacy ``VISION_EVENTS_URL``
  / ``VISION_INGEST_TOKEN`` for compat. The model-specific schema (zones / lines
  / demography) lives INSIDE ``config`` (parsed from VISION_CONFIG_JSON) and each
  model parses its own.

* EDGE — a long-lived daemon that dials the master's edge WS out and
  supervises worker children. Config:
    STREAMHUB_EDGE_WS_URL, STREAMHUB_CLUSTER_TOKEN, STREAMHUB_NODE_ID,
    VISION_EDGE_ALLOW_REBOOT, VISION_EDGE_LOG, VISION_EDGE_PYTHON,
    VISION_EDGE_CAPABILITIES.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Mapping

MODELS = ("occupancy", "counting", "crowd", "demography")


def _str(env: Mapping[str, str], key: str, default: str = "") -> str:
    return (env.get(key) or default).strip()


def _bool(env: Mapping[str, str], key: str, default: bool = False) -> bool:
    v = (env.get(key) or "").strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "on")


def _float(env: Mapping[str, str], key: str, default: float) -> float:
    raw = (env.get(key) or "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        return default


def parse_config_json(raw: str | None) -> dict[str, Any]:
    """Parse VISION_CONFIG_JSON into a dict. Tolerant: bad/empty/non-object
    input yields ``{}`` so a malformed config can never crash startup (the
    model then runs on its own defaults)."""
    if not raw or not raw.strip():
        return {}
    try:
        obj = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return {}
    return obj if isinstance(obj, dict) else {}


def parse_models(raw: str | None) -> list[str]:
    """VISION_MODELS is a JSON array or comma list of model ids → the ordered,
    de-duplicated subset that are KNOWN models (unknown ids dropped). Drives the
    shared-capture multiplex worker (one decode loop, these N model consumers)."""
    out: list[str] = []
    for tok in parse_tags(raw):
        m = tok.strip().lower()
        if m in MODELS and m not in out:
            out.append(m)
    return out


def parse_tags(raw: str | None) -> list[str]:
    """VISION_TAGS is either a JSON array or a comma list of tag slugs."""
    if not raw or not raw.strip():
        return []
    raw = raw.strip()
    if raw.startswith("["):
        try:
            arr = json.loads(raw)
            if isinstance(arr, list):
                return [str(t).strip() for t in arr if str(t).strip()]
        except (json.JSONDecodeError, ValueError):
            pass
    return [t.strip() for t in raw.split(",") if t.strip()]


@dataclass
class WorkerConfig:
    """One model × one room. ``config`` holds the resolved per-stream settings
    (zones/lines/demography); models parse their own slice of it."""

    model: str
    app: str
    room: str
    hls_url: str = ""
    events_url: str = ""
    ingest_token: str = ""
    device: str = "cpu"          # 'cpu' | 'cuda'
    engine: str = "local"        # demography engine: 'local' | 'openai' | 'deepseek'
    model_dir: str = ""          # shared YOLO/InsightFace weight cache
    db_path: str = ""
    snapshot_dir: str = ""
    node_id: str = ""
    tags: list[str] = field(default_factory=list)
    config: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "WorkerConfig":
        e = os.environ if env is None else env
        model = _str(e, "VISION_MODEL").lower()
        if model not in MODELS:
            model = "occupancy"
        device = _str(e, "VISION_DEVICE", "cpu").lower()
        if device not in ("cpu", "cuda"):
            device = "cpu"
        app = _str(e, "VISION_APP")
        room = _str(e, "VISION_ROOM")
        hls_url = _str(e, "VISION_HLS_URL")
        if not hls_url:
            # Derive from the public base (the presence/perimeter worker pattern:
            # the spawn passes VISION_PUBLIC_BASE and the worker builds the URL).
            # Explicit VISION_HLS_URL always wins.
            base = _str(e, "VISION_PUBLIC_BASE").rstrip("/")
            if base and app and room:
                hls_url = f"{base}/hls/{app}/{room}/index.m3u8"
        return cls(
            model=model,
            app=app,
            room=room,
            hls_url=hls_url,
            # Prefer the framework EVENT channel (edge assignments + the local
            # worker-hook inject STREAMHUB_*); fall back to the legacy VISION_*
            # so a directly-spawned worker still delivers.
            events_url=_str(e, "STREAMHUB_EVENTS_URL") or _str(e, "VISION_EVENTS_URL"),
            ingest_token=_str(e, "STREAMHUB_INGEST_TOKEN") or _str(e, "VISION_INGEST_TOKEN"),
            device=device,
            engine=_str(e, "VISION_ENGINE", "local").lower() or "local",
            model_dir=_str(e, "VISION_MODEL_DIR"),
            db_path=_str(e, "VISION_DB"),
            snapshot_dir=_str(e, "VISION_SNAPSHOT_DIR"),
            node_id=_str(e, "VISION_NODE_ID"),
            tags=parse_tags(e.get("VISION_TAGS")),
            config=parse_config_json(e.get("VISION_CONFIG_JSON")),
        )

    def validate(self) -> list[str]:
        problems: list[str] = []
        if not self.app:
            problems.append("VISION_APP is required")
        if not self.room:
            problems.append("VISION_ROOM is required")
        if not self.hls_url:
            problems.append("VISION_HLS_URL is required")
        return problems

    def base_payload(self) -> dict[str, Any]:
        """The common envelope fields every event carries (Wave-2 contract:
        {app, room, tags, nodeId, model, ts} + specifics)."""
        return {
            "app": self.app,
            "room": self.room,
            "tags": list(self.tags),
            "nodeId": self.node_id,
            "model": self.model,
        }

    def snapshot_path(self, name: str) -> str:
        base = self.snapshot_dir or os.path.join(
            os.path.expanduser("~"), ".cache", "streamhub", "vision", "snapshots"
        )
        return os.path.join(base, name)


@dataclass
class ModelSpec:
    """One model consumer of a shared source: its resolved per-stream config plus
    its OWN delivery target (the four vision models are SEPARATE apps, each with
    its own events endpoint + scoped ingest token — so a shared-capture process
    routes each model's detections to the right app)."""

    config: dict[str, Any] = field(default_factory=dict)
    events_url: str = ""
    ingest_token: str = ""
    app: str = ""


@dataclass
class MultiplexConfig:
    """SHARED-CAPTURE worker: N model consumers on ONE source (one decode loop).

    Built from the same env a single ``worker`` gets (room / hls / device /
    model_dir …) plus:
      - ``VISION_MODELS``          — the model ids sharing this source (>=2 makes
        sharing worthwhile; 1 is valid and behaves like a single worker);
      - ``VISION_MULTIPLEX_JSON``  — a ``{model: {config, eventsUrl, ingestToken,
        app}}`` map: each model's resolved per-stream settings (zones / lines /
        roi / pois) AND its own app's delivery target (each vision model is its
        own app). Missing keys fall back to the base worker env;
      - ``VISION_DECODE_FPS``      — the per-source decode cap (0 = uncapped; the
        source is decoded ONCE at this rate and every model down-samples it).

    ``for_model(m)`` derives the ordinary :class:`WorkerConfig` each model
    consumer runs with, so the multiplex reuses every existing model engine
    unchanged — only the decode + HLS pull are shared.
    """

    base: WorkerConfig
    models: list[str] = field(default_factory=list)
    specs: dict[str, ModelSpec] = field(default_factory=dict)
    decode_fps: float = 0.0

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "MultiplexConfig":
        e = os.environ if env is None else env
        base = WorkerConfig.from_env(e)
        models = parse_models(e.get("VISION_MODELS"))
        # Fold in an EXPLICIT VISION_MODEL (WorkerConfig defaults it to occupancy,
        # so read the env directly to avoid a phantom occupancy consumer).
        explicit = _str(e, "VISION_MODEL").lower()
        if explicit in MODELS and explicit not in models:
            models = [explicit, *models]
        raw = parse_config_json(e.get("VISION_MULTIPLEX_JSON"))
        specs: dict[str, ModelSpec] = {}
        for m in models:
            slot = raw.get(m)
            if isinstance(slot, dict):
                cfg = slot.get("config")
                specs[m] = ModelSpec(
                    config=cfg if isinstance(cfg, dict) else {},
                    events_url=str(slot.get("eventsUrl") or "").strip(),
                    ingest_token=str(slot.get("ingestToken") or "").strip(),
                    app=str(slot.get("app") or "").strip(),
                )
            else:
                specs[m] = ModelSpec()
        return cls(
            base=base,
            models=models,
            specs=specs,
            decode_fps=_float(e, "VISION_DECODE_FPS", 0.0),
        )

    def validate(self) -> list[str]:
        problems = list(self.base.validate())
        if not self.models:
            problems.append("VISION_MODELS must name at least one known model")
        return problems

    def for_model(self, model: str) -> WorkerConfig:
        """The per-model :class:`WorkerConfig` for one consumer of the shared
        stream — the shared context (room / hls / device / model_dir) merged with
        THIS model's own resolved config + delivery target (falling back to the
        base worker env when a spec field is absent)."""
        b = self.base
        spec = self.specs.get(model, ModelSpec())
        return WorkerConfig(
            model=model,
            app=spec.app or b.app,
            room=b.room,
            hls_url=b.hls_url,
            events_url=spec.events_url or b.events_url,
            ingest_token=spec.ingest_token or b.ingest_token,
            device=b.device,
            engine=b.engine,
            model_dir=b.model_dir,
            db_path=b.db_path,
            snapshot_dir=b.snapshot_dir,
            node_id=b.node_id,
            tags=list(b.tags),
            config=dict(spec.config),
        )


@dataclass
class EdgeConfig:
    """Edge daemon: dial the master WS out and supervise worker children."""

    ws_url: str
    cluster_token: str
    node_id: str
    allow_reboot: bool = False
    log_path: str = ""
    python_bin: str = ""
    capabilities: list[str] = field(default_factory=list)
    telemetry_interval: float = 15.0
    # Force-reconnect if no master frame arrives for this long (half-open guard,
    # default 2× the master's 15s ping). 0 disables. VISION_EDGE_WS_IDLE_TIMEOUT.
    ws_idle_timeout: float = 30.0
    # App-versioning bundle cache root — where pinned appstore versions are
    # downloaded, verified and extracted. VISION_EDGE_APPSTORE_DIR overrides.
    appstore_dir: str = ""

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "EdgeConfig":
        e = os.environ if env is None else env
        return cls(
            ws_url=derive_ws_url(e),
            cluster_token=_str(e, "STREAMHUB_CLUSTER_TOKEN"),
            node_id=_str(e, "STREAMHUB_NODE_ID"),
            allow_reboot=_bool(e, "VISION_EDGE_ALLOW_REBOOT", False),
            log_path=_str(e, "VISION_EDGE_LOG"),
            python_bin=_str(e, "VISION_EDGE_PYTHON") or _default_python(),
            capabilities=parse_tags(e.get("VISION_EDGE_CAPABILITIES"))
            or ["vision", "yolo"],
            ws_idle_timeout=_float(e, "VISION_EDGE_WS_IDLE_TIMEOUT", 30.0),
            appstore_dir=_default_appstore_dir(e),
        )

    def validate(self) -> list[str]:
        problems: list[str] = []
        if not self.ws_url:
            problems.append("STREAMHUB_EDGE_WS_URL is required")
        if not self.cluster_token:
            problems.append("STREAMHUB_CLUSTER_TOKEN is required")
        if not self.node_id:
            problems.append("STREAMHUB_NODE_ID is required")
        return problems


def _default_python() -> str:
    import sys

    return sys.executable or "python3"


def _default_appstore_dir(env: Mapping[str, str] | None = None) -> str:
    """Bundle cache root: ``VISION_EDGE_APPSTORE_DIR`` or ``~/.streamhub/appstore``
    (``~`` expanded). Mirrors ``appstore.appstore_base_dir`` — kept here so
    ``EdgeConfig`` is the single source the WS client reads."""
    e = os.environ if env is None else env
    raw = _str(e, "VISION_EDGE_APPSTORE_DIR")
    return os.path.expanduser(raw or os.path.join("~", ".streamhub", "appstore"))


def derive_ws_url(env: Mapping[str, str] | None = None) -> str:
    """Resolve the edge control-channel WS URL.

    Prefer an explicit ``STREAMHUB_EDGE_WS_URL``; otherwise derive it from the
    installer-written ``STREAMHUB_MASTER_URL`` (``edge.env``) — swap the scheme
    to ws/wss and append the gateway path if it is a bare origin. So the
    installer's ``edge.env`` (which sets ``STREAMHUB_MASTER_URL``) works with no
    extra config.
    """
    e = os.environ if env is None else env
    explicit = _str(e, "STREAMHUB_EDGE_WS_URL")
    if explicit:
        return explicit
    master = _str(e, "STREAMHUB_MASTER_URL")
    if not master:
        return ""
    base = master.rstrip("/")
    if base.startswith("https://"):
        base = "wss://" + base[len("https://") :]
    elif base.startswith("http://"):
        base = "ws://" + base[len("http://") :]
    if not base.endswith("/api/v1/edge/ws"):
        base = base + "/api/v1/edge/ws"
    return base


def detect_mode(env: Mapping[str, str] | None = None) -> str:
    """Decide the run mode from the environment when no --mode flag is given:
    an edge WS/master URL present ⇒ ``edge``; otherwise ``worker``."""
    return "edge" if derive_ws_url(env) else "worker"
