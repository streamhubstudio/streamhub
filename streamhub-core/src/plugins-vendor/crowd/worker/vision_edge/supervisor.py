"""
Assignment supervisor — the edge daemon IS the process manager. It runs one
child ``worker`` process per assignment (``python -m vision_edge --model … --app
… --room …`` with the resolved env) and restarts a crashed child with capped
backoff (Vision One watchdog cap: max 3 restarts/hour), reporting status
transitions back to the master over the WS channel.

The restart POLICY is pure (``RestartTracker``) and unit-tested; the spawn is
injected into ``AssignmentSupervisor`` so tests drive the full lifecycle
(assign → running → crash → restart → give-up → revoke) with a fake process,
no subprocess.
"""
from __future__ import annotations

import os
import re
import sys
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Deque, Mapping, Optional

# Vision One watchdog restart cap.
DEFAULT_MAX_RESTARTS = 3
DEFAULT_RESTART_WINDOW = 3600.0  # seconds (1 hour)
RESTART_BACKOFF_BASE = 2.0
RESTART_BACKOFF_CAP = 60.0


class RestartTracker:
    """Sliding-window restart limiter + backoff (pure).

    ``allowed(now)`` is True while fewer than ``max_restarts`` restarts have
    happened in the trailing ``window`` seconds. ``record(now)`` stamps a
    restart. ``backoff(now)`` grows 2,4,8…≤60 s with the count in-window.
    """

    def __init__(
        self,
        max_restarts: int = DEFAULT_MAX_RESTARTS,
        window: float = DEFAULT_RESTART_WINDOW,
    ) -> None:
        self.max_restarts = max(0, int(max_restarts))
        self.window = float(window)
        self._events: Deque[float] = deque()

    def _prune(self, now: float) -> None:
        cutoff = now - self.window
        while self._events and self._events[0] < cutoff:
            self._events.popleft()

    def count(self, now: float) -> int:
        self._prune(now)
        return len(self._events)

    def allowed(self, now: float) -> bool:
        return self.count(now) < self.max_restarts

    def record(self, now: float) -> None:
        self._prune(now)
        self._events.append(now)

    def backoff(self, now: float) -> float:
        n = self.count(now)
        if n <= 0:
            return 0.0
        return min(RESTART_BACKOFF_CAP, RESTART_BACKOFF_BASE * (2 ** (n - 1)))


@dataclass
class Child:
    """One supervised assignment."""

    assignment: dict[str, Any]
    process: Any = None
    status: str = "starting"  # starting|running|failed|stopped
    tracker: RestartTracker = field(default_factory=RestartTracker)
    restart_at: float = 0.0   # earliest time a restart may be attempted


# A python interpreter by BASENAME: python, python3, python3.12, python3.13…
# (optionally a Windows .exe). Matches regardless of the directory it lives in,
# so a master that resolved ``/opt/master/.venv/bin/python3.12`` is recognized
# the same as a bare ``python3``.
_PYTHON_BASENAME = re.compile(r"^python(\d+(\.\d+)?)?(\.exe)?$", re.IGNORECASE)


def is_python_interpreter(command: str) -> bool:
    """True when ``command`` names a python interpreter by basename.

    The master resolves ``PLUGIN_PYTHON ?? 'python3'`` for ITS box, so the
    ``spawn.command`` it hands the edge is a python interpreter path/name that is
    almost always wrong for a venv-based edge. This detects that case (any
    ``python`` / ``python3`` / ``python3.x`` basename) so the edge can substitute
    its OWN interpreter, while leaving a generic worker command (``node``,
    ``/usr/bin/ffmpeg``, a custom host) untouched.
    """
    if not command:
        return False
    return bool(_PYTHON_BASENAME.match(os.path.basename(command.strip())))


def rewrite_interpreter(
    command: str, sys_executable: str, env_python: str | None = None
) -> str:
    """Rewrite a spawn ``command`` to the interpreter the EDGE should use.

    A python interpreter (see {@link is_python_interpreter}) is replaced with —
    in priority order — an explicit ``VISION_EDGE_PYTHON`` (``env_python``), then
    the running interpreter (``sys_executable``); anything else is returned
    verbatim (generic worker-host contract). Pure: the caller injects
    ``sys.executable`` and the override so the matrix is unit-testable.
    """
    if not is_python_interpreter(command):
        return command
    override = (env_python or "").strip()
    return override or sys_executable or command


def edge_interpreter(env: Mapping[str, str] | None = None) -> str:
    """The interpreter THIS edge runs python children with: an explicit
    ``VISION_EDGE_PYTHON`` wins, else ``sys.executable``, else ``python3``."""
    e = os.environ if env is None else env
    return rewrite_interpreter("python3", sys.executable, e.get("VISION_EDGE_PYTHON"))


def build_child_argv(
    assignment: dict[str, Any], env: Mapping[str, str] | None = None
) -> list[str]:
    """The worker command line for an assignment's resolved spawn spec.

    Prefers the master-resolved ``spawn`` block (command + args); falls back to
    ``python -m vision_edge --model … --app … --room …`` derived from the
    assignment fields when no spawn spec is present.

    ``argv[0]`` is rewritten to the edge's own python interpreter when the
    master resolved a python command (F4 field-test fix — a venv edge must not
    run the master's ``python3``); ``VISION_EDGE_PYTHON`` overrides. Args and a
    non-python command are kept verbatim.
    """
    e = os.environ if env is None else env
    interp = e.get("VISION_EDGE_PYTHON")
    spawn = assignment.get("spawn")
    if isinstance(spawn, dict) and spawn.get("command"):
        args = spawn.get("args") or []
        argv = [str(spawn["command"]), *[str(a) for a in args]]
    else:
        cfg = assignment.get("config") or {}
        model = cfg.get("model") or assignment.get("model") or "occupancy"
        argv = ["python3", "-m", "vision_edge", "--model", str(model), "--app", str(assignment.get("app", ""))]
        room = assignment.get("streamId") or assignment.get("room")
        if room:
            argv += ["--room", str(room)]
    argv[0] = rewrite_interpreter(argv[0], sys.executable, interp)
    return argv


def build_child_env(assignment: dict[str, Any], base_env: dict[str, str] | None = None) -> dict[str, str]:
    """Merge the assignment's resolved spawn env over the base process env."""
    env = dict(base_env or {})
    spawn = assignment.get("spawn")
    if isinstance(spawn, dict) and isinstance(spawn.get("env"), dict):
        for k, v in spawn["env"].items():
            env[str(k)] = str(v)
    return env


def build_child_cwd(assignment: dict[str, Any]) -> str | None:
    """The working dir for an assignment's child, or ``None``. Set only when the
    resolved spawn spec carries a ``cwd`` — a pinned-bundle redirect anchors the
    child on the extracted dir (see ``vision_edge.appstore.redirect_worker_dir``);
    a normal assignment carries none and the child inherits the daemon's cwd, as
    today."""
    spawn = assignment.get("spawn")
    if isinstance(spawn, dict):
        cwd = spawn.get("cwd")
        if isinstance(cwd, str) and cwd:
            return cwd
    return None


class AssignmentSupervisor:
    """Owns the child processes for all assignments on this edge.

    ``spawn(argv, env, cwd)`` must return a process handle exposing ``poll()``
    (None while running, an int exit code once dead) and ``terminate()`` — real
    ``subprocess.Popen`` in prod, a fake in tests. ``cwd`` is ``None`` for a
    normal assignment and the extracted-bundle dir for a pinned one.
    ``on_status(id, status, detail)`` reports transitions to the master (the WS
    client wires it to an ``assignment_status`` frame).
    """

    def __init__(
        self,
        spawn: Callable[[list[str], dict[str, str], Optional[str]], Any],
        on_status: Optional[Callable[[str, str, Optional[str]], None]] = None,
        base_env: Optional[dict[str, str]] = None,
        clock: Callable[[], float] = time.monotonic,
        max_restarts: int = DEFAULT_MAX_RESTARTS,
        restart_window: float = DEFAULT_RESTART_WINDOW,
    ) -> None:
        self._spawn = spawn
        self._on_status = on_status
        self._base_env = base_env or {}
        self._clock = clock
        self._max_restarts = max_restarts
        self._restart_window = restart_window
        self._children: dict[str, Child] = {}

    def _report(self, assignment_id: str, status: str, detail: str | None = None) -> None:
        if self._on_status:
            self._on_status(assignment_id, status, detail)

    def active_ids(self) -> list[str]:
        return list(self._children.keys())

    def status_of(self, assignment_id: str) -> str | None:
        c = self._children.get(assignment_id)
        return c.status if c else None

    def assign(self, assignment: dict[str, Any]) -> None:
        """Start (or re-configure) a child for an assignment. Re-assigning an
        existing id with new config restarts the child with the new spec."""
        aid = assignment.get("id")
        if not aid:
            return
        existing = self._children.get(aid)
        if existing is not None:
            # Config change → replace the running child.
            self._kill(existing)
            existing.assignment = assignment
            existing.tracker = RestartTracker(self._max_restarts, self._restart_window)
            self._launch(aid, existing)
            return
        child = Child(
            assignment=assignment,
            tracker=RestartTracker(self._max_restarts, self._restart_window),
        )
        self._children[aid] = child
        self._launch(aid, child)

    def revoke(self, assignment_id: str) -> None:
        child = self._children.pop(assignment_id, None)
        if child is None:
            return
        self._kill(child)
        child.status = "stopped"
        self._report(assignment_id, "stopped", "revoked")

    def _launch(self, aid: str, child: Child) -> None:
        argv = build_child_argv(child.assignment)
        env = build_child_env(child.assignment, self._base_env)
        cwd = build_child_cwd(child.assignment)
        try:
            child.process = self._spawn(argv, env, cwd)
            child.status = "running"
            self._report(aid, "running")
        except Exception as exc:  # noqa: BLE001 - report + leave for reap/backoff
            child.process = None
            child.status = "failed"
            self._report(aid, "failed", str(exc))

    def _kill(self, child: Child) -> None:
        proc = child.process
        if proc is None:
            return
        try:
            proc.terminate()
        except Exception:  # noqa: BLE001 - already gone
            pass
        child.process = None

    def reap(self) -> None:
        """Poll every child once: a dead child is restarted (within the cap +
        backoff) or marked failed. Call this on a timer from the edge loop."""
        now = self._clock()
        for aid, child in list(self._children.items()):
            proc = child.process
            if proc is None:
                self._maybe_restart(aid, child, now)
                continue
            code = proc.poll()
            if code is None:
                continue  # still running
            # Child exited.
            child.process = None
            if code == 0:
                child.status = "stopped"
                self._report(aid, "stopped", "exited cleanly")
                self._children.pop(aid, None)
            else:
                child.status = "failed"
                self._report(aid, "failed", f"exit code {code}")
                self._maybe_restart(aid, child, now)

    def _maybe_restart(self, aid: str, child: Child, now: float) -> None:
        if not child.tracker.allowed(now):
            if child.status != "failed":
                child.status = "failed"
            self._report(aid, "failed", "restart cap reached (3/hour) — giving up")
            return
        if now < child.restart_at:
            return  # still in backoff
        child.tracker.record(now)
        child.restart_at = now + child.tracker.backoff(now)
        self._launch(aid, child)

    def stop_all(self) -> None:
        for aid, child in list(self._children.items()):
            self._kill(child)
            child.status = "stopped"
        self._children.clear()
