"""Supervisor — restart caps/backoff + assignment lifecycle (fake process)."""
import sys

from vision_edge.supervisor import (
    AssignmentSupervisor,
    RestartTracker,
    build_child_argv,
    build_child_cwd,
    build_child_env,
    edge_interpreter,
    is_python_interpreter,
    rewrite_interpreter,
)


class FakeProc:
    def __init__(self):
        self._code = None      # None = running
        self.terminated = False

    def poll(self):
        return self._code

    def terminate(self):
        self.terminated = True
        self._code = -15

    def die(self, code=1):
        self._code = code


class Spawner:
    def __init__(self):
        self.calls = []
        self.procs = []
        self.cwds = []

    def __call__(self, argv, env, cwd=None):
        p = FakeProc()
        self.calls.append((argv, env))
        self.cwds.append(cwd)
        self.procs.append(p)
        return p


class StatusLog:
    def __init__(self):
        self.events = []

    def __call__(self, aid, status, detail=None):
        self.events.append((aid, status, detail))


# -- RestartTracker ---------------------------------------------------------

def test_restart_tracker_window_and_cap():
    t = RestartTracker(max_restarts=3, window=100.0)
    assert t.allowed(0.0) is True
    t.record(0.0)
    t.record(10.0)
    t.record(20.0)
    assert t.count(20.0) == 3
    assert t.allowed(20.0) is False
    # After the window slides past the early events, capacity returns.
    assert t.count(150.0) == 0
    assert t.allowed(150.0) is True


def test_restart_tracker_backoff_grows():
    t = RestartTracker()
    assert t.backoff(0.0) == 0.0
    t.record(0.0)
    assert t.backoff(0.0) == 2.0     # 2*2^0
    t.record(1.0)
    assert t.backoff(1.0) == 4.0     # 2*2^1
    for i in range(10):
        t.record(2.0)
    assert t.backoff(2.0) == 60.0    # capped


# -- interpreter rewrite (F4a) ----------------------------------------------

def test_rewrite_interpreter_matrix():
    exe = "/edge/.venv/bin/python"
    # A bare python3 → the edge's own interpreter (the master resolved python3
    # for ITS box; a venv edge must run its own).
    assert rewrite_interpreter("python3", exe) == exe
    # A versioned absolute path is still a python basename → rewritten.
    assert rewrite_interpreter("/usr/bin/python3.12", exe) == exe
    # A custom master PLUGIN_PYTHON venv path (python basename) → rewritten.
    assert rewrite_interpreter("/opt/master/.venv/bin/python", exe) == exe
    # A non-python command is a generic worker host → left verbatim.
    assert rewrite_interpreter("node", exe) == "node"
    assert rewrite_interpreter("/usr/bin/ffmpeg", exe) == "/usr/bin/ffmpeg"
    # VISION_EDGE_PYTHON override wins over sys.executable — but only for python.
    assert rewrite_interpreter("python3", exe, "/custom/py") == "/custom/py"
    assert rewrite_interpreter("node", exe, "/custom/py") == "node"


def test_is_python_interpreter():
    for good in ("python", "python3", "python3.12", "/usr/bin/python3", "  python3  "):
        assert is_python_interpreter(good) is True
    for bad in ("", "node", "pythonic", "ffmpeg", "/opt/bin/my-python-tool"):
        assert is_python_interpreter(bad) is False


# -- build helpers ----------------------------------------------------------

def test_build_child_argv_from_spawn_spec():
    a = {"id": "x", "spawn": {"command": "python3", "args": ["-m", "vision_edge", "--model", "occupancy"]}}
    # argv[0] is localized to the edge's interpreter; args stay verbatim.
    assert build_child_argv(a, env={}) == [sys.executable, "-m", "vision_edge", "--model", "occupancy"]


def test_build_child_argv_rewrites_to_override():
    a = {"id": "x", "spawn": {"command": "python3", "args": ["-m", "vision_edge"]}}
    assert build_child_argv(a, env={"VISION_EDGE_PYTHON": "/e/py"}) == ["/e/py", "-m", "vision_edge"]


def test_build_child_argv_fallback():
    a = {"id": "x", "app": "live", "streamId": "door", "config": {"model": "counting"}}
    argv = build_child_argv(a, env={})
    assert argv[:5] == [sys.executable, "-m", "vision_edge", "--model", "counting"]
    assert "--app" in argv and "live" in argv and "door" in argv


def test_build_child_env_merges():
    env = build_child_env({"spawn": {"env": {"VISION_MODEL": "crowd"}}}, {"PATH": "/bin"})
    assert env["PATH"] == "/bin" and env["VISION_MODEL"] == "crowd"


def test_build_child_argv_pluginid_agnostic():
    # The master now sends pluginId 'occupancy'/'counting'/'crowd'/'demography'
    # instead of 'vision'; the supervisor ignores pluginId and runs the
    # master-resolved spawn block verbatim EXCEPT for the localized interpreter.
    a = {
        "id": "cam1::occupancy",
        "pluginId": "occupancy",
        "app": "live",
        "streamId": "cam1",
        "spawn": {"command": "python3", "args": ["-m", "vision_edge", "--model", "occupancy", "--room", "cam1"]},
    }
    assert build_child_argv(a, env={}) == [sys.executable, "-m", "vision_edge", "--model", "occupancy", "--room", "cam1"]


def test_build_child_cwd_only_when_spawn_sets_it():
    # A normal assignment carries no cwd → child inherits the daemon's cwd.
    assert build_child_cwd({"id": "a1"}) is None
    assert build_child_cwd({"spawn": {"command": "python3"}}) is None
    assert build_child_cwd({"spawn": {"cwd": ""}}) is None
    # A pinned-bundle redirect sets cwd to the extracted dir → honored.
    assert build_child_cwd({"spawn": {"cwd": "/cache/lpr/2.9.0/extracted/lpr/worker"}}) == (
        "/cache/lpr/2.9.0/extracted/lpr/worker"
    )


def test_launch_passes_spawn_cwd_to_process():
    sp, st, clk = Spawner(), StatusLog(), {"t": 0.0}
    sup = _sup(sp, st, clk)
    sup.assign({"id": "a1", "spawn": {"command": "python3", "cwd": "/pin/dir"}})
    assert sp.cwds == ["/pin/dir"]
    # A pin-less assignment passes cwd=None (today's behavior — no regression).
    sup.assign({"id": "a2", "spawn": {"command": "python3"}})
    assert sp.cwds[-1] is None


# -- lifecycle --------------------------------------------------------------

def _sup(spawn, status, clk):
    return AssignmentSupervisor(spawn=spawn, on_status=status, clock=lambda: clk["t"])


def test_assign_launches_and_reports_running():
    sp, st, clk = Spawner(), StatusLog(), {"t": 0.0}
    sup = _sup(sp, st, clk)
    sup.assign({"id": "a1", "app": "live"})
    assert sup.status_of("a1") == "running"
    assert ("a1", "running", None) in st.events
    assert len(sp.calls) == 1


def test_clean_exit_marks_stopped_and_removes():
    sp, st, clk = Spawner(), StatusLog(), {"t": 0.0}
    sup = _sup(sp, st, clk)
    sup.assign({"id": "a1"})
    sp.procs[0].die(0)
    clk["t"] = 1.0
    sup.reap()
    assert sup.status_of("a1") is None      # removed
    assert ("a1", "stopped", "exited cleanly") in st.events


def test_crash_restarts_within_cap():
    sp, st, clk = Spawner(), StatusLog(), {"t": 0.0}
    sup = _sup(sp, st, clk)
    sup.assign({"id": "a1"})
    sp.procs[0].die(1)
    clk["t"] = 1.0
    sup.reap()                              # first restart is immediate
    assert len(sp.calls) == 2
    assert sup.status_of("a1") == "running"


def test_backoff_gates_second_restart():
    sp, st, clk = Spawner(), StatusLog(), {"t": 0.0}
    sup = _sup(sp, st, clk)
    sup.assign({"id": "a1"})
    sp.procs[0].die(1)
    clk["t"] = 1.0
    sup.reap()                              # restart #1, backoff → restart_at=3
    sp.procs[1].die(1)
    clk["t"] = 2.0
    sup.reap()                              # within backoff → no relaunch
    assert len(sp.calls) == 2
    clk["t"] = 3.0
    sup.reap()                              # backoff elapsed → relaunch
    assert len(sp.calls) == 3


def test_restart_cap_gives_up():
    sp, st, clk = Spawner(), StatusLog(), {"t": 0.0}
    sup = AssignmentSupervisor(spawn=sp, on_status=st, clock=lambda: clk["t"], max_restarts=3)
    sup.assign({"id": "a1"})
    # Crash-and-advance past each backoff 4 times.
    times = [1.0, 3.0, 7.0, 16.0]
    for i, t in enumerate(times):
        sp.procs[-1].die(1)
        clk["t"] = t
        sup.reap()
    assert len(sp.calls) == 4               # initial + 3 restarts, then give up
    assert sup.status_of("a1") == "failed"
    assert any("restart cap reached" in (d or "") for _, s, d in st.events if s == "failed")


def test_revoke_terminates_and_reports_stopped():
    sp, st, clk = Spawner(), StatusLog(), {"t": 0.0}
    sup = _sup(sp, st, clk)
    sup.assign({"id": "a1"})
    proc = sp.procs[0]
    sup.revoke("a1")
    assert proc.terminated is True
    assert sup.status_of("a1") is None
    assert ("a1", "stopped", "revoked") in st.events


def test_reassign_replaces_child():
    sp, st, clk = Spawner(), StatusLog(), {"t": 0.0}
    sup = _sup(sp, st, clk)
    sup.assign({"id": "a1", "config": {"model": "occupancy"}})
    first = sp.procs[0]
    sup.assign({"id": "a1", "config": {"model": "counting"}})
    assert first.terminated is True
    assert len(sp.calls) == 2
    assert sup.active_ids() == ["a1"]


def test_stop_all():
    sp, st, clk = Spawner(), StatusLog(), {"t": 0.0}
    sup = _sup(sp, st, clk)
    sup.assign({"id": "a1"})
    sup.assign({"id": "a2"})
    sup.stop_all()
    assert sup.active_ids() == []
    assert all(p.terminated for p in sp.procs)


def test_assign_runs_pluginid_agnostic_spawn_verbatim():
    # A full assign of an 'occupancy' edge assignment (pluginId != 'vision')
    # spawns the resolved args + env verbatim — the supervisor never keys off
    # pluginId, so the vision→4-apps rename is transparent to the edge daemon.
    # Only argv[0] (the interpreter) is localized to this edge.
    sp, st, clk = Spawner(), StatusLog(), {"t": 0.0}
    sup = _sup(sp, st, clk)
    spawn = {
        "command": "python3",
        "args": ["-m", "vision_edge", "--model", "occupancy", "--room", "door"],
        "env": {"STREAMHUB_PLUGIN_ID": "occupancy", "STREAMHUB_EVENTS_URL": "http://m/events"},
    }
    sup.assign({"id": "a1", "pluginId": "occupancy", "app": "live", "streamId": "door", "spawn": spawn})
    assert sup.status_of("a1") == "running"
    argv, env = sp.calls[0]
    assert argv == [edge_interpreter(), "-m", "vision_edge", "--model", "occupancy", "--room", "door"]
    assert env["STREAMHUB_PLUGIN_ID"] == "occupancy"
    assert env["STREAMHUB_EVENTS_URL"] == "http://m/events"


def test_edge_child_base_env_drops_secrets_and_sets_node_id():
    from vision_edge.supervisor import edge_child_base_env

    env = edge_child_base_env(
        {"PATH": "/usr/bin", "HOME": "/h", "LC_ALL": "C.UTF-8", "STREAMHUB_CLUSTER_TOKEN": "t",
         "STREAMHUB_NODE_ID": "edge-1", "VISION_EDGE_PYTHON": "/v/bin/python"},
        "edge-1",
    )
    assert env == {"PATH": "/usr/bin", "HOME": "/h", "LC_ALL": "C.UTF-8",
                   "VISION_EDGE_PYTHON": "/v/bin/python", "VISION_NODE_ID": "edge-1"}


def test_supervisor_children_get_path_home_and_node_id():
    from vision_edge.supervisor import edge_child_base_env

    seen = {}

    class P:
        def poll(self):
            return None

        def terminate(self):
            pass

    def spawn(argv, env, cwd=None):
        seen.update(env)
        return P()

    statuses = []
    sup = AssignmentSupervisor(
        spawn=spawn,
        on_status=lambda a, s, d=None: statuses.append((a, s)),
        base_env=edge_child_base_env({"PATH": "/bin", "HOME": "/h", "STREAMHUB_CLUSTER_TOKEN": "x"}, "n1"),
    )
    sup.assign({"id": "as1", "spawn": {"command": "/bin/true", "args": [], "env": {"STREAMHUB_INGEST_TOKEN": "k"}}})
    assert seen["PATH"] == "/bin" and seen["HOME"] == "/h" and seen["VISION_NODE_ID"] == "n1"
    assert seen["STREAMHUB_INGEST_TOKEN"] == "k" and "STREAMHUB_CLUSTER_TOKEN" not in seen
    assert statuses == [("as1", "running")]
