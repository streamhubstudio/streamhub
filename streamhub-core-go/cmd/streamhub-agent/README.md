# streamhub-agent — RTSP/ONVIF camera gateway

`streamhub-agent` makes **standard RTSP/ONVIF cameras** behave like OpenCam
devices. Each camera in the config gets its own device on the cloud's MQTT
broker and speaks the StreamHub camera contract (`api: 1`): retained
`hello`/`status`/`state`, `event` lines and uniform command answers. The
gateway does the camera's work for it:

| Capability | How |
|---|---|
| Live relay | one ffmpeg per camera, **one RTSP session**, stream copy (`-c:v copy`) to the RTMP ingest |
| Recording | the same ffmpeg tees MP4 segments to local storage (`segment_min`, default 30) |
| Main / sub stream | `stream/set {source: 0\|1}` switches between `rtsp` and `rtsp_sub` |
| Snapshots | keyframe-only JPEG grab, sent to the upload webhook (multipart, Bearer token) plus a 320 px thumb on MQTT |
| PTZ | ONVIF (WS-Security digest): continuous move with a dead-man timer, stop, home, presets, status |
| Config | `config/get` (secrets masked), `config/import`/`config/set` with `if_rev`, persisted in a 0600 overlay |
| Storage | oldest-first pruning when the disk passes `disk_high_pct`, down to `disk_low_pct` |
| Resilience | ffmpeg restarts with 2 → 30 s backoff and never gives up; MQTT auto-reconnects; LWT marks the device offline |

It's a single static Go binary. The only thing it needs at runtime is an
`ffmpeg` binary. It runs on 32-bit ARM boards (Luckfox Pico, RV1106) and on any
Linux host. The field results are in
[AGENT-FIELD-TESTS.md](../../../streamhub-docs/testing/AGENT-FIELD-TESTS.md).

## Build

```bash
# from streamhub-core-go/
go build -ldflags "-s -w -X main.version=0.1.0" -o bin/streamhub-agent ./cmd/streamhub-agent

# Luckfox Pico (ARMv7, static)
CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 \
  go build -trimpath -ldflags "-s -w -X main.version=0.1.0" -o bin/streamhub-agent-armv7 ./cmd/streamhub-agent
```

The binary bundles the Mozilla CA roots (`x509roots/fallback`), so MQTT over
TLS works on boards that have no `/etc/ssl/certs`.

## Configure

`agent.json`:

```json
{
  "id": "gw-01",
  "ffmpeg": "/opt/streamhub/ffmpeg",
  "data_dir": "/mnt/sdcard/streamhub/rec",
  "state_interval_s": 30,
  "disk_high_pct": 90,
  "disk_low_pct": 85,
  "cameras": [
    {
      "name": "Front door",
      "rtsp": "rtsp://USER:PASSWORD@192.168.1.50:554/ch0",
      "rtsp_sub": "rtsp://USER:PASSWORD@192.168.1.50:554/ch1",
      "onvif": { "url": "http://192.168.1.50/onvif/device_service", "user": "USER", "pass": "PASSWORD" },
      "record": true,
      "segment_min": 30,
      "audio": "auto",
      "credentials": "front-door.json"
    }
  ]
}
```

`credentials` points to the JSON the cloud hands out when a device is enrolled.
It's the same payload as the OpenCam QR code: `device`, `stream` (RTMP url and
key), `mqtt` (host, port, TLS, user, password, `base_topic`) and
`upload.webhook`. You can also put these fields inline in the camera object.

| Field | Default | Notes |
|---|---|---|
| `ffmpeg` | `ffmpeg` on `PATH` | a static build works. A static glibc ffmpeg can't resolve DNS, so the gateway passes it IPs |
| `audio` | `auto` | `auto` copies AAC, re-encodes anything else to AAC and drops the track if there is none. `copy`, `aac` and `off` force a mode |
| `record` | `false` | needs `data_dir`. Segments go to `<data_dir>/<device>/YYYY-MM-DD_HH-MM-SS.mp4` |
| `rtsp_sub` | — | without it, `stream/set {source: 1}` answers `unsupported` |
| `onvif` | — | without it, `ptz/*` answers `unsupported` |

## Run

```bash
streamhub-agent -config /etc/streamhub/agent.json
streamhub-agent -version
```

Logs go to stderr. Credentials and stream keys are redacted from logs and from
command answers.

## Commands

| Group | Commands |
|---|---|
| device | `status`, `hello`, `events`, `system/status`, `system/reboot` (restarts the device's pipeline and reconnects with a new `boot_id`) |
| stream | `stream/start`, `stream/stop`, `stream/status`, `stream/set` (`source`, `url`, `key`) |
| snapshot | `snapshot/take` |
| record | `record/start`, `record/stop`, `record/status`, `record/list` |
| ptz | `ptz/dir` (expires after 1 s), `ptz/stop`, `ptz/home`, `ptz/presets`, `ptz/preset`, `ptz/preset-save`, `ptz/preset-delete`, `ptz/status` |
| config | `config/get`, `config/import`, `config/set` |

## Sizing

These numbers were measured on a Luckfox Pico Max (RV1106, Cortex-A7, 256 MB)
with 1080p H.264 cameras at 2.2 Mbps, each one relayed and recorded:

- **9 cameras** at about 70 % CPU. That's the comfortable limit.
- **11 cameras** is the edge.
- **13 cameras** saturates the CPU.
- RAM is never the bottleneck. The gateway uses about 9 MB RSS, plus about 14 MB per ffmpeg.
- When the source audio isn't AAC, every camera pays for an AAC re-encode (about 11 % CPU on this board).
