"""
Worker-manager — the CO-LOCATED (mono-node) run mode.

Since the ``vision`` plugin was split into four Studio Apps (occupancy /
counting / crowd / demography), the core spawns ONE worker-manager PER APP,
each bound to that app's single model:

  ``vision_edge --mode worker-manager --model <id> --app <app>``

Unlike the ``edge`` daemon it does NOT dial a master WS — there is no cluster.
Instead it:

  1. discovers the app's ACTIVE rooms by listing the on-disk HLS dir
     (``VISION_HLS_DIR/<room>/index.m3u8`` with a fresh mtime),
  2. runs the ONE model against each active room as a ``worker`` child, reusing
     {@link AssignmentSupervisor} for the exact same restart-cap/backoff
     lifecycle the edge path uses,
  3. reads each room's polygon/line settings straight from the app's per-model
     db ``<VISION_DATA_DIR>/<model>.db`` (stdlib sqlite3, read-only) — the db the
     core OWNS and its editor writes (table ``stream_settings(room, config_json)``,
     no model column) — so mono-node has full per-stream config with NO HTTP
     round-trip, and
  4. reconciles on a timer: rooms that go live get workers, rooms that go stale
     get their workers revoked.

The pure pieces (``discover_rooms``, ``read_stream_settings``,
``synthetic_assignment``, ``reconcile_plan``) are unit-tested with injected
IO; the loop is the thin impure shell.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Mapping

from .config import _str, parse_config_json
from .supervisor import AssignmentSupervisor

MODELS = ("occupancy", "counting", "crowd", "demography")

# A room whose playlist was written within this window is "active".
DEFAULT_FRESH_SECONDS = 30.0
# How often the manager re-scans the HLS dir for room churn.
DEFAULT_RESCAN_SECONDS = 15.0
# How often the supervisor reaps/restarts children.
DEFAULT_REAP_SECONDS = 2.0


@dataclass
class WorkerManagerConfig:
    """Co-located manager config (all from the meta's spawn env). One manager =
    one app = one model."""

    app: str
    model: str = ""
    hls_dir: str = ""
    data_dir: str = ""
    device: str = "cpu"
    fps: float = 3.5
    engine: str = "local"
    confidence: float = 0.35
    ai_api_key: str = ""
    model_dir: str = ""
    public_base: str = ""
    events_url: str = ""
    ingest_token: str = ""
    fresh_seconds: float = DEFAULT_FRESH_SECONDS
    rescan_seconds: float = DEFAULT_RESCAN_SECONDS
    python_bin: str = ""

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "WorkerManagerConfig":
        e = os.environ if env is None else env
        device = _str(e, "VISION_DEVICE", "cpu").lower()
        if device not in ("cpu", "cuda"):
            device = "cpu"
        try:
            fps = float(_str(e, "VISION_FPS", "3.5") or "3.5")
        except ValueError:
            fps = 3.5
        import sys

        return cls(
            app=_str(e, "VISION_APP"),
            model=_str(e, "VISION_MODEL").lower(),
            hls_dir=_str(e, "VISION_HLS_DIR"),
            data_dir=_str(e, "VISION_DATA_DIR"),
            device=device,
            fps=fps,
            engine=_str(e, "VISION_ENGINE", "local").lower() or "local",
            confidence=float(_str(e, "VISION_CONFIDENCE", "0.35") or "0.35"),
            ai_api_key=_str(e, "VISION_AI_API_KEY"),
            model_dir=_str(e, "VISION_MODEL_DIR"),
            public_base=_str(e, "VISION_PUBLIC_BASE"),
            # The framework injects these on start (worker lifecycle), exactly
            # like every other needsWorker plugin.
            events_url=_str(e, "STREAMHUB_EVENTS_URL"),
            ingest_token=_str(e, "STREAMHUB_INGEST_TOKEN"),
            python_bin=_str(e, "VISION_EDGE_PYTHON") or (sys.executable or "python3"),
        )

    def validate(self) -> list[str]:
        problems: list[str] = []
        if not self.app:
            problems.append("VISION_APP is required")
        if not self.model:
            problems.append(
                "VISION_MODEL (or --model) is required in worker-manager mode"
            )
        elif self.model not in MODELS:
            problems.append(
                f"unknown model: {self.model} (expected one of {', '.join(MODELS)})"
            )
        if not self.hls_dir and not self.public_base:
            problems.append("VISION_HLS_DIR or VISION_PUBLIC_BASE is required")
        return problems

    def db_path(self) -> str:
        """The app's per-model settings db the core owns: ``<data_dir>/<model>.db``
        (VISION_DATA_DIR is ``<appDir>/<model>``, so this resolves to
        ``<appDir>/<model>/<model>.db``)."""
        if not self.data_dir or not self.model:
            return ""
        return os.path.join(self.data_dir, f"{self.model}.db")

    def hls_url_for(self, room: str) -> str:
        """Prefer the on-disk playlist; fall back to the public base (the same
        disk-first / http-fallback rule the exported worker bundles use)."""
        if self.hls_dir:
            return os.path.join(self.hls_dir, room, "index.m3u8")
        base = self.public_base.rstrip("/")
        return f"{base}/hls/{self.app}/{room}/index.m3u8"


def discover_rooms(
    hls_dir: str,
    now: float,
    fresh_seconds: float = DEFAULT_FRESH_SECONDS,
    lister: Callable[[str], Iterable[str]] | None = None,
    mtime: Callable[[str], float] | None = None,
) -> list[str]:
    """Active rooms = subdirs of ``hls_dir`` whose ``index.m3u8`` was written
    within ``fresh_seconds``. IO is injected so this is pure under test."""
    if not hls_dir:
        return []
    _ls = lister or (lambda d: os.listdir(d) if os.path.isdir(d) else [])
    _mt = mtime or (lambda p: os.stat(p).st_mtime)
    rooms: list[str] = []
    for name in sorted(_ls(hls_dir)):
        pl = os.path.join(hls_dir, name, "index.m3u8")
        try:
            if now - _mt(pl) <= fresh_seconds:
                rooms.append(name)
        except (OSError, ValueError):
            continue
    return rooms


def read_stream_settings(
    db_path: str,
    room: str,
    connect: Callable[[str], Any] | None = None,
) -> dict[str, Any]:
    """Read the per-room resolved config the core persisted to the app's
    per-model db (table ``stream_settings(room TEXT PK, config_json TEXT,
    updated_at TEXT)`` — no model column: the db is already scoped to one model).
    Read-only, stdlib sqlite3, best-effort — a missing DB/row/column yields
    ``{}`` so a co-located worker always starts (on its own defaults). The
    runtime NEVER writes this db; the core owns it."""
    if not db_path:
        return {}

    def _default_connect(p: str) -> Any:
        import sqlite3

        return sqlite3.connect(f"file:{p}?mode=ro", uri=True)

    conn = None
    try:
        conn = (connect or _default_connect)(db_path)
        cur = conn.execute(
            "SELECT config_json FROM stream_settings WHERE room = ?",
            (room,),
        )
        row = cur.fetchone()
        if not row or not row[0]:
            return {}
        return parse_config_json(row[0])
    except Exception:  # noqa: BLE001 - any DB/parse issue → defaults
        return {}
    finally:
        try:
            if conn is not None:
                conn.close()
        except Exception:  # noqa: BLE001
            pass


def child_key(room: str, model: str) -> str:
    """Stable synthetic assignment id for a (room, model) child."""
    return f"{room}::{model}"


def synthetic_assignment(
    cfg: WorkerManagerConfig, room: str, settings: dict[str, Any]
) -> dict[str, Any]:
    """Build the supervisor assignment for a co-located (room, cfg.model) worker
    — the same shape the edge path produces, so the SAME supervisor runs it."""
    model = cfg.model
    env = {
        "PYTHONUNBUFFERED": "1",
        "VISION_APP": cfg.app,
        "VISION_ROOM": room,
        "VISION_MODEL": model,
        "VISION_HLS_URL": cfg.hls_url_for(room),
        "VISION_EVENTS_URL": cfg.events_url,
        "VISION_INGEST_TOKEN": cfg.ingest_token,
        "VISION_DEVICE": cfg.device,
        "VISION_ENGINE": cfg.engine,
        "VISION_FPS": str(cfg.fps),
        "VISION_CONFIDENCE": str(cfg.confidence),
        "VISION_DATA_DIR": cfg.data_dir,
        "VISION_DB": cfg.db_path(),
        "VISION_CONFIG_JSON": json.dumps(settings, ensure_ascii=False),
    }
    if cfg.model_dir:
        env["VISION_MODEL_DIR"] = cfg.model_dir
    # The AI key only rides along for the model that can use it, and only in
    # this LOCAL env — mono-node stays on this host (edge frames never carry it).
    if model == "demography" and cfg.ai_api_key:
        env["VISION_AI_API_KEY"] = cfg.ai_api_key
    return {
        "id": child_key(room, model),
        "app": cfg.app,
        "model": model,
        "streamId": room,
        "spawn": {
            "command": cfg.python_bin,
            "args": ["-m", "vision_edge", "--mode", "worker", "--model", model,
                     "--app", cfg.app, "--room", room],
            "env": env,
        },
    }


def reconcile_plan(
    desired: Iterable[str], current: Iterable[str]
) -> tuple[list[str], list[str]]:
    """(to_add, to_remove) child keys — pure set diff, deterministic order."""
    d = set(desired)
    c = set(current)
    return sorted(d - c), sorted(c - d)


def run(cfg: WorkerManagerConfig) -> int:
    """Co-located manager loop. Blocks until SIGTERM/KeyboardInterrupt."""
    import subprocess

    def _log(event: str, **fields: Any) -> None:
        rec = {"ts": round(time.time(), 3), "event": event, **fields}
        print(json.dumps(rec, ensure_ascii=False), flush=True)

    def _spawn(argv: list[str], env: dict[str, str], cwd: str | None = None) -> Any:
        merged = {**os.environ, **env}
        return subprocess.Popen(argv, env=merged, cwd=cwd or None)  # noqa: S603

    sup = AssignmentSupervisor(spawn=_spawn, base_env=dict(os.environ))
    _log("worker_manager_start", app=cfg.app, model=cfg.model, device=cfg.device)

    last_scan = 0.0
    try:
        while True:
            now = time.monotonic()
            if now - last_scan >= cfg.rescan_seconds:
                last_scan = now
                rooms = discover_rooms(cfg.hls_dir, time.time(), cfg.fresh_seconds)
                desired = {child_key(r, cfg.model): r for r in rooms}
                to_add, to_remove = reconcile_plan(desired.keys(), sup.active_ids())
                for key in to_add:
                    room = desired[key]
                    settings = read_stream_settings(cfg.db_path(), room)
                    sup.assign(synthetic_assignment(cfg, room, settings))
                    _log("worker_start", room=room, model=cfg.model)
                for key in to_remove:
                    sup.revoke(key)
                    _log("worker_stop", key=key)
            sup.reap()
            time.sleep(DEFAULT_REAP_SECONDS)
    except KeyboardInterrupt:
        _log("worker_manager_stop", app=cfg.app)
        sup.stop_all()
        return 0
