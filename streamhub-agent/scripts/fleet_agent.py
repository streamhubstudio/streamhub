#!/usr/bin/env python3
"""StreamHub fleet agent — MQTT fleet-management companion for streamhub-agent.

Spawned + supervised by the C agent (src/fleet.c, mirroring the onvif/detect
workers) OR run standalone under systemd/init. It connects to the SAME per-app
MQTT broker the StreamHub app already uses and speaks the StreamHub **fleet**
protocol (mirrors streamhub-core src/modules/fleet/fleet.protocol.ts):

  streamhub/<app>/agents/<id>/telemetry   (agent → broker, retained)
  streamhub/<app>/agents/<id>/status      (agent → broker, retained, LWT)
  streamhub/<app>/agents/<id>/cmd          (broker → agent)
  streamhub/<app>/agents/<id>/cmd/result  (agent → broker)

It publishes telemetry (cpu/mem/temp/uptime/agentVersion/cameras/relay/disk)
every N seconds, registers an MQTT Last-Will so the fleet dashboard sees it drop
offline, and implements the commands: restart, ota, config, ping.

Config is read from the agent's own config.yml (agent.id / agent.tenant /
mqtt.host / mqtt.port) plus an optional `fleet:` block (interval, broker
username/password/tls, ota binary/unit); env vars STREAMHUB_FLEET_* override.
The C side passes --config/--secrets/--agent-version so the running agent
version is always accurate.

Dependencies: paho-mqtt (imported lazily in main(), so this module — and every
pure helper below — imports with only the stdlib, which is what the pytest
suite exercises). Metrics use psutil when present, else /proc + /sys (stdlib).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable

FALLBACK_VERSION = "unknown"
DEFAULT_INTERVAL = 15
COMMANDS = ("restart", "ota", "config", "ping")


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


@dataclass
class FleetConfig:
    agent_id: str = ""
    app: str = ""
    broker_host: str = ""
    broker_port: int = 1883
    username: str = ""
    password: str = ""
    tls: bool = False
    interval: int = DEFAULT_INTERVAL
    agent_version: str = FALLBACK_VERSION
    binary_path: str = ""
    systemd_unit: str = "streamhub-agent"
    config_path: str = ""
    cameras: int = 0
    fleet_block: dict = field(default_factory=dict)

    @property
    def prefix(self) -> str:
        return f"streamhub/{self.app}"

    @property
    def broker_url(self) -> str:
        scheme = "mqtts" if self.tls else "mqtt"
        return f"{scheme}://{self.broker_host}:{self.broker_port}"


def parse_min_yaml(text: str) -> dict:
    """Tiny stdlib parser for the flat/one-level agent config.yml we need:
    top-level `section:` headers with 2-space-indented `key: value` children
    (and a `cameras:` list of `- id:` items). Good enough for agent.*/mqtt.*/
    fleet.* — NOT a general YAML parser (mirrors onvif.py's stdlib-only ethos)."""
    out: dict[str, Any] = {}
    section: str | None = None
    cameras: list[dict] = []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(" "))
        stripped = line.strip()
        if indent == 0 and stripped.endswith(":") and ":" == stripped[-1]:
            section = stripped[:-1].strip()
            if section == "cameras":
                out["cameras"] = cameras
            else:
                out.setdefault(section, {})
            continue
        if section == "cameras":
            if stripped.startswith("- "):
                cameras.append({})
                stripped = stripped[2:].strip()
            if cameras and ":" in stripped:
                k, v = stripped.split(":", 1)
                cameras[-1][k.strip()] = _unquote(v.strip())
            continue
        if section and ":" in stripped:
            k, v = stripped.split(":", 1)
            if isinstance(out.get(section), dict):
                out[section][k.strip()] = _unquote(v.strip())
    return out


def _unquote(v: str) -> str:
    if len(v) >= 2 and v[0] in "'\"" and v[-1] == v[0]:
        return v[1:-1]
    return v


def load_config(
    config_path: str,
    secrets_path: str,
    argv_version: str | None = None,
    env: dict | None = None,
    read_text: Callable[[str], str] | None = None,
) -> FleetConfig:
    env = env if env is not None else os.environ
    reader = read_text or _read_text_or_empty
    doc = parse_min_yaml(reader(config_path))
    agent = doc.get("agent", {}) if isinstance(doc.get("agent"), dict) else {}
    mqtt = doc.get("mqtt", {}) if isinstance(doc.get("mqtt"), dict) else {}
    fleet = doc.get("fleet", {}) if isinstance(doc.get("fleet"), dict) else {}
    cams = doc.get("cameras", [])

    cfg = FleetConfig(config_path=config_path, fleet_block=fleet)
    cfg.agent_id = env.get("STREAMHUB_FLEET_AGENT_ID") or agent.get("id", "")
    cfg.app = env.get("STREAMHUB_FLEET_APP") or agent.get("tenant") or agent.get("app", "")
    cfg.broker_host = env.get("STREAMHUB_FLEET_MQTT_HOST") or mqtt.get("host", "")
    cfg.broker_port = _int(env.get("STREAMHUB_FLEET_MQTT_PORT") or mqtt.get("port"), 1883)
    cfg.username = env.get("STREAMHUB_FLEET_MQTT_USER") or fleet.get("username") or cfg.agent_id
    cfg.password = env.get("STREAMHUB_FLEET_MQTT_PASS") or fleet.get("password", "")
    cfg.tls = _bool(env.get("STREAMHUB_FLEET_MQTT_TLS") or fleet.get("tls"), False)
    cfg.interval = _int(
        env.get("STREAMHUB_FLEET_INTERVAL") or fleet.get("interval"), DEFAULT_INTERVAL
    )
    cfg.agent_version = (
        argv_version or env.get("STREAMHUB_AGENT_VERSION") or FALLBACK_VERSION
    )
    cfg.binary_path = env.get("STREAMHUB_FLEET_BINARY") or fleet.get("binary") or _self_binary()
    cfg.systemd_unit = (
        env.get("STREAMHUB_FLEET_UNIT") or fleet.get("unit") or "streamhub-agent"
    )
    cfg.cameras = len(cams) if isinstance(cams, list) else 0
    # secrets_path currently unused for the fleet plane (broker creds come from
    # the fleet block/env); kept in the signature for symmetry with onvif.py.
    _ = secrets_path
    return cfg


def _read_text_or_empty(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def _self_binary() -> str:
    d = os.path.dirname(os.path.dirname(os.path.abspath(sys.argv[0] or ".")))
    return os.path.join(d, "streamhub-agent")


def _int(v: Any, default: int) -> int:
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return default


def _bool(v: Any, default: bool) -> bool:
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


# ---------------------------------------------------------------------------
# Topics
# ---------------------------------------------------------------------------


def telemetry_topic(cfg: FleetConfig) -> str:
    return f"{cfg.prefix}/agents/{cfg.agent_id}/telemetry"


def status_topic(cfg: FleetConfig) -> str:
    return f"{cfg.prefix}/agents/{cfg.agent_id}/status"


def cmd_topic(cfg: FleetConfig) -> str:
    return f"{cfg.prefix}/agents/{cfg.agent_id}/cmd"


def result_topic(cfg: FleetConfig) -> str:
    return f"{cfg.prefix}/agents/{cfg.agent_id}/cmd/result"


# ---------------------------------------------------------------------------
# Telemetry
# ---------------------------------------------------------------------------


def collect_metrics(sampler: Any | None = None) -> dict:
    """Best-effort host metrics. Uses psutil when available, else /proc + /sys.
    Every field is optional; a missing one is simply omitted."""
    s = sampler if sampler is not None else _default_sampler()
    m: dict[str, Any] = {}
    for key in ("cpu", "mem", "temp", "uptime", "disk"):
        try:
            v = getattr(s, key)()
        except Exception:  # noqa: BLE001 — telemetry is best-effort
            v = None
        if v is not None:
            m[key] = v
    return m


class _StdlibSampler:
    """Metrics from /proc + /sys (no third-party deps)."""

    def cpu(self) -> float | None:
        try:
            a = self._cpu_times()
            time.sleep(0.1)
            b = self._cpu_times()
            idle = b[3] - a[3]
            total = sum(b) - sum(a)
            if total <= 0:
                return None
            return round(100.0 * (total - idle) / total, 1)
        except Exception:  # noqa: BLE001
            return None

    def _cpu_times(self) -> list[int]:
        with open("/proc/stat", "r", encoding="ascii") as f:
            parts = f.readline().split()[1:8]
        return [int(x) for x in parts]

    def mem(self) -> float | None:
        try:
            info: dict[str, int] = {}
            with open("/proc/meminfo", "r", encoding="ascii") as f:
                for line in f:
                    k, _, rest = line.partition(":")
                    info[k] = int(rest.split()[0])
            total = info.get("MemTotal", 0)
            avail = info.get("MemAvailable", info.get("MemFree", 0))
            if total <= 0:
                return None
            return round(100.0 * (total - avail) / total, 1)
        except Exception:  # noqa: BLE001
            return None

    def temp(self) -> float | None:
        for zone in ("/sys/class/thermal/thermal_zone0/temp",):
            try:
                with open(zone, "r", encoding="ascii") as f:
                    milli = int(f.read().strip())
                return round(milli / 1000.0, 1)
            except Exception:  # noqa: BLE001
                continue
        return None

    def uptime(self) -> int | None:
        try:
            with open("/proc/uptime", "r", encoding="ascii") as f:
                return int(float(f.read().split()[0]))
        except Exception:  # noqa: BLE001
            return None

    def disk(self) -> float | None:
        try:
            st = os.statvfs("/")
            total = st.f_blocks * st.f_frsize
            free = st.f_bavail * st.f_frsize
            if total <= 0:
                return None
            return round(100.0 * (total - free) / total, 1)
        except Exception:  # noqa: BLE001
            return None


def _default_sampler() -> Any:
    try:
        import psutil  # noqa: F401

        return _PsutilSampler()
    except Exception:  # noqa: BLE001
        return _StdlibSampler()


class _PsutilSampler:
    def cpu(self) -> float | None:
        import psutil

        return round(float(psutil.cpu_percent(interval=0.1)), 1)

    def mem(self) -> float | None:
        import psutil

        return round(float(psutil.virtual_memory().percent), 1)

    def temp(self) -> float | None:
        import psutil

        try:
            temps = psutil.sensors_temperatures()
        except Exception:  # noqa: BLE001
            return None
        for entries in temps.values():
            if entries:
                return round(float(entries[0].current), 1)
        return None

    def uptime(self) -> int | None:
        import psutil

        return int(time.time() - psutil.boot_time())

    def disk(self) -> float | None:
        import psutil

        return round(float(psutil.disk_usage("/").percent), 1)


def build_telemetry(cfg: FleetConfig, metrics: dict, relay: str = "running") -> dict:
    """Assemble the retained telemetry payload from metrics + config."""
    payload = dict(metrics)
    payload["agentVersion"] = cfg.agent_version
    payload["cameras"] = cfg.cameras
    payload.setdefault("relay", relay)
    return payload


# ---------------------------------------------------------------------------
# Command handling
# ---------------------------------------------------------------------------


@dataclass
class CommandDeps:
    """Injectable side-effects, so command handlers are unit-testable."""

    run: Callable[[list[str]], int] = None  # type: ignore[assignment]
    download: Callable[[str, str], None] = None  # type: ignore[assignment]
    restart: Callable[[FleetConfig], tuple[bool, str]] = None  # type: ignore[assignment]
    read_config: Callable[[str], str] = None  # type: ignore[assignment]
    write_config: Callable[[str, str], None] = None  # type: ignore[assignment]

    def resolved(self) -> "CommandDeps":
        return CommandDeps(
            run=self.run or _run_cmd,
            download=self.download or _http_download,
            restart=self.restart or restart_agent,
            read_config=self.read_config or _read_text_or_empty,
            write_config=self.write_config or _write_text,
        )


def dispatch(payload: dict, cfg: FleetConfig, deps: CommandDeps | None = None) -> dict:
    """Route one command payload → a result envelope for `.../cmd/result`.
    Never raises; a handler failure becomes { ok: false, message }."""
    d = (deps or CommandDeps()).resolved()
    cmd_id = str(payload.get("id") or "")
    command = payload.get("command")
    args = payload.get("args") if isinstance(payload.get("args"), dict) else {}

    if command not in COMMANDS:
        return _result(cmd_id, command, False, f"unknown command '{command}'", cfg)

    try:
        if command == "ping":
            ok, msg = handle_ping(cfg)
        elif command == "restart":
            ok, msg = handle_restart(cfg, d)
        elif command == "config":
            ok, msg = handle_config(args, cfg, d)
        elif command == "ota":
            ok, msg = handle_ota(args, cfg, d)
        else:  # pragma: no cover — guarded above
            ok, msg = False, "unhandled"
    except Exception as exc:  # noqa: BLE001 — a bad command must not crash the loop
        ok, msg = False, f"{command} failed: {exc}"

    return _result(cmd_id, command, ok, msg, cfg)


def _result(cmd_id: str, command: Any, ok: bool, message: str, cfg: FleetConfig) -> dict:
    return {
        "id": cmd_id,
        "command": command,
        "ok": ok,
        "message": message,
        "version": cfg.agent_version,
        "ts": _now_iso(),
    }


def handle_ping(cfg: FleetConfig) -> tuple[bool, str]:
    return True, f"pong ({cfg.agent_id})"


def handle_restart(cfg: FleetConfig, deps: CommandDeps) -> tuple[bool, str]:
    return deps.restart(cfg)


def handle_config(args: dict, cfg: FleetConfig, deps: CommandDeps) -> tuple[bool, str]:
    """Merge args.config into config.yml and rewrite it. The running agent
    reads config.yml at startup, so a `restart` (or the next restart) applies
    it — this handler does NOT auto-restart (that stays an explicit command)."""
    new = args.get("config")
    if not isinstance(new, dict) or not new:
        return False, "config requires a non-empty object"
    text = deps.read_config(cfg.config_path)
    merged = merge_config_yaml(text, new)
    deps.write_config(cfg.config_path, merged)
    return True, f"merged {len(new)} key(s) into config.yml (restart to apply)"


def merge_config_yaml(text: str, updates: dict) -> str:
    """Merge flat `section.key: value` updates into the agent's config.yml,
    preserving unrelated lines. `updates` keys are dotted (`agent.timezone`)
    or plain top-level keys under the `agent:` section. Unknown sections are
    appended. Deliberately conservative — it only rewrites the exact lines it
    recognizes and never reorders the rest."""
    lines = text.splitlines()
    # Normalize updates to (section, key, value); a bare key → the `agent` section.
    norm: list[tuple[str, str, str]] = []
    for k, v in updates.items():
        if "." in k:
            sec, key = k.split(".", 1)
        else:
            sec, key = "agent", k
        norm.append((sec, key, _yaml_scalar(v)))

    applied: set[tuple[str, str]] = set()
    cur_section: str | None = None
    out: list[str] = []
    for raw in lines:
        indent = len(raw) - len(raw.lstrip(" "))
        stripped = raw.strip()
        if indent == 0 and stripped.endswith(":") and ":" == stripped[-1:]:
            cur_section = stripped[:-1].strip()
            out.append(raw)
            continue
        replaced = False
        if cur_section and indent > 0 and ":" in stripped:
            key = stripped.split(":", 1)[0].strip()
            for sec, k, val in norm:
                if sec == cur_section and k == key and (sec, k) not in applied:
                    out.append(f"  {k}: {val}")
                    applied.add((sec, k))
                    replaced = True
                    break
        if not replaced:
            out.append(raw)

    # Append any updates whose section/key were not present.
    missing = [n for n in norm if (n[0], n[1]) not in applied]
    if missing:
        by_section: dict[str, list[tuple[str, str, str]]] = {}
        for sec, k, val in missing:
            by_section.setdefault(sec, []).append((sec, k, val))
        for sec, items in by_section.items():
            # If the section header already exists, insert under it; else append it.
            if any(l.strip() == f"{sec}:" for l in out):
                out = _insert_under_section(out, sec, items)
            else:
                out.append(f"{sec}:")
                out.extend(f"  {k}: {val}" for _, k, val in items)
    return "\n".join(out) + "\n"


def _insert_under_section(
    out: list[str], sec: str, items: list[tuple[str, str, str]]
) -> list[str]:
    result: list[str] = []
    for line in out:
        result.append(line)
        if line.strip() == f"{sec}:":
            result.extend(f"  {k}: {val}" for _, k, val in items)
    return result


def _yaml_scalar(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v)
    if s == "" or any(c in s for c in ":#") or s != s.strip():
        return f"'{s}'"
    return s


def handle_ota(args: dict, cfg: FleetConfig, deps: CommandDeps) -> tuple[bool, str]:
    """Download → verify sha256 → atomic swap → restart, with rollback.

    Steps (honest about the model — see streamhub-docs/features/fleet.md):
      1. download the build to `<binary>.new`
      2. verify sha256; on mismatch ABORT (nothing swapped)
      3. atomically rename current → `<binary>.bak`, `<binary>.new` → live
      4. chmod +x and restart the agent
      5. if the swap itself fails after moving the old binary aside, restore
         `<binary>.bak` before returning an error (rollback)
    """
    url = str(args.get("url") or "").strip()
    version = str(args.get("version") or "").strip()
    sha256 = str(args.get("sha256") or "").strip().lower()
    if not url or not version or len(sha256) != 64:
        return False, "ota requires url, version and a 64-hex sha256"

    binary = cfg.binary_path
    if not binary:
        return False, "ota: agent binary path unknown (set fleet.binary)"
    new_path = binary + ".new"
    bak_path = binary + ".bak"

    # 1. download
    deps.download(url, new_path)
    # 2. verify
    actual = sha256_file(new_path)
    if actual != sha256:
        _safe_remove(new_path)
        return False, f"sha256 mismatch (want {sha256[:12]}…, got {actual[:12]}…)"
    # 3. atomic swap (+ rollback on failure)
    try:
        if os.path.exists(binary):
            os.replace(binary, bak_path)
        os.replace(new_path, binary)
        os.chmod(binary, 0o755)
    except OSError as exc:
        # Rollback: if we moved the old binary aside but failed to install the
        # new one, put the old one back.
        if os.path.exists(bak_path) and not os.path.exists(binary):
            try:
                os.replace(bak_path, binary)
            except OSError:
                pass
        _safe_remove(new_path)
        return False, f"ota swap failed (rolled back): {exc}"
    # 4. restart to run the new binary
    ok, msg = deps.restart(cfg)
    return ok, f"updated to {version}; {msg}"


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _safe_remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Real side-effects (production defaults for CommandDeps)
# ---------------------------------------------------------------------------


def _run_cmd(argv: list[str]) -> int:
    try:
        return subprocess.run(argv, timeout=30, check=False).returncode
    except (OSError, subprocess.SubprocessError):
        return -1


def _http_download(url: str, dest: str) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(dest)) or ".", exist_ok=True)
    with urllib.request.urlopen(url, timeout=120) as resp:  # noqa: S310 — operator-supplied
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(dest)))
        try:
            with os.fdopen(fd, "wb") as out:
                shutil.copyfileobj(resp, out)
            os.replace(tmp, dest)
        finally:
            _safe_remove(tmp)


def restart_agent(cfg: FleetConfig, run: Callable[[list[str]], int] | None = None) -> tuple[bool, str]:
    """Restart the agent so a new config/binary takes effect. Prefers systemd;
    falls back to signalling the parent (the C agent) so the init/respawn loop
    brings it back. Because the C agent supervises this companion, restarting
    the agent restarts the companion too."""
    runner = run or _run_cmd
    if shutil.which("systemctl"):
        rc = runner(["systemctl", "restart", cfg.systemd_unit])
        if rc == 0:
            return True, f"systemctl restart {cfg.systemd_unit}"
        return False, f"systemctl restart failed (rc={rc})"
    # Fallback: ask our parent (the C agent) to exit; init respawns it.
    ppid = os.getppid()
    if ppid > 1:
        try:
            os.kill(ppid, 15)  # SIGTERM
            return True, f"signalled parent pid {ppid} to restart"
        except OSError as exc:
            return False, f"could not signal parent: {exc}"
    return False, "no restart mechanism (no systemctl, no supervising parent)"


def _write_text(path: str, text: str) -> None:
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)) or ".")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ---------------------------------------------------------------------------
# MQTT loop (paho) — lazily imported so the module + tests need only stdlib
# ---------------------------------------------------------------------------


def run_loop(cfg: FleetConfig) -> int:  # pragma: no cover — needs a live broker
    try:
        import paho.mqtt.client as mqtt
    except ImportError:
        _log("paho-mqtt not installed — `pip install paho-mqtt`")
        return 2
    if not cfg.agent_id or not cfg.app or not cfg.broker_host:
        _log("fleet: missing agent id / app / broker host — nothing to do")
        return 0

    client = mqtt.Client(client_id=f"streamhub-fleet-agent-{cfg.agent_id}")
    if cfg.username:
        client.username_pw_set(cfg.username, cfg.password or None)
    if cfg.tls:
        client.tls_set()
    # Last-Will: retained offline status so the fleet flips us offline on a drop.
    client.will_set(
        status_topic(cfg),
        json.dumps({"status": "offline", "agentVersion": cfg.agent_version}),
        qos=1,
        retain=True,
    )

    def on_connect(cl, _u, _f, _rc, *_a):
        cl.subscribe(cmd_topic(cfg), qos=1)
        cl.publish(
            status_topic(cfg),
            json.dumps({"status": "online", "agentVersion": cfg.agent_version, "ts": _now_iso()}),
            qos=1,
            retain=True,
        )
        _log(f"fleet: connected, publishing telemetry every {cfg.interval}s")

    def on_message(cl, _u, msg):
        try:
            payload = json.loads(msg.payload.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return
        result = dispatch(payload, cfg)
        cl.publish(result_topic(cfg), json.dumps(result), qos=1)

    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(cfg.broker_host, cfg.broker_port, keepalive=max(30, cfg.interval * 2))
    client.loop_start()
    try:
        while True:
            payload = build_telemetry(cfg, collect_metrics())
            client.publish(telemetry_topic(cfg), json.dumps(payload), qos=0, retain=True)
            time.sleep(max(2, cfg.interval))
    except KeyboardInterrupt:
        pass
    finally:
        client.publish(
            status_topic(cfg),
            json.dumps({"status": "offline", "agentVersion": cfg.agent_version}),
            qos=1,
            retain=True,
        )
        client.loop_stop()
        client.disconnect()
    return 0


def _log(msg: str) -> None:
    sys.stderr.write(f"[fleet_agent] {msg}\n")
    sys.stderr.flush()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="StreamHub fleet MQTT companion")
    p.add_argument("--config", default="config.yml")
    p.add_argument("--secrets", default="secrets.ini")
    p.add_argument("--agent-version", default=None)
    args = p.parse_args(argv)
    cfg = load_config(args.config, args.secrets, argv_version=args.agent_version)
    return run_loop(cfg)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
