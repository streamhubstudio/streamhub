"""CLI dispatch — arg parsing + mode resolution (pure; no process spawn)."""
from __future__ import annotations

from vision_edge.cli import build_parser, resolve_mode, worker_models


def _args(argv):
    return build_parser().parse_args(argv)


class TestParser:
    def test_parses_worker_manager_with_model(self):
        a = _args(["--mode", "worker-manager", "--model", "counting", "--app", "live"])
        assert a.mode == "worker-manager"
        assert a.model == "counting"
        assert a.app == "live"

    def test_parses_edge_worker(self):
        a = _args(["--model", "occupancy", "--room", "door"])
        assert a.mode is None
        assert a.model == "occupancy"
        assert a.room == "door"

    def test_edge_flag(self):
        assert _args(["--edge"]).edge is True

    def test_model_defaults_to_none(self):
        assert _args([]).model is None


class TestResolveMode:
    def test_explicit_worker_manager(self):
        args = _args(["--mode", "worker-manager", "--model", "occupancy", "--app", "live"])
        assert resolve_mode(args, {}) == "worker-manager"

    def test_edge_flag_and_mode(self):
        assert resolve_mode(_args(["--edge"]), {}) == "edge"
        assert resolve_mode(_args(["--mode", "edge"]), {}) == "edge"

    def test_explicit_worker(self):
        assert resolve_mode(_args(["--mode", "worker", "--model", "crowd"]), {}) == "worker"

    def test_edge_worker_env_resolves_to_worker_not_daemon(self):
        # Core spawns an edge worker as `--model X --room Y` with VISION_MODE=edge
        # but NO master/WS url — it must run as a single-room worker, NOT the
        # daemon (which would try to dial a control channel).
        args = _args(["--model", "occupancy", "--room", "door"])
        env = {"VISION_MODE": "edge", "STREAMHUB_EVENTS_URL": "http://m/api/v1/apps/live/plugins/occupancy/events"}
        assert resolve_mode(args, env) == "worker"

    def test_daemon_env_resolves_to_edge(self):
        assert resolve_mode(_args([]), {"STREAMHUB_MASTER_URL": "https://m"}) == "edge"
        assert resolve_mode(_args([]), {"STREAMHUB_EDGE_WS_URL": "wss://m/edge/ws"}) == "edge"

    def test_default_is_worker(self):
        assert resolve_mode(_args([]), {}) == "worker"

    def test_colocated_template_env_resolves_to_worker_manager(self):
        # The core spawns the co-located app as `-m vision_edge --model X`
        # (no --mode) with VISION_MODE=worker-manager from the manifest env.
        args = _args(["--model", "occupancy"])
        assert resolve_mode(args, {"VISION_MODE": "worker-manager", "VISION_ROOM": ""}) == "worker-manager"
        assert resolve_mode(args, {"VISION_MODE": " Worker-Manager "}) == "worker-manager"

    def test_vision_mode_worker_manager_beats_ws_inference(self):
        env = {"VISION_MODE": "worker-manager", "STREAMHUB_MASTER_URL": "https://m"}
        assert resolve_mode(_args(["--model", "crowd"]), env) == "worker-manager"

    def test_explicit_flags_beat_vision_mode(self):
        env = {"VISION_MODE": "worker-manager"}
        assert resolve_mode(_args(["--mode", "worker", "--model", "crowd"]), env) == "worker"
        assert resolve_mode(_args(["--edge"]), env) == "edge"

    def test_vision_mode_worker_manager_with_room_stays_worker(self):
        # a single-room spawn (--room) is a worker even if the env says manager
        args = _args(["--model", "occupancy", "--room", "door"])
        assert resolve_mode(args, {"VISION_MODE": "worker-manager"}) == "worker"

    def test_unknown_vision_mode_falls_back_to_inference(self):
        assert resolve_mode(_args([]), {"VISION_MODE": "bogus"}) == "worker"
        assert resolve_mode(_args([]), {"VISION_MODE": "worker"}) == "worker"

    def test_manifest_colocated_spawn_resolves_to_worker_manager(self):
        # Render each app's real worker template the way the core does for a
        # co-located (no originUrl) spawn and check the mode it lands in.
        import json
        import pathlib
        import shlex

        apps = pathlib.Path(__file__).resolve().parents[2] / "apps"
        for manifest in sorted(apps.glob("*/streamhub.app.json")):
            w = json.loads(manifest.read_text())["worker"]
            argv = shlex.split(w["entry"].replace("{{pluginPython}}", "python3"))
            assert argv[1:3] == ["-m", "vision_edge"], manifest
            mode_tmpl = w["env"]["VISION_MODE"]
            assert mode_tmpl == "{{ originUrl | ternary:edge:worker-manager }}", manifest
            env = {"VISION_MODE": "worker-manager", "VISION_ROOM": ""}
            assert resolve_mode(_args(argv[3:]), env) == "worker-manager", manifest


class TestWorkerModels:
    def test_parses_models_flag(self):
        a = _args(["--models", "occupancy,counting", "--room", "door"])
        assert a.models == "occupancy,counting"
        assert worker_models(a, {}) == ["occupancy", "counting"]

    def test_single_model_is_a_one_element_set(self):
        # A lone --model stays single (no multiplex) — the run path is unchanged.
        assert worker_models(_args(["--model", "occupancy"]), {}) == ["occupancy"]

    def test_folds_model_into_models(self):
        a = _args(["--models", "counting,crowd", "--model", "occupancy"])
        assert worker_models(a, {}) == ["occupancy", "counting", "crowd"]

    def test_reads_env_when_flag_absent(self):
        assert worker_models(_args([]), {"VISION_MODELS": "crowd, demography"}) == ["crowd", "demography"]

    def test_unknown_models_dropped(self):
        assert worker_models(_args(["--models", "occupancy,bogus"]), {}) == ["occupancy"]
