# StreamHub Agent

A lightweight edge agent (written in C) that is the **companion to a StreamHub
media server**: it turns any CCTV camera into a StreamHub stream in one command.
Point it at a camera's RTSP feed and a StreamHub host, and the agent relays the
video to StreamHub (RTMP/RTMPS ingest), records locally, exposes a small web UI,
and heartbeats back to StreamHub.

AI detection is a **per-camera mode** — you choose *where* inference runs:

- **`remote`** (default) — StreamHub runs the yolo/deface plugin server-side and
  the agent only *subscribes* to the results. No GPU or ML deps on the device.
- **`edge`** — the agent runs inference *on the device* (local YOLO worker). No
  continuous upload needed; only the camera talks to the box.
- **`off`** — no detection (relay + record only).

Runs on tiny embedded boards (Luckfox Pico, ARM32/uClibc, ~150 MB RAM) up to
Linux x64 and Windows x64. Binary: `streamhub-agent`.

**ONVIF built in**: `streamhub-agent onvif sync` discovers every ONVIF camera
on the LAN (WS-Discovery + Profile S) and registers them in StreamHub — see
[ONVIF discovery & auto-registration](#onvif-discovery--auto-registration).

**Version: 1.12**

---

## How it works

```
  CCTV camera ──RTSP──▶  StreamHub Agent  ──RTMP(S)──▶  StreamHub media server
                              │                              │
             detect.mode:     │                        yolo / deface plugin
               remote  ───────┼─── GET /plugins/<p>/live ◀───┘  (server-side AI)
               edge    ─▶ local YOLO worker (on-device AI)
               off     ─▶ (relay + record only)
```

1. The agent reads each camera over **RTSP** and relays it to StreamHub's
   **RTMP/RTMPS ingest** (ffmpeg, copy codec — no transcoding).
2. Detection runs according to the camera's `detect.mode` (see below). Either
   way, the latest detections are exposed locally in one shape (web UI + optional
   MQTT), so nothing downstream changes when you switch modes.

Alongside detection the agent also handles local **recording** (30-min segments,
S3 upload), **snapshots**, an embedded **web UI**, **ONVIF discovery** (LAN
cameras → StreamHub ingresses, see below), and agent/camera **callbacks** to
StreamHub (`heartbeat`, `records`, `io-error`, `setup`).

---

## Detection modes — which to use

Set per camera in `config.yml` under `cameras[].detect.mode` (default `remote`):

| Mode | Where inference runs | Needs on the device | Best for |
|---|---|---|---|
| **`remote`** | StreamHub server (yolo/deface plugin) | nothing extra — just the relay | demos, low camera counts, boxes with no GPU. Simplest to run. |
| **`edge`** | on the device (local YOLO worker) | python3 + `scripts/requirements.txt` (ultralytics/opencv) | many cameras, limited/expensive uplink bandwidth, privacy (video needn't leave the box for detection). Edge inference scales better for high-camera-count CCTV. |
| **`off`** | — | nothing | relay + record only, no AI. |

- **remote** streams everything to the server and *subscribes* to the results:

  ```
  GET https://<callback_url>/api/v1/apps/<app>/plugins/<plugin>/live?room=<room>
  ```

  See `src/detect_remote.c` for the contract and the translation into the
  agent's event shape.

- **edge** spawns `scripts/detect.py` (one worker per camera) which reads the
  RTSP feed, runs YOLO + ByteTrack locally, and writes annotated frames +
  detection events that the agent serves (`src/detect_edge.c`). The extra ML
  deps are only needed for this mode — install them with `--edge` (see below) or
  `pip install -r scripts/requirements.txt`.

`src/detect.c` dispatches to the right backend on the mode; `src/detect.h`
documents the shared event shape.

---

## How it connects to a StreamHub instance

Everything points at one StreamHub host. Set these in `config.yml`
(`agent:` block) and `secrets.ini`:

| What | Key | Example |
|---|---|---|
| Control plane host (no scheme) | `agent.callback_url` | `media.example.com` — REST API at `https://media.example.com/api/v1` |
| StreamHub app (tenant) | `agent.tenant` (alias `app`) | `myapp` |
| RTMP(S) ingest base | `agent.stream_server` | `rtmps://media.example.com:443/live/` |
| REST API token (`sk_`) | `secrets.ini` `[streamhub] api_token` | `sk_…` |
| Per-camera RTSP | `cameras[].rtsp` | `rtsp://user:pass@192.168.1.50:554/…` |
| Detection mode | `cameras[].detect.mode` | `remote` (default) \| `edge` \| `off` |
| Remote plugin | `cameras[].detect.plugin` | `yolo` \| `deface` (remote mode) |

The ingest key is `<app>-<cam_id>` (e.g. `myapp-c001`) unless you set an explicit
`cameras[].stream_key` (minted by `POST /api/v1/apps/{app}/ingress`). The
detection `room` defaults to `<app>-<cam_id>` unless `cameras[].room` is set.

Full, commented templates:
- **`config.example.yml`** → copy to `config.yml`
- **`secrets.example.ini`** → copy to `secrets.ini` (holds the `sk_` token and S3 keys)

`config.yml` and `secrets.ini` are gitignored — never commit real credentials.

---

## ONVIF discovery & auto-registration

Point the agent at the LAN and every ONVIF camera appears in StreamHub:

```bash
streamhub-agent onvif scan     # discover + interrogate — prints a table (read-only)
streamhub-agent onvif sync     # scan + register each camera in StreamHub
```

The C binary dispatches the `onvif` subcommand to `scripts/onvif.py` — plain
**Python 3 stdlib, zero pip dependencies** (a minimal SOAP client instead of
`onvif-zeep`, which would drag zeep/lxml/requests onto embedded boxes). The
installer places it next to the binary; any `python3` runs it.

**How discovery works**

1. **WS-Discovery**: a SOAP Probe is multicast on UDP `239.255.255.250:3702`;
   every ONVIF device answers with its device-service URL + scopes (name,
   hardware, MAC). Non-camera WSD responders (NAS, printers, Windows) are
   filtered out.
2. **ONVIF Profile S** per device: `GetSystemDateAndTime` (clock-skew for the
   digest auth), `GetDeviceInformation` (model/serial), `GetCapabilities` →
   media service, `GetProfiles` + `GetStreamUri` → the camera's **RTSP URIs**
   (main + substream, credentials embedded).

**Credentials** live in `config.yml` under `onvif:` (same policy as
`cameras[].rtsp` — camera passwords are config, only the sk_ token/S3 keys are
secrets.ini material). Per-camera entries are matched by IP or MAC, and a
`default_credentials` try-list covers the rest (then anonymous):

```yaml
onvif:
  register_mode: url        # url (StreamHub pulls RTSP) | passthrough (HLS wall)
  prefer_stream: main       # main | sub
  rescan_interval: 0        # daemon re-sync cadence in seconds (0 = off)
  default_credentials:
    - user: admin
      password: admin
  cameras:
    - match: 192.168.1.50   # IP or MAC
      user: admin
      password: secret
      mode: passthrough     # per-camera override
      stream: sub
```

**What gets created in StreamHub** (`POST /api/v1/apps/<tenant>/ingress`, using
`agent.callback_url` + `agent.tenant` + the sk_ token — the same settings the
agent already has):

| `mode` | Ingress created | Plane | Use when |
|---|---|---|---|
| `url` (default) | `{inputType:'url', url:'rtsp://…'}` | transcode (LiveKit) — WebRTC + HLS + recording + plugins | StreamHub can **reach the camera's IP** (on-prem server, VPN/NetBird). Note: StreamHub's SSRF guard rejects pull URLs on private addresses it can't serve — the sync error explains it and points here. |
| `passthrough` | `{inputType:'rtmp', mode:'passthrough'}` | remux → HLS, ~0 CPU per camera | cloud StreamHub (camera unreachable from the server) or **HLS mosaic walls** with dozens of cameras. The returned `rtmp_url` is printed + stored — relay the camera into it (the agent's RTSP→RTMP relay is exactly that: add the camera to `cameras:` with the minted `stream_key`, or run `ffmpeg -i rtsp://… -c copy -f flv <rtmp_url>`). |

**Idempotent**: sync keeps a state file (`onvif-cameras.json` next to
`config.yml`, override with `onvif.state_file`) mapping each camera's
**serial/MAC → ingressId**. Re-runs update changed cameras (new RTSP URI or
mode ⇒ old ingress replaced) and leave the rest untouched; cameras that
disappear from the LAN are **reported as MISSING, never auto-deleted**.

**Periodic re-scan**: set `onvif.rescan_interval: 900` and the agent daemon
runs `onvif sync --quiet` in the background at that cadence (single instance,
non-blocking, logs to the journal) — new cameras on the LAN appear in
StreamHub without operator action.

**Edge / NVR-lite note**: ONVIF discovery pairs with the agent's edge story —
discover with `sync` (passthrough mode), record locally on the box
(`records_enabled`), stream the **substream** to the cloud for the wall
(`prefer_stream: sub`) and keep detection on-device (`detect.mode: edge`).
That is the low-bandwidth NVR-lite layout for multi-site installers.

Useful flags: `--timeout <s>` (discovery window), `--json` (machine-readable),
`--dry-run` (sync plan without registering), `--state <file>`, `--insecure`
(self-signed StreamHub TLS).

---

## Fleet management (MQTT)

The agent can be managed as a **fleet device** from the StreamHub dashboard's
**Fleet** tab (the `fleet` plugin) over the SAME MQTT broker configured in
`mqtt:`. Health telemetry is published continuously and the agent accepts remote
commands — **restart**, **OTA update**, **config push**, **ping**.

This runs as a small Python companion, `scripts/fleet_agent.py` (paho-mqtt),
spawned + supervised by the agent exactly like the ONVIF/edge workers (see
`src/fleet.c`). Enable it with `fleet.interval` in `config.yml`:

```yaml
mqtt:
  host: media.example.com     # shared broker — also used by the app's events
  port: 1883
fleet:
  interval: 15                # telemetry seconds; 0 = fleet management OFF
  username: ""                # default: agent.id ; use per-agent creds + tls in prod
  password: ""
  tls: false
  binary: ""                  # OTA target; empty → streamhub-agent next to the install
  unit: streamhub-agent       # systemd unit restarted after an OTA / config push
```

Install the dep with `sudo ./scripts/install.sh --fleet` (or
`pip install -r scripts/requirements-fleet.txt`). Metrics use `psutil` when
present, else `/proc` + `/sys` (stdlib only).

**Topics** (rooted at `streamhub/<agent.tenant>`):

| Topic | Dir | |
|---|---|---|
| `…/agents/<id>/telemetry` | agent→broker | retained: cpu/mem/temp/uptime/agentVersion/cameras/relay/disk |
| `…/agents/<id>/status` | agent→broker | retained; MQTT Last-Will flips it `offline` on a drop |
| `…/agents/<id>/cmd` | broker→agent | `{id,command,args,ts}` |
| `…/agents/<id>/cmd/result` | agent→broker | `{id,command,ok,message,version,ts}` |

**OTA** downloads the build from the command's `url`, **verifies its SHA-256**
(mismatch → abort, nothing swapped), atomically replaces the binary (keeping a
`.bak`), then restarts via `systemctl` (or by signalling the supervising agent);
a failed swap rolls the old binary back. Full protocol + security model:
[streamhub-docs/features/fleet.md](../vision-media-server/streamhub-docs/features/fleet.md)
in the StreamHub repo.

---

## Install

### Linux / ARM (systemd) — one command

```bash
curl -fsSL https://streamhub.studio/agent.sh | sudo bash
```

or from a checkout:

```bash
sudo ./scripts/install.sh
```

The installer (`scripts/install.sh`):
- detects the CPU arch (`x86_64` / `aarch64` / `armv7`) and OS (Debian / Ubuntu /
  generic Linux),
- installs the `streamhub-agent` binary to `/usr/local/bin` (prebuilt release, or
  builds from source in a checkout with a toolchain),
- seeds `/etc/streamhub-agent/{config.yml,secrets.ini}` if absent,
- installs + enables a **systemd** service (`streamhub-agent`, auto-start on boot,
  restart on failure),
- prints next steps.

Then:

```bash
sudoedit /etc/streamhub-agent/config.yml      # cameras + StreamHub host
sudoedit /etc/streamhub-agent/secrets.ini     # [streamhub] api_token = sk_…
sudo systemctl start streamhub-agent
journalctl -u streamhub-agent -f
```

It is idempotent (re-run to upgrade the binary; your config is kept) and reverses
with `sudo ./scripts/install.sh --uninstall` (add `--purge` to drop config+data).
`--help` lists every flag; the prebuilt-binary host is `STREAMHUB_AGENT_RELEASE_URL`.

**Remote mode (default) needs no ML deps** — the installer never pulls
torch/ultralytics. Only if you run a camera in **edge** mode do you need the
on-device inference stack; install it with:

```bash
curl -fsSL https://streamhub.studio/agent.sh | sudo bash -s -- --edge
# or, in a checkout:  sudo ./scripts/install.sh --edge
# or, manually:       pip install -r scripts/requirements.txt
```

### Embedded (Luckfox Pico, BusyBox — no systemd)

BusyBox devices have no systemd; use the init script instead:

```bash
make build-luckfox && make deploy-all   # binary + web UI + init script
```

`etc/S95streamhub` installs to `/etc/init.d/S95streamhub` (respawn loop, log
rotation, DNS bootstrap, HTTP time-sync). Config lives in `/userdata/streamhub/`.

### Windows x64

Build the `.exe` (see build matrix) then register the service:

```bat
streamhub-agent.exe --install
net start StreamHubAgent
```

---

## Platforms & build matrix

| Platform | Arch / libc | Build | Toolchain needed | Binary |
|---|---|---|---|---|
| Luckfox Pico | ARM32 (Cortex-A7) / uClibc | `make build-luckfox` | Rockchip `arm-rockchip830-linux-uclibcgnueabihf-` SDK in `/tmp/luckfox-toolchain` + Docker (builds OpenSSL 1.1.1w from source) | ~102 KB |
| Linux x64 | x86_64 / glibc | `make build-linux-x64` | Docker `gcc:13` (ships OpenSSL headers) | ~130–170 KB |
| Windows x64 | x86_64 / MSVCRT | `make build-windows-x64` | MinGW-w64 on a Windows build host (see `WIN_VM` in the Makefile) | `streamhub-agent.exe` ~150 KB |
| macOS | arm64 / x86_64 | `make` | Homebrew OpenSSL (auto-detected) — **dev/compile-check only** | n/a |

```bash
make                 # current platform (macOS/Linux dev)
make build-all       # luckfox + linux-x64 + windows-x64
make info            # show resolved CC / CFLAGS / SRC
make clean
```

The agent requires **ffmpeg** at runtime (streaming, recording, snapshots). The
Linux installer apt-installs it; embedded builds ship a static ffmpeg on the SD card.

---

## Configuration reference

`config.yml` sections (parser in `src/config.c`):

- `agent:` — id, timezone, records, `stream_server`, `callback_url`, `tenant`,
  `encryption_key`.
- `mqtt:` — optional control/telemetry broker (`host`, `port`).
- `storage:` — optional S3-compatible record uploads (`endpoint`, `bucket`,
  `region`; keys live in `secrets.ini` `[s3]`).
- `cameras:` — per-camera `id`, `ip`, `rtsp`, `resolution`, `record_path`,
  `room`, `stream_key`, and a `detect:` sub-block: `mode` (`remote`/`edge`/`off`),
  `plugin` + `poll_interval` (remote), `model`/`confidence`/`targets`/`fps`/
  `tracker` + zones/lines (edge).
- `onvif:` — ONVIF discovery/registration: `register_mode`, `prefer_stream`,
  `rescan_interval`, `discovery_timeout`, `state_file`, `default_credentials`,
  per-camera `cameras` overrides (see the ONVIF section above). Parsed by
  `scripts/onvif.py`; the C daemon only reads `rescan_interval` and preserves
  the block verbatim across web-UI config saves.

`secrets.ini` sections: `[streamhub] api_token`, `[s3] access_key / secret_key`.

The device also exposes a **local web UI** (HTTP, default port 80,
default login `admin`/`admin` — change it) for status, camera control, recordings
playback, and configuration.

---

## Recording parameters

| Parameter | Value |
|---|---|
| Video | stream copy (`-c:v copy`, no re-encode) — set `agent.records_transcode: true` for the legacy 5 fps libx264 veryfast CRF 30, max 150k (buffer 300k), meant only for low-res sources such as rkipc |
| Audio | AAC 32k (re-encoded, so G.711 cameras fit MP4/FLV) |
| Segment length | 30 minutes |
| Preview | 426×240 JPEG |
| ffmpeg flags | `-threads 1 -max_muxing_queue_size 8` |

---

## Repository layout

| Path | Purpose |
|---|---|
| `src/` | C sources — event loop, config, http/tls, s3, recorder, stream, snapshot, webui, detection (`detect.c` dispatcher, `detect_remote.c` subscriber, `detect_edge.c` local worker), `onvif.c` (ONVIF CLI dispatch + periodic re-scan), `fleet.c` (fleet companion supervisor), platform layer |
| `scripts/onvif.py` | ONVIF discovery + StreamHub auto-registration (stdlib-only Python; `streamhub-agent onvif scan\|sync`) |
| `scripts/test_onvif.py` | pytest suite for the ONVIF tool (mocked SOAP/socket/API — `python3 -m pytest scripts/`) |
| `scripts/fleet_agent.py` | fleet-management MQTT companion (paho-mqtt); spawned when `fleet.interval > 0` — telemetry + restart/OTA/config/ping |
| `scripts/test_fleet_agent.py` | pytest suite for the fleet companion (mocked MQTT/download/restart — `python3 -m pytest scripts/`) |
| `scripts/detect.py` | edge-mode inference worker (YOLO + ByteTrack); spawned only when `detect.mode: edge` |
| `scripts/requirements.txt` | edge-mode ML deps (ultralytics/opencv) — not needed for remote/off |
| `scripts/requirements-fleet.txt` | fleet-mode deps (paho-mqtt, psutil) — only for `fleet.interval > 0` |
| `scripts/install.sh` | one-command Linux/ARM installer (systemd); `--edge` adds the ML deps, `--fleet` adds paho-mqtt |
| `scripts/*.bat` | Windows service install/uninstall helpers |
| `etc/streamhub-agent.service` | systemd unit (Linux x64/ARM) |
| `etc/S95streamhub`, `etc/S94streamhub-updater` | BusyBox init scripts (embedded) |
| `etc/S90netbird`, `VPN-SETUP.md`, `NETBIRD-INTEGRATION.md` | **legacy** VPN mesh (optional; the agent reaches StreamHub directly over HTTPS/RTMPS) |
| `www/` | embedded web UI (Tailwind) |
| `res/` | Windows icon + version resource |
| `config.example.yml`, `secrets.example.ini` | config templates |
| `AGENT.md` | deep project/context reference |

See **`AGENT.md`** for architecture internals, the source-file map, memory
optimisation history, and per-platform notes.
