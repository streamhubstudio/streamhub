"""Edge WS protocol — frame codec, backoff, inbound-frame dispatch."""
from vision_edge.ws_client import (
    DEFAULT_WS_IDLE_TIMEOUT,
    EdgeProtocolHandler,
    backoff_delay,
    build_ws_url,
    decode_frame,
    encode_frame,
    idle_reconnect_due,
)


def _handler(allow_reboot=False):
    return EdgeProtocolHandler("edge-1", ["vision", "yolo"], allow_reboot=allow_reboot)


def test_encode_decode_roundtrip():
    raw = encode_frame("telemetry", stats={"cpu": 0.5})
    frame = decode_frame(raw)
    assert frame == {"type": "telemetry", "stats": {"cpu": 0.5}}


def test_decode_frame_rejects_non_object_and_missing_type():
    assert decode_frame("[]") is None
    assert decode_frame("not json") is None
    assert decode_frame('{"no":"type"}') is None
    assert decode_frame('{"type":""}') is None
    assert decode_frame(b'{"type":"ping"}') == {"type": "ping"}


def test_backoff_delay_capped_exponential():
    assert backoff_delay(0) == 1.0
    assert backoff_delay(1) == 2.0
    assert backoff_delay(2) == 4.0
    assert backoff_delay(5) == 30.0    # 32 capped at 30
    assert backoff_delay(50) == 30.0
    assert backoff_delay(-3) == 1.0    # negative clamped


def test_idle_reconnect_due():
    # Default half-open guard = 2× the master's 15s ping.
    assert DEFAULT_WS_IDLE_TIMEOUT == 30.0
    assert idle_reconnect_due(0.0, 29.0, 30.0) is False   # still within window
    assert idle_reconnect_due(0.0, 30.0, 30.0) is True    # exactly at timeout
    assert idle_reconnect_due(0.0, 100.0, 30.0) is True   # long gone
    assert idle_reconnect_due(10.0, 25.0, 30.0) is False  # 15s idle < 30
    assert idle_reconnect_due(0.0, 999.0, 0.0) is False   # 0 disables the guard
    assert idle_reconnect_due(0.0, 999.0, -1.0) is False  # negative disables too


def test_build_ws_url_adds_nodeid():
    assert build_ws_url("wss://h/api/v1/edge/ws", "edge 1", "tok") == "wss://h/api/v1/edge/ws?nodeId=edge%201"
    assert "&nodeId=" in build_ws_url("wss://h/edge/ws?x=1", "n", "t")


def test_register_frame():
    f = _handler().register_frame()
    assert f["type"] == "register" and f["role"] == "edge"
    assert f["capabilities"] == ["vision", "yolo"]


def test_handle_ping_replies_pong():
    actions = _handler().handle({"type": "ping"})
    assert len(actions) == 1
    assert actions[0].kind == "send" and actions[0].data == {"type": "pong"}


def test_handle_assign():
    a = {"id": "as1", "app": "live", "pluginId": "vision", "config": {}, "spawn": {}}
    actions = _handler().handle({"type": "assign", "assignment": a})
    assert len(actions) == 1 and actions[0].kind == "assign"
    assert actions[0].data["id"] == "as1"


def test_handle_assign_missing_id_ignored():
    assert _handler().handle({"type": "assign", "assignment": {"app": "x"}}) == []


def test_handle_revoke():
    actions = _handler().handle({"type": "revoke", "id": "as1"})
    assert actions[0].kind == "revoke" and actions[0].data == "as1"


def test_handle_cmd_ping():
    actions = _handler().handle({"type": "cmd", "cmdId": "c1", "command": "ping"})
    assert actions[0].kind == "send"
    assert actions[0].data == {"type": "cmd_result", "cmdId": "c1", "ok": True, "output": "pong"}


def test_handle_cmd_restart_sends_result_then_restart():
    actions = _handler().handle({"type": "cmd", "cmdId": "c2", "command": "restart"})
    assert [a.kind for a in actions] == ["send", "restart"]
    assert actions[0].data["ok"] is True


def test_handle_cmd_reboot_guarded_off():
    actions = _handler(allow_reboot=False).handle({"type": "cmd", "cmdId": "c3", "command": "reboot"})
    assert len(actions) == 1
    assert actions[0].kind == "send" and actions[0].data["ok"] is False
    assert "not permitted" in actions[0].data["output"]


def test_handle_cmd_reboot_allowed():
    actions = _handler(allow_reboot=True).handle({"type": "cmd", "cmdId": "c4", "command": "reboot"})
    assert [a.kind for a in actions] == ["send", "reboot"]
    assert actions[0].data["ok"] is True


def test_handle_cmd_unknown():
    actions = _handler().handle({"type": "cmd", "cmdId": "c5", "command": "explode"})
    assert actions[0].data["ok"] is False and "unknown command" in actions[0].data["output"]


def test_handle_log_tail_uses_reader():
    def reader(n):
        return [f"line{i}" for i in range(n)]

    actions = _handler().handle({"type": "log_tail", "reqId": "r1", "lines": 3}, log_reader=reader)
    assert actions[0].kind == "send"
    assert actions[0].data == {"type": "log_tail_result", "reqId": "r1", "lines": ["line0", "line1", "line2"]}


def test_handle_log_tail_no_reader_empty():
    actions = _handler().handle({"type": "log_tail", "reqId": "r2", "lines": 5})
    assert actions[0].data["lines"] == []


def test_handle_pong_and_unknown_are_noops():
    assert _handler().handle({"type": "pong"}) == []
    assert _handler().handle({"type": "banana"}) == []


def test_assignment_status_frame():
    f = _handler().assignment_status_frame("as1", "running")
    assert f == {"type": "assignment_status", "id": "as1", "status": "running"}
    f2 = _handler().assignment_status_frame("as1", "failed", "boom")
    assert f2["detail"] == "boom"
