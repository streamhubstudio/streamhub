"""
Edge control-channel WebSocket client — implements the Wave-1A frame protocol
EXACTLY (streamhub-core/src/modules/edge/edge.protocol.ts + edge.gateway.ts).

  edge → master : register · telemetry · assignment_status · cmd_result ·
                  log_tail_result · pong
  master → edge : assign · revoke · cmd · log_tail · ping

The wire codec, the reconnect backoff schedule and the inbound-frame dispatch
are PURE (``encode_frame`` / ``decode_frame`` / ``backoff_delay`` /
``EdgeProtocolHandler``) so the whole protocol is unit-tested with no live
socket. ``WsClient`` (asyncio + the ``websockets`` lib, imported lazily) wires
the handler to a real connection, the telemetry loop and the supervisor.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Callable

# Mirrors edge.protocol.ts EDGE_PING_INTERVAL_MS / master keepalive cadence.
DEFAULT_TELEMETRY_INTERVAL = 15.0
# The master pings every 15s (EDGE_PING_INTERVAL_MS). If the socket goes half-open
# (master gone, no FIN) the edge would sit in `async for` believing it is still
# connected; force a reconnect after 2× the ping interval with no inbound frame.
MASTER_PING_INTERVAL = 15.0
DEFAULT_WS_IDLE_TIMEOUT = 2 * MASTER_PING_INTERVAL
# Reconnect backoff (capped exponential): 1,2,4,8,16,30,30… seconds.
BACKOFF_BASE = 1.0
BACKOFF_CAP = 30.0


def encode_frame(type_: str, **fields: Any) -> str:
    """Serialize an outbound frame to a JSON string (matches parseFrame)."""
    frame: dict[str, Any] = {"type": type_}
    frame.update(fields)
    return json.dumps(frame, ensure_ascii=False)


def decode_frame(raw: Any) -> dict[str, Any] | None:
    """Parse an inbound message → frame dict, or None when it is not a JSON
    object with a string ``type``. Never raises (bad frames are dropped) —
    same contract as the core's ``parseFrame``."""
    try:
        text = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else str(raw)
        obj = json.loads(text)
    except (json.JSONDecodeError, ValueError, TypeError, UnicodeDecodeError):
        return None
    if not isinstance(obj, dict):
        return None
    t = obj.get("type")
    if not isinstance(t, str) or not t:
        return None
    return obj


def backoff_delay(attempt: int, base: float = BACKOFF_BASE, cap: float = BACKOFF_CAP) -> float:
    """Capped exponential backoff for reconnect attempt N (0-based)."""
    if attempt < 0:
        attempt = 0
    return min(cap, base * (2 ** attempt))


def idle_reconnect_due(last_activity: float, now: float, idle_timeout: float) -> bool:
    """True when no inbound frame has arrived for ``idle_timeout`` seconds — the
    signal the async client uses to force-reconnect a half-open socket. A
    non-positive ``idle_timeout`` disables the check (returns False). Pure so the
    watchdog decision is unit-tested with no live socket."""
    if idle_timeout <= 0:
        return False
    return (now - last_activity) >= idle_timeout


@dataclass
class Action:
    """One effect the async client executes for an inbound frame."""

    kind: str  # 'send' | 'assign' | 'revoke' | 'restart' | 'reboot'
    data: Any = None


class EdgeProtocolHandler:
    """Pure inbound-frame dispatcher for the edge side.

    Given the node identity + capabilities it builds the register/telemetry
    frames, and turns each master→edge frame into a list of ``Action``s (reply
    frames to send + local intents to run). No I/O, no socket — the async
    client performs the effects.
    """

    def __init__(
        self,
        node_id: str,
        capabilities: list[str],
        allow_reboot: bool = False,
        agent_version: str = "0.1.0",
        role: str = "edge",
    ) -> None:
        self.node_id = node_id
        self.capabilities = list(capabilities)
        self.allow_reboot = allow_reboot
        self.agent_version = agent_version
        self.role = role

    # -- outbound frame builders --------------------------------------------

    def register_frame(self) -> dict[str, Any]:
        return {
            "type": "register",
            "role": self.role,
            "agentVersion": self.agent_version,
            "capabilities": self.capabilities,
        }

    def telemetry_frame(self, stats: dict[str, Any]) -> dict[str, Any]:
        return {"type": "telemetry", "stats": stats}

    def assignment_status_frame(
        self, assignment_id: str, status: str, detail: str | None = None
    ) -> dict[str, Any]:
        frame: dict[str, Any] = {
            "type": "assignment_status",
            "id": assignment_id,
            "status": status,
        }
        if detail is not None:
            frame["detail"] = detail
        return frame

    # -- inbound dispatch ---------------------------------------------------

    def handle(
        self, frame: dict[str, Any], log_reader: Callable[[int], list[str]] | None = None
    ) -> list[Action]:
        """Turn one inbound frame into effects. ``log_reader(n)`` returns the
        last n runtime-log lines (injected so this stays pure)."""
        t = frame.get("type")
        if t == "ping":
            return [Action("send", {"type": "pong"})]
        if t == "assign":
            return self._on_assign(frame)
        if t == "revoke":
            return self._on_revoke(frame)
        if t == "cmd":
            return self._on_cmd(frame)
        if t == "log_tail":
            return self._on_log_tail(frame, log_reader)
        # pong / unknown → nothing to do (keepalive is tracked by the client).
        return []

    def _on_assign(self, frame: dict[str, Any]) -> list[Action]:
        a = frame.get("assignment")
        if not isinstance(a, dict) or not a.get("id"):
            return []
        return [Action("assign", a)]

    def _on_revoke(self, frame: dict[str, Any]) -> list[Action]:
        aid = frame.get("id")
        if not isinstance(aid, str) or not aid:
            return []
        return [Action("revoke", aid)]

    def _on_cmd(self, frame: dict[str, Any]) -> list[Action]:
        cmd_id = frame.get("cmdId")
        command = frame.get("command")
        if not isinstance(cmd_id, str) or not cmd_id:
            return []
        if command == "ping":
            return [Action("send", {"type": "cmd_result", "cmdId": cmd_id, "ok": True, "output": "pong"})]
        if command == "restart":
            return [
                Action("send", {"type": "cmd_result", "cmdId": cmd_id, "ok": True, "output": "restarting"}),
                Action("restart"),
            ]
        if command == "reboot":
            if not self.allow_reboot:
                return [
                    Action(
                        "send",
                        {"type": "cmd_result", "cmdId": cmd_id, "ok": False, "output": "reboot not permitted (VISION_EDGE_ALLOW_REBOOT unset)"},
                    )
                ]
            return [
                Action("send", {"type": "cmd_result", "cmdId": cmd_id, "ok": True, "output": "rebooting"}),
                Action("reboot"),
            ]
        return [
            Action("send", {"type": "cmd_result", "cmdId": cmd_id, "ok": False, "output": f"unknown command: {command}"})
        ]

    def _on_log_tail(
        self, frame: dict[str, Any], log_reader: Callable[[int], list[str]] | None
    ) -> list[Action]:
        req_id = frame.get("reqId")
        if not isinstance(req_id, str) or not req_id:
            return []
        n = frame.get("lines")
        n = int(n) if isinstance(n, (int, float)) else 100
        lines = log_reader(n) if log_reader else []
        return [Action("send", {"type": "log_tail_result", "reqId": req_id, "lines": lines})]


def build_ws_url(base: str, node_id: str, token: str) -> str:
    """Compose the edge WS URL with the nodeId query param (the cluster token
    rides the ``X-Cluster-Token`` header, but ``?token=`` is also accepted by
    the gateway; we send the header)."""
    sep = "&" if "?" in base else "?"
    from urllib.parse import quote

    return f"{base}{sep}nodeId={quote(node_id)}"


# ---------------------------------------------------------------------------
# Async client (lazy websockets import; not exercised by the pure tests)
# ---------------------------------------------------------------------------

class WsClient:
    """Long-lived edge WS client: connect → register → telemetry loop +
    inbound dispatch, reconnect with capped backoff on drop.

    ``supervisor`` receives assign/revoke (see ``vision_edge.supervisor``);
    ``stats_fn()`` returns the telemetry blob; ``log_reader(n)`` returns log
    lines. The heavy ``websockets`` import is deferred to ``run``.
    """

    def __init__(
        self,
        config,
        supervisor,
        stats_fn: Callable[[], dict[str, Any]],
        log_reader: Callable[[int], list[str]] | None = None,
        logger=None,
    ) -> None:
        self.config = config
        self.supervisor = supervisor
        self.stats_fn = stats_fn
        self.log_reader = log_reader
        self.handler = EdgeProtocolHandler(
            config.node_id, config.capabilities, allow_reboot=config.allow_reboot
        )
        self._logger = logger
        self._stop = False
        self._restart_requested = False

    def _log(self, msg: str) -> None:
        if self._logger:
            self._logger(msg)

    def _now(self) -> float:
        return time.monotonic()

    def _idle_timeout(self) -> float:
        return float(getattr(self.config, "ws_idle_timeout", DEFAULT_WS_IDLE_TIMEOUT))

    def stop(self) -> None:
        self._stop = True

    async def run(self) -> int:
        import asyncio

        import websockets  # lazy

        attempt = 0
        while not self._stop:
            try:
                url = build_ws_url(self.config.ws_url, self.config.node_id, self.config.cluster_token)
                headers = {"X-Cluster-Token": self.config.cluster_token}
                async with websockets.connect(url, additional_headers=headers) as ws:
                    attempt = 0
                    await self._session(ws)
            except Exception as exc:  # noqa: BLE001 - reconnect on any drop
                self._log(f"ws disconnected: {exc}")
            if self._restart_requested or self._stop:
                break
            delay = backoff_delay(attempt)
            attempt += 1
            self._log(f"reconnecting in {delay:.0f}s")
            await asyncio.sleep(delay)
        return 0

    async def _session(self, ws) -> None:
        import asyncio

        await ws.send(json.dumps(self.handler.register_frame()))
        self._log("registered with master")
        # Single-cell holder the watchdog reads; refreshed on every inbound frame
        # (incl. the master's 15s ping) so a live channel never trips it.
        last_activity = [self._now()]
        telemetry_task = asyncio.ensure_future(self._telemetry_loop(ws))
        watchdog_task = asyncio.ensure_future(self._idle_watchdog(ws, last_activity))
        try:
            async for raw in ws:
                last_activity[0] = self._now()
                frame = decode_frame(raw)
                if frame is None:
                    continue
                await self._dispatch(ws, frame)
                if self._restart_requested:
                    break
        finally:
            telemetry_task.cancel()
            watchdog_task.cancel()

    async def _idle_watchdog(self, ws, last_activity: list[float]) -> None:
        import asyncio

        timeout = self._idle_timeout()
        if timeout <= 0:
            return
        interval = max(1.0, timeout / 2.0)
        while not self._stop:
            await asyncio.sleep(interval)
            if idle_reconnect_due(last_activity[0], self._now(), timeout):
                self._log(f"no master frame for >{timeout:.0f}s — forcing reconnect")
                try:
                    await ws.close(code=4000, reason="idle timeout")
                except Exception as exc:  # noqa: BLE001 - closing a dead socket
                    self._log(f"idle close failed: {exc}")
                return

    async def _telemetry_loop(self, ws) -> None:
        import asyncio

        while not self._stop:
            try:
                stats = self.stats_fn()
                await ws.send(encode_frame("telemetry", stats=stats))
            except Exception as exc:  # noqa: BLE001
                self._log(f"telemetry send failed: {exc}")
                return
            await asyncio.sleep(self.config.telemetry_interval)

    async def _dispatch(self, ws, frame: dict[str, Any]) -> None:
        for action in self.handler.handle(frame, self.log_reader):
            if action.kind == "send":
                await ws.send(json.dumps(action.data))
            elif action.kind == "assign":
                self._apply_assign(ws, action.data)
            elif action.kind == "revoke":
                self.supervisor.revoke(action.data)
            elif action.kind == "restart":
                self._restart_requested = True
                self._stop = True
            elif action.kind == "reboot":
                self._reboot()

    def _apply_assign(self, ws, assignment: dict[str, Any]) -> None:
        try:
            # APP VERSIONING: a frame that pins an appstore version carries a
            # `bundle` ref — fetch+verify+extract it and rewrite the spawn to run
            # from the pinned dir BEFORE the supervisor starts the child. A
            # sha256 mismatch / fetch error raises here → reported failed below
            # (the daemon never crashes); absent bundle → assignment unchanged.
            prepared = self._prepare_bundle(assignment)
            self.supervisor.assign(prepared)
        except Exception as exc:  # noqa: BLE001 - report failure to the master
            import asyncio

            frame = self.handler.assignment_status_frame(assignment.get("id", ""), "failed", str(exc))
            asyncio.ensure_future(ws.send(json.dumps(frame)))

    def _prepare_bundle(self, assignment: dict[str, Any]) -> dict[str, Any]:  # pragma: no cover - network seam
        """Resolve an optional pinned bundle to a spawn that runs from its
        extracted dir. No `bundle` on the frame → the assignment is returned
        unchanged (the common, non-pinned path). The download rides the same
        `X-Cluster-Token` gate the WS channel uses; the pure fetch/verify/extract
        logic lives in `vision_edge.appstore` (unit-tested there)."""
        from .appstore import parse_bundle_ref

        if parse_bundle_ref(assignment) is None:
            return assignment
        from .appstore import download_bundle, prepare_assignment_spawn

        base = getattr(self.config, "appstore_dir", "") or ""
        token = self.config.cluster_token

        def _download(url: str) -> bytes:
            return download_bundle(url, token)

        return prepare_assignment_spawn(assignment, base, _download, logger=self._log)

    def _reboot(self) -> None:
        import subprocess

        try:
            subprocess.run(["systemctl", "reboot"], check=False, timeout=10)
        except (OSError, subprocess.SubprocessError) as exc:
            self._log(f"reboot failed: {exc}")
