# Fleet — StreamHub Agent management over MQTT

A nodos.dev-style IoT/agent fleet-management surface for the **StreamHub Agents**
(the C edge agent — RTSP→RTMP relay + edge detection) that a tenant runs against
an app. Over the app's existing per-app **MQTT** broker it gives you: live
per-agent **telemetry** (CPU/RAM/temp/uptime/cameras/disk/battery/relay),
real-time **online/offline** status (via the MQTT Last-Will), a configurable
**battery-low alert**, and remote **control** — `restart`, **OTA update**
(versioned + SHA-256-verified), **config push** and `ping`.

It is the `fleet` **Studio App** (`kind: 'app'`, app-tab, `version 0.1.0`, own
`fleet.db`; see [STUDIO-APPS.md](./STUDIO-APPS.md)) backed by the in-core
`modules/fleet` service — an App with `needsWorker: false`. It **reuses the same
broker the app already uses** for event publishing ([mqtt.md](./mqtt.md)) —
there is no second broker.

---

## Where it lives (and why it is a module, not a worker)

Most processor plugins spawn a child worker (`needsWorker`). A fleet needs the
opposite shape: an **always-on MQTT subscriber** (agents publish telemetry
unprompted) plus a **command publisher** — no HLS/RTSP to pull, nothing to
`spawn`. So the `fleet` plugin manifest (its entry in `internal/plugins/builtin/builtins.json`)
carries only the marketplace entry + app-tab UI slot + config schema, and the
work is done by a small feature module:

- **`streamhub-core-go/internal/fleet/service.go`** — the subscriber +
  registry + command publisher. It **reuses the MQTT seam** (`fleet.Factory` in
  `client.go` → paho, with the same TLS resolution and SSRF/scheme guard the
  `mqtt` package uses) and the app's existing `mqtt:` config for the broker. A periodic
  reconcile (plus an on-demand wake on the first dashboard read) connects one
  subscriber **per app where the fleet plugin is installed + enabled AND
  `mqtt.enabled` is on**, and drops it otherwise.
- **`store.go`** — per-app SQLite `apps/<app>/fleet/fleet.db` (its own
  file, not `app.db`): `agents` registry + `telemetry_history` (rolling, capped)
  + `commands` (issued + async result).
- **`protocol.go`** — the topic layout + payload schemas + command
  validation (pure, unit-tested; this file is the single source of truth mirrored
  by the agent).
- **`routes.go`** — the REST surface (below).

The controller is mounted at `/apps/:app/plugins/fleet/...` with the concrete
`fleet` segment + distinct sub-paths (`agents`, `command`) rather than the
generic PluginsController `:id/data` / `:id/live` routes — those are wired to the
worker live-data channel (this plugin has no worker); the Go mux prefers the
literal `fleet` pattern over `{id}`. **Auth is identical to the rest of the
plugin API**: the global `sk_` Bearer guard + the `config` read/write permission.

---

## MQTT protocol

All topics are namespaced under the app's MQTT **`topic_prefix`** (default
`streamhub/<app>`), so a fleet shares the broker with the app's event stream
without collision.

| Topic | Dir | Retain | Payload |
|---|---|---|---|
| `<prefix>/agents/<agentId>/telemetry` | agent → broker | **yes** (last) | telemetry JSON |
| `<prefix>/agents/<agentId>/status` | agent → broker | **yes** (LWT) | status JSON |
| `<prefix>/agents/<agentId>/cmd` | broker → agent | no | command JSON |
| `<prefix>/agents/<agentId>/cmd/result` | agent → broker | no | result JSON |

The core opens **one** wildcard subscription set per app:
`<prefix>/agents/+/telemetry`, `<prefix>/agents/+/status`,
`<prefix>/agents/+/cmd/result`.

### Telemetry (`.../telemetry`, retained)

```json
{
  "cpu": 12.4,          // % 0–100
  "mem": 41.0,          // % 0–100
  "temp": 47.2,         // °C (optional; not all boards expose it)
  "uptime": 7200,       // seconds
  "agentVersion": "1.12",
  "cameras": 3,         // active camera/relay count
  "relay": "running",   // RTSP→RTMP relay state: running|idle|error
  "disk": 55.0,         // rootfs % 0–100
  "battery": 76.0       // % 0–100 (optional; OMITTED on AC-only hosts, not 0)
}
```

Published every N seconds (agent `fleet.interval`, default 15). Retained so a
freshly-connected dashboard sees the last value immediately. `%` metrics are
clamped to 0–100 on ingest; a `{ "data": { … } }` envelope is unwrapped too.
`battery` in particular is absent from most real payloads — the overwhelming
majority of fleet hosts (Luckfox boxes, desktop/rack Windows agents) run on
mains and have no battery to report; the core treats a missing field as
"no battery", never as 0%.

### Status (`.../status`, retained, set as the MQTT LWT)

```json
{ "status": "online", "agentVersion": "1.12", "ts": "2026-07-10T00:00:00Z" }
```

The agent connects with a **Last-Will**: topic `.../status`, retained payload
`{"status":"offline"}`. If the agent drops without a clean disconnect, the broker
publishes the LWT and every dashboard flips it offline within the keep-alive.
The core **also** reaps agents to `offline` when no telemetry has arrived within
`offlineAfterSec` (default 90) — a backstop for a broker that drops the LWT.

### Command (`.../cmd`, broker → agent)

```json
{ "id": "e6f1…", "command": "restart", "args": {}, "ts": "2026-07-10T00:00:01Z" }
```

`id` is a server-minted UUID the agent **must echo** on the result. Commands
(exactly four): `restart`, `ota`, `config`, `ping`.

- `ota` → `args: { "url": "https://…/streamhub-agent", "version": "1.13", "sha256": "<64-hex>" }`
- `config` → `args: { "config": { … } }` (merged into `config.yml`)
- `restart`, `ping` → no args

### Result (`.../cmd/result`, agent → broker)

```json
{ "id": "e6f1…", "command": "restart", "ok": true, "message": "restarting", "ts": "…" }
```

The core matches `id` to the pending `commands` row and resolves it to `ok` /
`error`.

---

## REST API (dashboard)

All under `/apps/:app/plugins/fleet`, Bearer + `config` permission.

| Method + path | Perm | Returns |
|---|---|---|
| `GET agents` | `config:read` | `{ agents: [{ agentId, online, status, version, lastSeen, ageMs, metrics:{cpu,mem,temp,uptime,cameras,disk,battery,relay} }], generatedAt }` — the plugin **data** route. Reading also wakes the subscriber. |
| `GET agents/:agentId` | `config:read` | `{ agent, history:[{ts,cpu,mem,temp,disk,cameras}], commands:[…] }` — history does **not** carry `battery` (only `metrics` on the list/detail agent view does); add a `telemetry_history` column if per-agent battery charts are ever needed. |
| `POST command` | `config:write` | body `{ agentId, command, args }` → validates, publishes to `.../cmd`, records a **pending** command and returns it (poll `GET agents/:agentId` for the async result). `400` on a bad command/args, `409` when fleet has no live broker for the app. |

## Dashboard UI

App-tab **Fleet** (`streamhub-web/src/plugins/fleet/`): a filterable agent grid
(all / online / offline) with the online/offline badge + version +
CPU/RAM/temp/uptime/cameras/disk per card (+ battery, only on agents that report one); a per-agent detail drawer with
metric-history **sparklines** (inline SVG — no chart dependency) and the recent
command log; action buttons **Ping / Restart / OTA update / Push config**, each
→ `POST …/command`, with the queued-command confirmation and its async status
surfaced. i18n en/es (`src/locales/{en,es}/fleet.json`).

## Config (fleet plugin)

| key | default | meaning |
|---|---|---|
| `offlineAfterSec` | 90 | mark an agent offline when no telemetry arrives within this window (backstop beyond the LWT) |
| `historyPoints` | 120 | telemetry samples kept per agent for the charts |
| `commandTimeoutSec` | 30 | how long a command stays "pending" in the UI before it reads as timed-out |
| `batteryLowPercent` | 0 | battery-low alert threshold, percent; **0 disables the alert** (see below) |

## Battery-low alert

`fleet.BatteryMonitor` (`streamhub-core-go/internal/fleet/battery.go`, wired in
the devices plane) polls every 60 s and drives a **latched, per-AGENT**
threshold state machine — unlike the network-usage threshold monitor
(`internal/netmetrics`, [vision-edge.md](./vision-edge.md) §J), which is per-APP:

- `battery <= batteryLowPercent` and not latched → emit **`fleet.battery_low`**,
  latch.
- `battery > batteryLowPercent + 10` (10 points of recovery hysteresis, so a
  reading bouncing right at the line can't flap the alert) and latched → emit
  **`fleet.battery_recovered`**, unlatch.
- An agent with no `battery` field is **skipped every tick**, not treated as a
  0% breach — most of the fleet has no battery at all. A latch is forgotten when
  the agent disappears, stops reporting a battery, or the app disables the alert.
- `batteryLowPercent: 0` (the default), a fleet plugin that is not installed or
  disabled, or a non-numeric value disables the check entirely for that app.

Both events go through the same callbacks funnel as every other alert family
(`network.threshold_*`, `stream.latency_*`, `node.*`) — so they reach the app's
signed webhook, the MQTT tap (topic `<prefix>/connection/fleet.battery_low`, the
same default category as `network.threshold_*`) and the notifier fan-out
(email/Discord/Telegram) however the app has those configured, and are
selectable from a Streamflow `trigger.event` box (`fleet` family in the event
catalogue). Payload: `{ agentId, batteryPercent, thresholdPercent }`. The feature
was first written for the Node core (unmerged branch
`feat/hls-direct-serve-scaling`); the Go port keeps its names and payloads.

---

## OTA update flow

The `ota` command carries `{ url, version, sha256 }`. On the agent
(`scripts/fleet_agent.py`, the Python companion — see the agent repo
`vision-agent`, branch `fleet-mqtt`):

1. **Download** the build from `url` to a temp file next to the current binary.
2. **Verify** the SHA-256 of the download against the command's `sha256`. **On
   mismatch, abort** — nothing is swapped, the result is `{ ok:false }`.
3. **Atomic swap**: `rename` the current binary → `<binary>.bak`, then `rename`
   the verified download → the live binary path (same filesystem → atomic).
4. **Restart** the agent so the new binary runs: `systemctl restart` on a systemd
   host, else signal the parent so the init/respawn loop brings it back. Because
   the C agent supervises the companion, restarting the agent restarts the
   companion too.
5. **Rollback**: if the swap/rename itself fails, the `.bak` is restored before
   returning `{ ok:false }`. (A full *health-checked* rollback — boot the new
   build, wait, auto-revert if it does not come up — is the more robust model the
   agent's existing `streamhub-updater` implements with a 30s health wait; the
   fleet companion documents its own simpler swap+restart honestly and defers the
   health-gated rollback to that updater where present.)

The result (`ok` + `message`, the running `version` after restart) is reported on
`.../cmd/result`.

## Security model

- **MQTT authentication.** The fleet plane uses the **same broker + the same
  per-app credentials** as the app's event publishing. The broker URL is
  tenant-controlled and passes the core's **egress SSRF guard** (scheme allowlist
  `mqtt/mqtts/ws/wss/tcp` + private/loopback/metadata rejection unless
  `STREAMHUB_ALLOW_PRIVATE_MQTT_BROKER=1` for on-prem). **Use `mqtts://` +
  per-agent broker credentials in production** — the topic namespace is not a
  trust boundary on its own (any client with broker write to `<prefix>/agents/+/
  cmd` could command an agent), so broker ACLs scoping each agent to its own
  subtree are strongly recommended.
- **Command authorization.** Every command is issued through the authenticated
  REST route (`config:write` on the app) — there is no unauthenticated command
  path in the core. Commands are validated server-side before publish
  (`fleet.protocol.validateCommand`): unknown commands are rejected, and `ota`
  **requires** a well-formed `http(s)` url, a non-empty version and a 64-hex
  sha256.
- **OTA integrity.** The SHA-256 is **mandatory** and verified on the agent
  before the binary is swapped — it is the one gate on running a remotely-fetched
  binary. Serve builds over HTTPS from a trusted origin. Signature verification
  (GPG/minisign over the build) is a natural hardening on top of the hash and is
  the recommended next step for untrusted networks.
- **Never-throws.** Like the callbacks/MQTT taps, every fleet path is best-effort
  and never throws into the caller; a broker outage cannot break the dashboard or
  the emitting flow.

## Tests

- Core (`go test ./internal/fleet/`): `fleet_test.go` — topics + validation +
  telemetry parse (incl. battery clamp/omission), telemetry ingest → registry/db, command publishes the right
  payload with a fake MQTT `Factory`, result resolution, validation + inactive
  guard, never-throws, and the HTTP envelope + error mapping. The manifest is
  checked with every built-in by `internal/plugins` (`TestBuiltinsCatalogIsValid`).
  `battery_test.go` — the battery monitor: latch + hysteresis, per-agent
  independence, no-battery-host skip, disabled-threshold skip, latch forgotten
  when the agent disappears, never-panics, the ticker drives a pass, and the
  Service-backed wiring (telemetry → registry → event + `metrics.battery`).
- Web: `panel.test.tsx` (vitest — renders agents from a mocked GET, battery
  only on agents that report one; an action POSTs the right body) + `logic.spec.ts` (node:test — parsing/format/sparkline).
- Agent (pytest): `scripts/test_fleet_agent.py` — telemetry serialization +
  command dispatch (restart/ota/config/ping) with mocked MQTT + mocked
  download/subprocess + sha256 verify + rollback.

## What needs a live broker + agent to verify

The unit suites mock the broker end-to-end. Verified live on 3.1.0 (Go core +
mosquitto 2, a simulated agent with `mosquitto_pub/sub`): retained telemetry
delivered to a subscriber that connects later, the LWT offline flip on an abrupt
agent drop, and the `ping` command round-trip (`cmd` → `cmd/result` → `ok`).
Still needs a real StreamHub Agent: a real OTA download+swap+restart+rollback,
and broker-ACL scoping per agent.
