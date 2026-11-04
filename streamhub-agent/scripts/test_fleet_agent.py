"""Unit tests for scripts/fleet_agent.py (StreamHub fleet MQTT companion).

Pure-logic tests in the spirit of the StreamHub worker suites: the MQTT broker,
the OTA download and the restart side-effects are all mocked/injected, so this
needs NOTHING beyond the stdlib + pytest and never touches the network.

    python3 -m pytest scripts/test_fleet_agent.py

Invariants locked down here:
  - config parsing: agent id/app, broker host/port, fleet block, camera count,
    env overrides, agent-version from argv/env;
  - topic layout (mirrors streamhub-core fleet.protocol.ts);
  - telemetry serialization (agentVersion + cameras + relay + metrics);
  - command dispatch: ping/restart/config/ota + unknown rejection;
  - OTA: sha256 verify (mismatch aborts, no swap), atomic swap, rollback;
  - config merge into config.yml (replace existing, add new section);
  - restart selects systemctl when present, else signals the parent.
"""

import json
import os

import pytest

import fleet_agent as fa


CONFIG_YML = """\
agent:
  id: a1b2c3
  timezone: America/Argentina/Buenos_Aires
  tenant: demoapp
  callback_url: media.example.com
mqtt:
  host: mqtt.example.com
  port: 1883
fleet:
  interval: 20
  username: fleet-a1b2c3
  password: s3cr3t
  tls: true
cameras:
  - id: c00001
    ip: 192.168.1.108
  - id: c00002
    ip: 192.168.1.112
"""


def cfg_from(text, env=None, version=None):
    return fa.load_config(
        "config.yml", "secrets.ini", argv_version=version,
        env=env or {}, read_text=lambda _p: text,
    )


# ── Config ──────────────────────────────────────────────────────────


def test_load_config_reads_agent_broker_fleet_and_cameras():
    cfg = cfg_from(CONFIG_YML, version="1.12")
    assert cfg.agent_id == "a1b2c3"
    assert cfg.app == "demoapp"
    assert cfg.broker_host == "mqtt.example.com"
    assert cfg.broker_port == 1883
    assert cfg.interval == 20
    assert cfg.username == "fleet-a1b2c3"
    assert cfg.password == "s3cr3t"
    assert cfg.tls is True
    assert cfg.cameras == 2
    assert cfg.agent_version == "1.12"
    assert cfg.broker_url == "mqtts://mqtt.example.com:1883"


def test_env_overrides_win_over_yaml():
    env = {
        "STREAMHUB_FLEET_INTERVAL": "5",
        "STREAMHUB_FLEET_MQTT_USER": "envuser",
        "STREAMHUB_FLEET_APP": "otherapp",
        "STREAMHUB_AGENT_VERSION": "9.9",
    }
    cfg = cfg_from(CONFIG_YML, env=env)
    assert cfg.interval == 5
    assert cfg.username == "envuser"
    assert cfg.app == "otherapp"
    assert cfg.agent_version == "9.9"


def test_username_defaults_to_agent_id_when_unset():
    text = "agent:\n  id: a1\n  tenant: live\nmqtt:\n  host: h\n  port: 1883\n"
    cfg = cfg_from(text)
    assert cfg.username == "a1"
    assert cfg.interval == fa.DEFAULT_INTERVAL
    assert cfg.tls is False


# ── Topics ──────────────────────────────────────────────────────────


def test_topic_layout():
    cfg = cfg_from(CONFIG_YML)
    assert fa.telemetry_topic(cfg) == "streamhub/demoapp/agents/a1b2c3/telemetry"
    assert fa.status_topic(cfg) == "streamhub/demoapp/agents/a1b2c3/status"
    assert fa.cmd_topic(cfg) == "streamhub/demoapp/agents/a1b2c3/cmd"
    assert fa.result_topic(cfg) == "streamhub/demoapp/agents/a1b2c3/cmd/result"


# ── Telemetry ───────────────────────────────────────────────────────


class FakeSampler:
    def cpu(self):
        return 12.5

    def mem(self):
        return 41.0

    def temp(self):
        return 47.2

    def uptime(self):
        return 7200

    def disk(self):
        return 55.0


def test_collect_metrics_uses_sampler_and_omits_none():
    class Partial:
        def cpu(self):
            return 10.0

        def mem(self):
            return None

        def temp(self):
            raise RuntimeError("no sensor")

        def uptime(self):
            return 60

        def disk(self):
            return 30.0

    m = fa.collect_metrics(Partial())
    assert m == {"cpu": 10.0, "uptime": 60, "disk": 30.0}  # mem/temp omitted


def test_build_telemetry_adds_version_cameras_relay():
    cfg = cfg_from(CONFIG_YML, version="1.12")
    payload = fa.build_telemetry(cfg, fa.collect_metrics(FakeSampler()))
    assert payload["cpu"] == 12.5
    assert payload["temp"] == 47.2
    assert payload["agentVersion"] == "1.12"
    assert payload["cameras"] == 2
    assert payload["relay"] == "running"
    # round-trips as JSON
    assert json.loads(json.dumps(payload))["mem"] == 41.0


# ── Command dispatch ────────────────────────────────────────────────


def test_dispatch_ping_ok_and_unknown_rejected():
    cfg = cfg_from(CONFIG_YML)
    ok = fa.dispatch({"id": "c1", "command": "ping"}, cfg)
    assert ok["ok"] is True and ok["id"] == "c1" and ok["command"] == "ping"
    assert ok["version"] == cfg.agent_version and ok["ts"]

    bad = fa.dispatch({"id": "c2", "command": "nuke"}, cfg)
    assert bad["ok"] is False and "unknown" in bad["message"]


def test_dispatch_restart_uses_injected_restart():
    cfg = cfg_from(CONFIG_YML)
    calls = []
    deps = fa.CommandDeps(restart=lambda c: (calls.append(c) or (True, "restarted")))
    res = fa.dispatch({"id": "c3", "command": "restart"}, cfg, deps)
    assert res["ok"] is True and res["message"] == "restarted"
    assert calls and calls[0] is cfg


def test_dispatch_never_raises_on_handler_error():
    cfg = cfg_from(CONFIG_YML)

    def boom(_c):
        raise RuntimeError("kaboom")

    res = fa.dispatch({"id": "c4", "command": "restart"}, cfg, fa.CommandDeps(restart=boom))
    assert res["ok"] is False and "kaboom" in res["message"]


# ── restart_agent selection ─────────────────────────────────────────


def test_restart_prefers_systemctl(monkeypatch):
    monkeypatch.setattr(fa.shutil, "which", lambda _n: "/usr/bin/systemctl")
    seen = []
    ok, msg = fa.restart_agent(cfg_from(CONFIG_YML), run=lambda a: (seen.append(a) or 0))
    assert ok is True
    assert seen == [["systemctl", "restart", "streamhub-agent"]]
    assert "systemctl" in msg


def test_restart_falls_back_to_parent_signal(monkeypatch):
    monkeypatch.setattr(fa.shutil, "which", lambda _n: None)
    monkeypatch.setattr(fa.os, "getppid", lambda: 4242)
    killed = []
    monkeypatch.setattr(fa.os, "kill", lambda pid, sig: killed.append((pid, sig)))
    ok, msg = fa.restart_agent(cfg_from(CONFIG_YML))
    assert ok is True and killed == [(4242, 15)]
    assert "4242" in msg


# ── config merge ────────────────────────────────────────────────────


def test_merge_config_yaml_replaces_existing_and_adds():
    src = "agent:\n  id: a1b2c3\n  timezone: America/Argentina/Buenos_Aires\nmqtt:\n  host: h\n  port: 1883\n"
    out = fa.merge_config_yaml(src, {"agent.timezone": "UTC", "agent.records_ttl": 7})
    assert "  timezone: UTC" in out
    assert "  records_ttl: 7" in out
    # unrelated lines preserved, section headers intact
    assert "  id: a1b2c3" in out and "mqtt:" in out and "  host: h" in out


def test_handle_config_writes_merged_file(tmp_path):
    path = tmp_path / "config.yml"
    path.write_text("agent:\n  id: a1b2c3\n  timezone: America/Argentina/Buenos_Aires\n")
    cfg = cfg_from(CONFIG_YML)
    cfg.config_path = str(path)
    ok, msg = fa.handle_config({"config": {"agent.timezone": "UTC"}}, cfg, fa.CommandDeps().resolved())
    assert ok is True and "merged" in msg
    assert "timezone: UTC" in path.read_text()


def test_handle_config_rejects_empty():
    cfg = cfg_from(CONFIG_YML)
    ok, _ = fa.handle_config({"config": {}}, cfg, fa.CommandDeps().resolved())
    assert ok is False


# ── OTA ─────────────────────────────────────────────────────────────


def make_binary(tmp_path, content=b"OLD-AGENT"):
    binp = tmp_path / "streamhub-agent"
    binp.write_bytes(content)
    return binp


def sha_of(data: bytes) -> str:
    import hashlib

    return hashlib.sha256(data).hexdigest()


def test_ota_success_swaps_and_restarts(tmp_path):
    binp = make_binary(tmp_path)
    new_bytes = b"NEW-AGENT-1.13"
    restarts = []

    def download(_url, dest):
        with open(dest, "wb") as f:
            f.write(new_bytes)

    deps = fa.CommandDeps(
        download=download,
        restart=lambda c: (restarts.append(c) or (True, "restarted")),
    ).resolved()
    cfg = cfg_from(CONFIG_YML)
    cfg.binary_path = str(binp)

    ok, msg = fa.handle_ota(
        {"url": "https://x/y", "version": "1.13", "sha256": sha_of(new_bytes)}, cfg, deps
    )
    assert ok is True and "1.13" in msg
    assert binp.read_bytes() == new_bytes                      # swapped
    assert (tmp_path / "streamhub-agent.bak").read_bytes() == b"OLD-AGENT"  # backup kept
    assert not (tmp_path / "streamhub-agent.new").exists()     # temp consumed
    assert restarts                                            # restart fired


def test_ota_sha256_mismatch_aborts_without_swap(tmp_path):
    binp = make_binary(tmp_path)

    def download(_url, dest):
        with open(dest, "wb") as f:
            f.write(b"CORRUPT")

    restarts = []
    deps = fa.CommandDeps(
        download=download, restart=lambda c: (restarts.append(c) or (True, "r"))
    ).resolved()
    cfg = cfg_from(CONFIG_YML)
    cfg.binary_path = str(binp)

    ok, msg = fa.handle_ota(
        {"url": "https://x/y", "version": "1.13", "sha256": "a" * 64}, cfg, deps
    )
    assert ok is False and "mismatch" in msg
    assert binp.read_bytes() == b"OLD-AGENT"                   # untouched
    assert not (tmp_path / "streamhub-agent.new").exists()     # cleaned up
    assert not restarts                                        # never restarted


def test_ota_rollback_when_swap_fails(tmp_path, monkeypatch):
    binp = make_binary(tmp_path)
    new_bytes = b"NEW-AGENT-1.13"

    def download(_url, dest):
        with open(dest, "wb") as f:
            f.write(new_bytes)

    # Force the SECOND replace (new → live) to fail, after the first moved the
    # old binary to .bak — this is the rollback path.
    real_replace = os.replace
    calls = {"n": 0}

    def flaky_replace(src, dst):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError("disk full")
        return real_replace(src, dst)

    monkeypatch.setattr(fa.os, "replace", flaky_replace)
    deps = fa.CommandDeps(download=download, restart=lambda c: (True, "r")).resolved()
    cfg = cfg_from(CONFIG_YML)
    cfg.binary_path = str(binp)

    ok, msg = fa.handle_ota(
        {"url": "https://x/y", "version": "1.13", "sha256": sha_of(new_bytes)}, cfg, deps
    )
    assert ok is False and "rolled back" in msg
    # rollback restored the original binary
    assert binp.read_bytes() == b"OLD-AGENT"


def test_ota_bad_args_rejected():
    cfg = cfg_from(CONFIG_YML)
    ok, msg = fa.handle_ota({"url": "https://x", "version": "1"}, cfg, fa.CommandDeps().resolved())
    assert ok is False and "sha256" in msg


def test_sha256_file(tmp_path):
    p = tmp_path / "b"
    p.write_bytes(b"hello")
    assert fa.sha256_file(str(p)) == sha_of(b"hello")


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-q"]))
