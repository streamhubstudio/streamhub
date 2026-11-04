# Cameras — OpenCam fleet console over MQTT

A console for **OpenCam** cameras (Thingino firmware; the reference unit is the
Cinnado D1, Ingenic T23N) spread over a site — for example one PTZ camera per
stand in a shopping mall. Over the app's MQTT broker it shows every camera with
its live state and lets an operator drive it: PTZ pad with a deadman,
stream start/stop and a temporary HD switch, snapshot, voice test and reboot,
each command tracked through its phases. It also generates the `config.ini`
that provisions a new camera from its microSD.

It is the `cameras` **Studio App** (`kind: 'app'`, app-tab, `version 0.1.0`,
own `cameras.db`, `needsWorker: false`; see [STUDIO-APPS.md](./STUDIO-APPS.md)),
backed by the in-core module `streamhub-core-go/internal/cameras` — the same
shape as [fleet](./fleet.md).

The wire contract is owned by the firmware repo: `opencameras/docs/STREAMHUB.md`
(`api: 1`) and `docs/MQTT.md`. The design and phases are in
`planning/OPENCAMERAS-INTEGRATION.md` §4. This page covers phase **F1
(console)**.

---

## Setup

1. Configure the app's MQTT broker (`PUT /apps/{app}/mqtt` or the Integrations
   tab) — the same broker the app uses for event publishing ([mqtt.md](./mqtt.md)).
   A broker on a private address needs `STREAMHUB_ALLOW_PRIVATE_MQTT_BROKER=1`
   (SSRF guard).
2. Install and enable **Cameras** from the Marketplace. A reconcile (every
   20 s, and on every read) connects one subscriber per app where the app is
   enabled **and** `mqtt.enabled` is on.
3. Point the cameras at the broker with `mqtt.base_topic = opencam/%device`
   (the default). Cameras that publish show up on their own (*discovered*);
   cameras registered first (*alta*) are marked *provisioned* and become
   *linked* on their first `hello`.

### Config (`configSchema`)

| Key | Default | Meaning |
|---|---|---|
| `baseTopic` | `opencam` | topic root; must match the firmware's `mqtt.base_topic` prefix |
| `offlineAfterSec` | 180 | stale backstop beyond the LWT: no live traffic for this long → offline |
| `commandExpSec` | 30 | `exp` sent with each command (the camera drops a late one with `code: expired`) |
| `longCommandTimeoutSec` | 900 | how long an `accepted` long command may stay open |
| `historyPoints` | 120 | state samples kept per camera (RSSI, free RAM, load, queue, SD, bitrate) |
| `eventsPerCamera` | 2000 | event-log ring per camera |
| `hdRevertMin` | 5 | the HD switch returns to the sub-stream after this many minutes |
| `brokerPublicUrl` | `""` | what the cameras dial, written into `config.ini` (empty = the app's `mqtt.url`) |
| `rtmpPublicUrl` | `""` | default stream URL for `config.ini` when a camera has none |
| `iniUseAppBrokerCredentials` | `false` | lab only: put the app's own broker user/password in `config.ini` |

---

## MQTT

Subscriptions (QoS 1): `<root>/+/hello`, `status`, `state`, `event`, `res/#`,
`thumb`. Commands go to `<root>/<dev>/cmd/<group>/<action>` (QoS 1, not
retained). The client delivers messages **in arrival order**, so an LWT
`offline` can never overtake the following `online`.

| Topic | What the core does |
|---|---|
| `hello` (retained) | identity + `caps`; the console offers only what `caps` lists (no PTZ pad without `ptz`). A `hello` with a new `boot_id` resolves an open reboot-like command |
| `status` (retained, LWT) | authoritative online/offline |
| `state` (retained) | last state + a history sample (live messages only; a retained replay is not live traffic) |
| `event` | bounded log; deduplicated on `(boot_id, seq)`; a `seq` gap in the same boot counts `eventsLost` and triggers one `events {n}` refill (at most every 30 s per camera), whose answer is ingested |
| `res/<cmd>` | command correlation by `id` |
| `thumb` (retained) | last JPEG (≤ 256 KB kept) for the grid when there is no stream |

### Commands

Envelope: `{id, ts, exp, if_rev?, ...args}` — `id` is a UUID, `ts` RFC 3339,
`exp` seconds, `if_rev` only on `config/set` / `config/import` (the caller's
`ifRev`, else the last known `config_rev`). Envelope keys inside `args` are
dropped.

Allowlist = the firmware's command table (`status`, `hello`, `events`, `reboot`,
`stream/*`, `snapshot/*`, `video/set`, `record/*`, `ptz/*`, `queue/*`, `wifi/*`,
`config/*`, `voice/*`, `system/*`, `firmware/*`, `recovery/status`, `ini/*`,
`sd/*`). The capability gate (`ptz/*` → `ptz`, `voice/*` → `voice`, `record/*`
→ `record`, `sd/*` → `sd`) applies only when `hello.caps` is known; a refused
command answers 409 without publishing.

**Dangerous** commands (`reboot`, `system/reboot`, `ini/reset`,
`firmware/upgrade`, `queue/purge`, `wifi/remove`, `sd/format`) need
`"confirm": true` on the generic route and are written to the audit log
(`cameras.command`). `sd/format` also needs `args.confirm` = the device id.

Phases: `pending` → (`accepted` → `progress` with `pct`) → `done` | `failed`
(with the camera's `code`) | `timeout`. A command with no answer times out
after `exp + 10 s`; an `accepted` long command after `longCommandTimeoutSec`.
A late answer still lands on a timed-out row. A reboot-like command
(`reboot`, `system/reboot`, `ini/reset`, `firmware/upgrade`) is resolved
`done` when the camera reconnects with a different `boot_id`. `waitMs` (≤ 20 s)
on any POST blocks until the command settles (or a long one is accepted).

**PTZ deadman.** The pad sends `ptz/dir {dir, speed, hold_ms: 500}` every
300 ms while a direction is held and `ptz/stop` on release. `ptz/dir` is
**ephemeral**: published with `exp: 2` and not stored (status `sent`). If the
network drops with the button pressed, the camera stops on its own after
`hold_ms`.

**HD.** `stream/hd {on: true}` sends `stream/set {source: 0}` and schedules
`stream/set {source: 1}` after `hdRevertMin` (in memory: a core restart while
HD is on leaves the camera on the main stream until the next toggle).

---

## REST

Base `/api/v1/apps/{app}/plugins/cameras`, Bearer, `config:read|write`.
Full list in [api/README.md](../api/README.md#cameras-studio-app-opencam-console).

Inventory and reads: `GET cameras` (filters `site`, `stand`, `tag`,
`online`), `GET cameras/{device}` (camera + state history + 20 commands + 50
events), `GET cameras/{device}/events`, `GET cameras/{device}/thumb`,
`GET cameras/{device}/commands/{id}`.

Alta and provisioning: `POST cameras` (`device` + `name`, `site`, `stand`,
`model`, `room`, `streamUrl`, `streamKey`, `tags`, optional `mqttUser` /
`mqttPass`; mints `cam-<device>` + a random password otherwise), `PATCH` /
`DELETE cameras/{device}`, `GET cameras/{device}/config.ini` (**config:write**:
it carries the camera's broker password).

The dashboard's *Add camera* form can first create a passthrough RTMP ingress
(`POST /apps/{app}/ingress {mode: passthrough, inputType: rtmp, room}`) and
store its URL/key on the camera, so the `config.ini` comes out complete and the
console plays the camera's HLS (`/hls/<app>/<room>/index.m3u8`).

Commands: `POST cameras/{device}/command {cmd, args?, exp?, ifRev?, confirm?,
waitMs?}` and one route per console action — `ptz/move`, `ptz/stop`,
`ptz/home`, `ptz/preset`, `stream/start`, `stream/stop`, `stream/hd`,
`snapshot`, `reboot` (audited), `voice/test`.

### `config.ini`

```ini
[device]
id = stand-02

[mqtt]
enabled = 1
host = mqtt.example.com
port = 8883
tls = 1
user = cam-stand-02
pass = <generated>
base_topic = opencam/%device

[stream]
url = rtmp://media.example.com:1935/live
key = <stream key of the camera's ingress>
source = 1
audio = 1
autostart = 1

[streamhub]
api = 1
app = cameras
```

Host/port/TLS come from `brokerPublicUrl` (or the app's `mqtt.url` + `mqtt.tls`);
a `ws(s)://` broker URL gets a comment, since OpenCam speaks MQTT over TCP.
StreamHub does **not** create the broker credential yet (F3: per-camera ACL via
the broker's API) — the file says which ACL to create.

---

## Simulator

`streamhub-core-go/cmd/opencam-sim` simulates N cameras against a real broker,
speaking the contract: retained `hello`/`status`/`state`/`thumb`, LWT, events
with `seq`/`boot_id`, every console command with the right phases, PTZ motion
with the deadman, presets, `config_rev` + `conflict`, `busy` on a second long
command, `expired`, `unsupported`, reboot (LWT offline → new `boot_id`) and OTA
(`progress` → reboot with the bumped version).

```bash
go build -o bin/opencam-sim ./cmd/opencam-sim
./bin/opencam-sim -broker mqtt://127.0.0.1:1883 -devices stand-01,stand-02
./bin/opencam-sim -broker mqtt://127.0.0.1:1883 -n 8 -prefix sim- -state 5s
./bin/opencam-sim -broker mqtt://127.0.0.1:1883 -devices old-1 -no-ptz -silent ini/status
```

The same device logic (`internal/cameras/opencamsim`) runs over an in-memory
broker in the unit tests.

---

## Not in F1

Config editor with `rev` and diff, Wi-Fi and offline-queue panels, alerts and
domain events (`camera.offline`, `camera.safe_mode`, …) through callbacks /
Streamflow, automatic ingress + broker credential on alta, named presets list,
microSD/VOD sync, talkback, OTA rollouts — phases F2–F4 of the plan.
