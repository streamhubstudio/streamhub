"""
CLI dispatch — ``python -m vision_edge`` runs one of three modes:

  worker         : a single model bound to one room (spawned by a per-app
                   worker-manager OR by the edge supervisor):
                     python -m vision_edge --model occupancy --room office
  worker-manager : the CO-LOCATED per-app manager — runs ONE model across all
                   the app's active rooms (spawned by the plugin worker
                   lifecycle, one per Studio App):
                     python -m vision_edge --mode worker-manager --model occupancy --app live
  edge           : the long-lived daemon that dials the master WS out and
                   supervises worker children:
                     python -m vision_edge --edge

The mode is chosen by ``--edge`` / ``--mode``; with neither, it is inferred
from the environment (a WS URL present ⇒ edge, else worker). ``worker-manager``
REQUIRES ``--model`` (or ``VISION_MODEL``). Config otherwise comes from the
environment (``config.py``). SIGTERM (how the core stops workers) becomes a
clean shutdown.
"""
from __future__ import annotations

import argparse
import signal
import sys

from .config import EdgeConfig, WorkerConfig, detect_mode


def _log(event: str, **fields) -> None:
    import json
    import time

    rec = {"ts": round(time.time(), 3), "event": event, **fields}
    sys.stdout.write(json.dumps(rec, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="vision_edge")
    p.add_argument("--mode", choices=("worker", "worker-manager", "edge"), default=None, help="Run mode (else inferred from env).")
    p.add_argument("--edge", action="store_true", help="Shortcut for --mode edge.")
    p.add_argument("--model", default=None, help="Worker model: occupancy|counting|crowd|demography (overrides VISION_MODEL).")
    p.add_argument("--models", default=None, help="Shared-capture: comma list of models to run off ONE decode loop for --room (overrides VISION_MODELS).")
    p.add_argument("--app", default=None, help="App slug (overrides VISION_APP).")
    p.add_argument("--room", default=None, help="Room/stream id (overrides VISION_ROOM).")
    return p


def resolve_mode(args, env=None) -> str:
    if args.edge or args.mode == "edge":
        return "edge"
    if args.mode == "worker-manager":
        return "worker-manager"
    if args.mode == "worker":
        return "worker"
    return detect_mode(env)


def worker_models(args, env=None) -> list[str]:
    """The model set a ``worker`` should run. ``--models`` (or VISION_MODELS)
    with >1 known model → a shared-capture multiplex (one decode, N consumers);
    otherwise the single ``--model`` (or VISION_MODEL). Pure — env injected."""
    import os

    from .config import parse_models

    e = os.environ if env is None else env
    models = parse_models(args.models if args.models is not None else e.get("VISION_MODELS"))
    single = (args.model or e.get("VISION_MODEL") or "").strip().lower()
    from .config import MODELS

    if single in MODELS and single not in models:
        models = [single, *models]
    return models


def run_worker(args) -> int:
    import os

    # Shared-capture path: >1 model on one source runs in ONE process.
    models = worker_models(args)
    if len(models) > 1:
        from .config import MultiplexConfig
        from .runtime import run_multiplex

        env = dict(os.environ)
        env["VISION_MODELS"] = ",".join(models)
        env.pop("VISION_MODEL", None)  # the set is authoritative now
        if args.app:
            env["VISION_APP"] = args.app
        if args.room:
            env["VISION_ROOM"] = args.room
        mux = MultiplexConfig.from_env(env)
        problems = mux.validate()
        if problems:
            for msg in problems:
                _log("config_error", message=msg)
            return 2
        return run_multiplex(mux)

    config = WorkerConfig.from_env()
    if args.model:
        config.model = args.model
    if args.app:
        config.app = args.app
    if args.room:
        config.room = args.room

    problems = config.validate()
    if problems:
        for msg in problems:
            _log("config_error", message=msg)
        return 2

    from .models import counting, crowd, demography, occupancy

    runners = {
        "occupancy": occupancy.run,
        "counting": counting.run,
        "crowd": crowd.run,
        "demography": demography.run,
    }
    runner = runners.get(config.model)
    if runner is None:
        _log("config_error", message=f"unknown model: {config.model}")
        return 2
    return runner(config)


def run_worker_manager(args) -> int:
    from .worker_manager import WorkerManagerConfig, run as _run_manager

    config = WorkerManagerConfig.from_env()
    if args.model:
        config.model = args.model.strip().lower()
    if args.app:
        config.app = args.app
    problems = config.validate()
    if problems:
        for msg in problems:
            _log("config_error", message=msg)
        return 2
    return _run_manager(config)


def run_edge(args) -> int:
    config = EdgeConfig.from_env()
    problems = config.validate()
    if problems:
        for msg in problems:
            _log("config_error", message=msg)
        return 2
    from .runtime import run_edge as _run_edge

    return _run_edge(config)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    def _term(signum, _frame):
        _log("signal", signal=int(signum))
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, _term)
    signal.signal(signal.SIGINT, _term)

    mode = resolve_mode(args)
    if mode == "edge":
        return run_edge(args)
    if mode == "worker-manager":
        return run_worker_manager(args)
    return run_worker(args)
