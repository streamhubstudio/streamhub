# StreamHub Agent — Project Context

> Deep reference for the C edge agent: architecture, platforms, build/deploy,
> source map. For the quick start and install, see `README.md`.
>
> Version 1.12.

---

## Table of Contents

1. [Overview](#overview)
2. [Platforms](#platforms)
3. [Configuration & connecting to StreamHub](#configuration--connecting-to-streamhub)
4. [Architecture](#architecture)
5. [Build System](#build-system)
6. [Deployment](#deployment)
7. [Source Code Reference](#source-code-reference)
8. [StreamHub API calls](#streamhub-api-calls)
9. [Local Web UI API](#local-web-ui-api)
10. [Memory Optimization History](#memory-optimization-history)
11. [Known Issues](#known-issues)
12. [Version History](#version-history)

---

## Overview

**streamhub-agent** is a lightweight embedded C surveillance agent — the
**companion to a StreamHub media server**. It pulls CCTV camera RTSP feeds and
pushes them to StreamHub (turning any camera into a StreamHub stream in one
command), records locally, and heartbeats back.

AI detection (yolo object detection, deface face-blurring) is a **per-camera
mode** (`cameras[].detect.mode`, default `remote`):
- **`remote`** — inference runs **server-side on StreamHub**; the agent only
  **subscribes** to the results (no ML on the device). Best for demos / few
  cameras / GPU-less boxes.
- **`edge`** — inference runs **on the device** via a local YOLO worker
  (`scripts/detect.py`); no continuous upload needed. Best for high camera
  counts / constrained bandwidth / privacy, where edge inference scales better.
- **`off`** — relay + record only.

Originally built for the **Luckfox Pico Max** (Rockchip RV1106, ARM Cortex-A7
1.2 GHz, 256 MB RAM, uClibc); also runs on Linux x64 and Windows x64.

### Core features
- RTSP → RTMP(S) relay to StreamHub via ffmpeg (copy codec, no transcoding)
- **Mode-aware detection** (`src/detect.c` dispatcher): `remote` polls
  StreamHub's plugin `/live` endpoint (`src/detect_remote.c`); `edge` spawns a
  local YOLO+ByteTrack worker (`src/detect_edge.c`, `scripts/detect.py`). Both
  republish events to the web UI + MQTT in one shape.
- Video recording in 30-minute segments (stream copy; optional 5 fps libx264 re-encode)
- Streaming S3 upload of recordings (no full-file malloc)
- JPEG snapshot capture + upload
- Agent/camera callbacks to StreamHub (heartbeat, records, io-error, setup)
- Optional MQTT telemetry (heartbeat, status, commands)
- Embedded web configuration portal (Tailwind CSS)
- Hardware watchdog (embedded only), log rotation, zombie reaping
- Firmware OTA upload + rollback (embedded)

---

## Platforms

### Luckfox Pico (ARM32, uClibc) — embedded target

**Build**: `make build-luckfox` (Docker + Rockchip toolchain; builds OpenSSL
1.1.1w from source).

| Spec | Value |
|------|-------|
| SoC | Rockchip RV1106 (ARM Cortex-A7 @ 1.2 GHz) |
| RAM | 256 MB DDR3 (~120–155 MB usable after kernel) |
| libc | uClibc |
| Kernel | Linux 5.10.x |
| Init | BusyBox init (no systemd) |
| Binary | ~102 KB dynamic, stripped |
| Agent RSS | ~2.3 MB |

**Platform features**: `posix_spawn()` subprocesses, `pthread` workers (256 KB
stack), `sendfile()` zero-copy, `posix_fadvise(DONTNEED)`, hardware watchdog
(`/dev/watchdog`, 30 s), `oom_score_adj=1000` for ffmpeg children, log rotation
via `ftruncate()`, HTTP-header time sync (no NTP).

**Limitations**: no systemd (BusyBox respawn init script), no local DNS resolver
(init script adds `8.8.8.8`), `/tmp` is RAM-backed tmpfs (unbounded writes → OOM),
ffmpeg must use `-threads 1`, ~2 cameras max for recording.

**Toolchain**: `arm-rockchip830-linux-uclibcgnueabihf-gcc`, expected under
`/tmp/luckfox-toolchain/` (mounted into the build container).

### Linux x64 (glibc)

**Build**: `make build-linux-x64` (Docker `gcc:13`, which ships OpenSSL headers).

| Spec | Value |
|------|-------|
| Binary | ~130–170 KB dynamic, stripped |
| Requires | OpenSSL 1.1+, libpthread, ffmpeg (runtime) |
| Service | systemd unit (`etc/streamhub-agent.service`, installed by `scripts/install.sh`) |

No hardware watchdog (watchdog calls are no-ops). This is the target the
one-command installer serves (also `aarch64` / `armv7` via prebuilt release
binaries or a from-source build).

### Windows x64 (MinGW-w64)

**Build**: `make build-windows-x64` (remote build on a MinGW Windows host; see
`WIN_VM` in the Makefile).

| Spec | Value |
|------|-------|
| Binary | `streamhub-agent.exe` (~150 KB, embedded icon) |
| Requires | OpenSSL DLLs (libssl, libcrypto) in PATH |
| Service | `StreamHubAgent` (`--install` / `--uninstall`, auto-start + auto-restart) |

**Features**: `CreateProcessW()`, `_beginthreadex()` workers, `WSAPoll()`, CA
certs from the Windows Certificate Store, chunked HTTP, file logging with
rotation. **No-ops**: `sendfile`, `fadvise`, OOM score, watchdog, zombie reaping.

### macOS (development only)

**Build**: `make` (auto-detects Homebrew OpenSSL). Compile/syntax checking only —
not a deployment target.

---

## Configuration & connecting to StreamHub

All configuration is two files (see `README.md` for the full key table):

- **`config.yml`** (template: `config.example.yml`) — `agent:` (id, timezone,
  records, `stream_server`, `callback_url`, `tenant`), `mqtt:`, `fleet:`
  (fleet-management over MQTT — `interval > 0` spawns `scripts/fleet_agent.py`),
  `storage:`, `cameras:` (each with a `detect:` sub-block).
- **`secrets.ini`** (template: `secrets.example.ini`) — `[streamhub] api_token`
  (the `sk_` bearer token) and `[s3] access_key / secret_key`. The API token and
  S3 keys are read **only** from here, never from `config.yml`.

Both are gitignored. Default paths: `/etc/streamhub-agent/` (systemd installs) or
`/userdata/streamhub/` (embedded); Windows uses the working directory.

**The agent talks to exactly one StreamHub host** (`callback_url`, no scheme):
- REST API at `https://<callback_url>/api/v1`
- RTMP(S) ingest at `<stream_server>` → publishes `<app>-<cam_id>` (or an
  explicit per-camera `stream_key`)
- Detection subscription (per camera in **remote** mode):
  `GET /api/v1/apps/<app>/plugins/<plugin>/live?room=<room>`. In **edge** mode no
  server calls are made for detection — inference is local.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    main.c (poll event loop)                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐ │
│  │ webui.c  │  │ mqtt_    │  │snapshot.c│  │ recorder.c  │ │
│  │ (web UI) │  │ client.c │  │(JPEG)    │  │ (30m segs)  │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬──────┘ │
│  ┌────┴─────┐  ┌────┴─────┐  ┌────┴─────┐  ┌──────┴──────┐ │
│  │ detect.c │  │  http.c  │  │  s3.c    │  │  stream.c   │ │
│  │(dispatch)│  │  (TLS)   │  │(uploads) │  │  (RTMP out) │ │
│  │remote/edge│ │          │  │          │  │             │ │
│  └────┬─────┘  └──────────┘  └──────────┘  └─────────────┘ │
│  ┌────┴─────┐  ┌──────────┐                                  │
│  │ config.c │  │  api.c   │  StreamHub callbacks (/api/v1)   │
│  └──────────┘  └──────────┘                                  │
│  ┌──────────────────────────────────────────────────────────┐│
│  │  platform.h + platform_{posix,win32}.c                   ││
│  │  (spawn, pthread workers, sockets, sysinfo, sendfile,    ││
│  │   signals, zombie reaper)                                ││
│  └──────────────────────────────────────────────────────────┘│
│  ┌──────────────────────────────────────────────────────────┐│
│  │  storage.c │ watchdog.c │ util.c │ log.c                 ││
│  └──────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘

poll() unifies: MQTT socket + web UI listen + web UI clients
Workers: pthread (snapshot, heartbeat, S3 upload, detect fetch)
Subprocesses: posix_spawn / CreateProcess (ffmpeg)
```

### Event loop (main.c)
Single-threaded `poll()` loop; MQTT fd + web UI fds in one call. Timer tasks:
snapshot (60 s), heartbeat (60 s), recording check (5 s), remote detection poll
(per-camera `poll_interval`, default 2 s, on a background thread), edge detection
tick (1 s, main thread — worker health + events refresh), upload sync (10 m),
storage rotation (3 h), log rotation (5 m), zombie reap (5 s). Watchdog fed each
iteration.

### Detection dispatch (detect.c + detect_remote.c + detect_edge.c)
`detect.c` is a thin dispatcher on `cam->detect.mode`; both backends publish the
latest detections into `ctx->events` in ONE shape, so `detect_read_events` (web
UI / `/api/camera/detection/events`) and the MQTT notify path never branch on the
mode.

- **remote** (`detect_remote.c`): no worker process. `detect_remote_start`
  validates the StreamHub config and marks the subscription active. A background
  worker thread calls the **blocking** `detect_fetch_events` (HTTP GET to the
  plugin `/live` endpoint), which translates StreamHub's payload into the unified
  event shape; the main thread copies results into the ctx. Zones/lines and
  tracker ids are server-side seams the live feed does not carry.
- **edge** (`detect_edge.c`): spawns `scripts/detect.py` (one worker per camera,
  ultralytics + opencv) which reads RTSP, runs YOLO + ByteTrack and writes
  `frame.jpg` + `detections.json`. `detect_tick` (main thread, ~1 Hz,
  non-blocking) reaps/restarts the worker with backoff and mirrors the events
  file into the ctx. Zones/lines and tracker ids ARE filled in locally. Requires
  the edge ML deps (`scripts/requirements.txt`).
- **off**: `detect_start` is a no-op.

Contract + shared event shape: `src/detect.h`; internal seam:
`src/detect_internal.h`.

### Key design decisions
- **pthread workers** instead of `fork()` — saves ~70–90 MB per worker on embedded
- **Streaming S3 upload** — SHA-256 hash + chunked HTTP PUT, no `malloc(fsize)`
- **posix_spawn()** for ffmpeg — lower memory than `fork()+exec()`
- **Persistent MQTT buffer** — `memmove()` for partial TCP packets
- **sendfile() + fadvise(DONTNEED)** — zero-copy playback without page-cache OOM
- **Non-blocking I/O**, HTTP/1.0, max 3 concurrent web-UI clients
- **Exponential backoff** for stream/recorder restarts (3→60 s)
- **RTMP hostname resolved to IP** before ffmpeg (static ffmpeg has no DNS)
- **Atomic config writes** (write `.tmp`, rename)

---

## Build System

| Target | Description |
|--------|-------------|
| `make` | Build for the current platform (macOS/Linux dev) |
| `make build-luckfox` | ARM32 uClibc via Docker (builds OpenSSL from source) |
| `make build-linux-x64` | x86_64 glibc via Docker `gcc:13` |
| `make build-windows-x64` | x86_64 MinGW via a remote Windows host |
| `make build-all` | All three platforms |
| `make updater` | Build the companion `streamhub-updater` |
| `make deploy`, `deploy-www`, `deploy-init`, `deploy-all` | Push to the embedded device |
| `make deploy-windows` | Deploy the `.exe` to the Windows host |
| `make clean` / `make info` | Clean / show resolved build config |

**Build requirements**: Docker (Luckfox + Linux x64), the Rockchip ARM toolchain
in `/tmp/luckfox-toolchain/` (Luckfox), a MinGW-w64 Windows host (Windows),
Homebrew OpenSSL (macOS). Override the cross prefix with
`make CROSS_COMPILE=<prefix>-`; `STATIC=1` links statically.

Deploy targets (`deploy-*`, `WIN_*`, `DEVICE`) hardcode lab host IPs/passwords —
they are developer conveniences, not part of a shipped install. Point them at
your own hardware.

---

## Deployment

### systemd (Linux x64 / ARM)
`scripts/install.sh` installs the binary to `/usr/local/bin`, seeds
`/etc/streamhub-agent/{config.yml,secrets.ini}`, and enables the
`etc/streamhub-agent.service` unit. See `README.md`. Logs: `journalctl -u
streamhub-agent -f`.

### Embedded (Luckfox, BusyBox)
`make deploy-all` pushes binary + web UI + `etc/S95streamhub` (respawn loop, log
rotation, DNS bootstrap, HTTP time-sync) to `/etc/init.d/S95streamhub`. Config in
`/userdata/streamhub/`. Optional boot order: `S90netbird` (legacy VPN) →
`S94streamhub-updater` → `S95streamhub`.

```bash
# start/stop/restart/status
/etc/init.d/S95streamhub restart
# logs (embedded log lives in tmpfs, rotated at ~512 KB)
tail -50 /tmp/agent.log
```

---

## Source Code Reference

| File | Purpose |
|------|---------|
| `src/main.c` | Event loop, unified `poll()`, timer dispatch, MQTT handler, worker dispatch |
| `src/config.c` / `.h` | `config.yml` + `secrets.ini` parsing, atomic save, factory reset, `detect.mode` |
| `src/detect.c` / `.h` | **Detection dispatcher** — routes start/stop/tick/read on `detect.mode`; unified event shape |
| `src/detect_remote.c` | Remote backend — polls StreamHub plugin `/live`, translates events (subscriber) |
| `src/detect_edge.c` | Edge backend — spawns/reaps the local YOLO worker, mirrors its events file |
| `src/detect_internal.h` | Internal seam between the dispatcher and the two backends |
| `src/onvif.c` / `.h` | ONVIF C side: `onvif` CLI dispatch (spawns the Python tool) + periodic re-scan tick |
| `src/fleet.c` / `.h` | Fleet C side: supervises `scripts/fleet_agent.py` from the main loop (spawn + respawn), gated on `fleet.interval` |
| `scripts/detect.py` | Edge-mode inference worker (YOLO + ByteTrack); ML deps only needed for edge |
| `scripts/onvif.py` | ONVIF discovery + StreamHub registration (WS-Discovery, Profile S, ingress API) — stdlib-only |
| `scripts/test_onvif.py` | pytest suite for onvif.py (mocked SOAP/socket/API; `python3 -m pytest scripts/`) |
| `scripts/fleet_agent.py` | Fleet MQTT companion (paho-mqtt): telemetry + LWT + restart/OTA/config/ping over `streamhub/<app>/agents/<id>/…` |
| `scripts/test_fleet_agent.py` | pytest suite for the fleet companion (mocked MQTT/download/restart; `python3 -m pytest scripts/`) — 19 tests |
| `src/webui.c` / `.h` | Embedded HTTP server + API handlers + static files + recordings player |
| `src/mqtt_client.c` / `.h` | MQTT 3.1.1 client (persistent buffer, `poll()` integration) |
| `src/http.c` / `.h` | TLS HTTP client (GET, POST JSON/multipart, PUT streaming) |
| `src/s3.c` / `.h` | AWS SigV4 streaming upload (SHA-256 + chunked PUT) |
| `src/snapshot.c` / `.h` | JPEG capture via ffmpeg → upload |
| `src/recorder.c` / `.h` | 30-min segment recording, preview, S3 upload |
| `src/stream.c` / `.h` | RTSP→RTMP relay via ffmpeg with backoff |
| `src/storage.c` / `.h` | SD/disk detection, TTL rotation |
| `src/api.c` / `.h` | StreamHub `/api/v1` callbacks (heartbeat, records, io-error, setup) |
| `src/sync.c` / `.h` | Pending-upload reconciliation |
| `src/util.c` / `.h` | Helpers (resolve host, sha256, time) |
| `src/log.c` / `.h` | Logging + `log_rotate()` for tmpfs |
| `src/watchdog.c` / `.h` | `/dev/watchdog` (no-op off embedded) |
| `src/platform.h` | Platform abstraction API |
| `src/platform_posix.c` | POSIX: pthreads, posix_spawn, sendfile, fadvise, reaper |
| `src/platform_win32.c` | Windows: CreateProcess, threads, WSAPoll |
| `src/service_win32.c` / `.h` | Windows service (`--install`/`--uninstall`, SCM) |
| `src/updater_main.c` | Companion `streamhub-updater` (OTA watchdog) |
| `vendor/cjson/`, `vendor/mqtt/` | cJSON + MQTT-C |
| `www/` | Web UI (index.html, app.js, tailwind.js) |

### Key data structures

```c
// cam_detect_t (config.h) — per-camera detection config
typedef struct {
    bool  enabled;
    detect_mode_t mode;      // DETECT_MODE_REMOTE (default) | _EDGE | _OFF
    char  plugin[24];        // remote: StreamHub plugin id "yolo" | "deface"
    int   poll_interval;     // remote: seconds between /live polls (default 2)
    bool  notify_mqtt;
    // edge: applied locally by scripts/detect.py; remote: advisory mirror shown
    // in the web UI (applied server-side):
    char  model[32]; float confidence; /* targets, tracker, zones, lines … */
} cam_detect_t;

// camera_t (config.h)
typedef struct {
    char id[MAX_ID_LEN]; char ip[64]; bool enabled;
    char rtsp[MAX_URL_LEN]; char resolution[16];
    char room[64];           // StreamHub room (empty → "<tenant>-<cam_id>")
    char stream_key[64];     // RTMP key (empty → "<tenant>-<cam_id>")
    cam_detect_t detect;
} camera_t;

// agent_config_t (config.h) — id, timezone, stream_server, callback_url,
// tenant, mqtt_{host,port}, s3_*, api_token (from secrets.ini), cameras[], webui_*
```

---

## StreamHub API calls

The agent calls `https://<callback_url>/api/v1/...` with a `Bearer` token
(`src/api.c`):

| Method | Path | Body / note |
|--------|------|-------------|
| `POST` | `/api/v1/apps/{app}/agents/heartbeat` | `{"id":"<agent\|cam id>"}` |
| `POST` | `/api/v1/apps/{app}/agents/records` | `{"id","record_url","record_thumbnail_url"}` |
| `POST` | `/api/v1/apps/{app}/agents/io-error` | `{"app","device_id","agent_id","error"}` |
| `GET`  | `/api/v1/agents/{agent_id}/setup` | remote auto-configuration import |
| `GET`  | `/api/v1/apps/{app}/plugins/{plugin}/live?room=<room>` | detection events, **remote mode only** (`src/detect_remote.c`) |
| `POST` | `/api/v1/apps/{app}/ingress` | ONVIF sync (`scripts/onvif.py`): `{inputType:'url', url:'rtsp://…'}` or `{inputType:'rtmp', mode:'passthrough'}` per discovered camera |
| `DELETE` | `/api/v1/apps/{app}/ingress/{id}` | ONVIF sync: replace a camera's ingress when its RTSP URI/mode changed |

---

## Local Web UI API

The device serves a local HTTP UI (default port 80, Basic auth `admin`/`admin` —
change it). Selected endpoints (`src/webui.c`):

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | uptime, memory, disk, cameras, MQTT |
| `GET/POST` | `/api/config` | read/save configuration |
| `GET` | `/api/camera/snapshot` | latest snapshot JPEG |
| `GET/POST` | `/api/yolo/config`, `/api/yolo/zones` | detection settings/zones incl. `mode` (applied locally in edge mode, advisory in remote) |
| `GET` | `/api/camera/detection/events` | latest detection events (same shape in both modes) |
| `GET` | `/api/camera/detection/preview` | annotated frame — **edge mode only** (remote returns 404 + a hint) |
| `POST` | `/api/camera/detection/start` \| `/api/camera/detection/stop` | start/stop detection (subscription in remote, worker in edge) |
| `POST` | `/api/stream/start` \| `/api/stream/stop` | start/stop RTMP relay |
| `GET` | `/api/recordings?cam=X&date=…` | list recordings |
| `GET` | `/api/recordings/play?path=…` | stream MP4 with HTTP Range (206) |
| `POST` | `/api/system/reboot`, `/api/system/firmware` | reboot / OTA firmware |

(Handler names may differ slightly; `src/webui.c` is authoritative.)

---

## Memory Optimization History

The embedded target went from ~280–470 MB peak to ~20 MB total. Highlights:

- **v1.9**: ffmpeg `-threads 1` (~34→15 MB per instance); `sendfile()` zero-copy;
  `posix_fadvise(DONTNEED)` drops page cache.
- **v1.10**: replaced `fork()` workers with **pthreads** (256 KB stack);
  **streaming S3 upload** (64 KB chunks, no `malloc(fsize)`); `posix_spawn()` for
  ffmpeg; streaming HTTP multipart; `log_rotate()` (ftruncate at 1 MB) to stop
  tmpfs OOM; persistent MQTT buffer fix (partial-packet `memmove`); DNS bootstrap;
  duplicate-instance guard; `plat_reap_zombies()` every 5 s.

Result on Luckfox: ~2.3 MB agent RSS, 150 MB+ free, zero OOM/zombies over 24 h+.

---

## Known Issues

- Camera RTSP connectivity depends on the physical network/camera.
- S3 uploads may fail on flaky links (retried on the next sync cycle).
- MQTT is plain TCP (no TLS) when enabled.
- Web UI password is stored in plaintext in `config.yml` — restrict file access.
- In **remote** mode, detection zones/lines and tracker ids are not carried by the
  plugin live feed (server-side seams); **edge** mode fills them in locally.
- **Edge** mode requires the ML deps (`scripts/requirements.txt`) and enough
  CPU/GPU on the device; on a bare Luckfox it is impractical — edge is aimed at
  x86_64 / ARM64 boxes with headroom.

---

## Version History

| Version | Focus |
|---------|-------|
| 1.14 | **Low-memory boards (Luckfox Pico Pro/Max)**: recording is now a stream copy (`-c:v copy`, AAC 32k audio) instead of a 5 fps libx264 re-encode (≈150 MB → ≈14 MB RSS per camera; legacy path behind `records_transcode: true`); snapshot ffmpeg gated on MemAvailable (skip <24 MB, 640 px <36 MB, keyframe-only decode); oldest-first SD pruning at 90 % → 85 % every 10 min (skips files <2 min old); init script: BusyBox-compatible HTTP-date time sync and orphan-ffmpeg kill on respawn/stop |
| 1.13 | **Fleet management over MQTT** (`fleet.interval > 0`): `scripts/fleet_agent.py` (paho-mqtt) spawned + supervised by `src/fleet.c`, publishes health telemetry + an MQTT Last-Will, and handles remote **restart / OTA (sha256-verified + rollback) / config push / ping** on `streamhub/<app>/agents/<id>/…`. Drives the StreamHub dashboard **Fleet** tab. `config.yml fleet:` block (round-tripped), `install.sh --fleet`, pytest suite (19) |
| 1.12 | **ONVIF discovery + auto-registration** (`streamhub-agent onvif scan\|sync`): WS-Discovery + Profile S via stdlib-only `scripts/onvif.py`, camera creds/overrides in `config.yml onvif:`, idempotent `onvif-cameras.json` state (serial/MAC → ingressId), url-pull or rtmp-passthrough ingresses, optional daemon re-scan (`rescan_interval`), pytest suite |
| 1.11 | StreamHub Agent: detection as a per-camera **mode** (remote subscriber / edge on-device worker / off) with a mode dispatcher; StreamHub Agent rebrand, one-command Linux/ARM installer (`--edge` for on-device ML deps) + systemd unit, Windows service |
| 1.10 | OOM elimination (fork→pthreads, streaming S3/HTTP), MQTT parser fix, zombie reaper, log rotation |
| 1.9 | Recordings player, sendfile zero-copy, first OOM fixes, RTMP fix |
| 1.7–1.8 | Snapshots, heartbeat, speed test, MQTT events, backend compatibility |
| 1.5–1.6 | Initial complete codebase + web UI |
