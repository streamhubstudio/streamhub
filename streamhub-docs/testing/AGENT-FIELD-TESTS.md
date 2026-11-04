# Agent field tests: Luckfox Pico (November 2026)

These are hardware tests of the two StreamHub agents:

| Agent | Language | Role | Version tested |
|---|---|---|---|
| **StreamHub Agent (embedded)** | C | camera recorder, relay and uploader for low-memory ARM boards | 1.14 |
| **streamhub-agent gateway** | Go | turns standard RTSP/ONVIF cameras into OpenCam devices | 0.1.0 |

The gateway is documented in
[cmd/streamhub-agent/README.md](../../streamhub-core-go/cmd/streamhub-agent/README.md),
and its unit tests are listed in [UNIT-TESTS.md](UNIT-TESTS.md).

## Summary

| Area | Result |
|---|---|
| C agent on a Pico Pro memory budget (~28 MB free) | ✅ **Pass**, after the 1.14 fixes. Before them, recording alone used ~150 MB |
| Gateway, end to end: camera → board → StreamHub → cloud panel | ✅ **Pass**. All 11 panel functions work, with no page errors and no 5xx |
| Gateway capacity on a Pico Max, 1080p cameras relayed and recorded | **9 cameras** comfortable, **11** at the edge, **13** saturates |
| Resilience: RTMP and camera outages | ✅ Recovers on its own, no restart needed |
| Bugs found on real hardware | 12 found, 12 fixed (see [Bugs found and fixed](#bugs-found-and-fixed)) |

## Test bench

| Item | Details |
|---|---|
| Board | Luckfox Pico Max: Rockchip RV1106G3, Cortex-A7 single core, 256 MB DDR3 (184 MB visible to Linux, the rest is reserved for the NPU/ISP), Buildroot with uClibc, kernel 5.10, SD card storage |
| Board limits | no CA certificates, no NTP client, no ffmpeg in the image |
| ffmpeg | static ARMv7 build 7.0.2, copied to the SD card |
| Camera | PTZ IP camera running Thingino firmware: H.264 1080p main stream, 720p sub stream, ONVIF Profile S with PTZ |
| Server | a production StreamHub 3.x core: LiveKit RTMP ingress, MQTT over TLS, upload webhook |
| Cloud panel | an OpenCam-compatible fleet panel, driven with Playwright scripts. Results were also checked through the StreamHub REST API |
| Load generator | synthetic cameras on a separate LAN host. They loop a real 1080p clip from the camera at 2.2 Mbps, over RTSP |

The board, camera and load generator were on the same LAN. Network addresses,
device IDs, credentials and stream keys are left out of this report.

---

## 1. C agent 1.14 on a Pico Pro memory budget

The Luckfox Pico Pro has 128 MB of RAM. To reproduce its memory budget on the
Pico Max, we pinned 128 MB in tmpfs. That leaves about **28 MB `MemAvailable`**,
which is what the agent has to work with on a Pico Pro.

### What broke under that budget, and the fix

| Problem | Measured | Fix in 1.14 |
|---|---|---|
| Recording re-encoded with libx264 at 5 fps | **~150 MB RSS** for one ffmpeg, leaving 2.5 MB free | recording is now a stream copy (`-c:v copy`, audio AAC 32k): **~14 MB RSS**. The old path is still there behind `records_transcode: true` |
| Snapshot ffmpeg decoded a full 1080p frame | ~40 MB peak, killed by the OOM killer | memory gate: skip below 24 MB free, scale to 640 px below 36 MB, decode keyframes only (`-skip_frame nokey -an`) |
| SD card filled up with copy-mode segments | the time-based cleanup never triggered | oldest-first pruning at 90 % → 85 %, every 10 min. Files under 2 min old are skipped |
| Time sync at boot | BusyBox `date` rejected the HTTP date, but the script still printed `Time sync: OK` | parse with `date -D`, strip `\r` |
| Agent killed with `kill -9` | its ffmpeg children kept running and held duplicate RTSP sessions | the init script kills any leftover ffmpeg on respawn and on stop |

### Results after the fixes

| Check | Result |
|---|---|
| Relay, stream copy | agent **3.6 MB** RSS, ffmpeg **14 MB**, **18 %** CPU |
| Relay and SD recording together | ✅ both work, and the memory stays within budget |
| RTMP server blackholed for 60 s | ✅ the relay reconnects on its own |
| Camera blackholed | ✅ recording and relay resume when the camera comes back |
| Python test suites (fleet, ONVIF) | ✅ 96 passed |

---

## 2. Go gateway, end to end

The path under test:

```
PTZ camera ──RTSP/ONVIF──▶ Luckfox Pico Max ──RTMP──▶ StreamHub ──WebRTC──▶ cloud panel
                              (streamhub-agent)   ◀──MQTT/TLS──▶ (commands, state)
                                                  ──HTTPS──▶ upload webhook (snapshots)
```

The camera was enrolled from the cloud panel exactly like an OpenCam camera.
The gateway uses the enrolment JSON and runs on the board as one static ARMv7
binary (7.4 MB, ~9 MB RSS). Every function below was triggered from the panel.

| # | Panel function | Result |
|---|---|---|
| 1 | Device appears **online**, with firmware version | ✅ |
| 2 | **Live view** (sub stream, 1280×720) | ✅ |
| 3 | **Take snapshot**: the photo reaches the panel through the webhook | ✅ |
| 4 | **PTZ pad**: the camera moves | ✅ pan position 4.9 → 166.4 |
| 5 | **Go home** | ✅ back to 4.9 |
| 6 | Switch to **HD** (main stream, 1920×1080) | ✅ |
| 7 | Back to **normal** (sub stream) | ✅ tested 4 toggles in a row |
| 8 | **List recordings** from the SD card | ✅ |
| 9 | **Stop streaming** | ✅ |
| 10 | **Start streaming** | ✅ |
| 11 | **Reboot**: comes back online with a new `boot_id` | ✅ ~3 s |
| — | Page errors or HTTP 5xx during the run | none |

---

## 3. Capacity on the Pico Max

Each synthetic camera ran at 1080p H.264, 2.2 Mbps. Each one was relayed over
RTMP to a test server on the LAN, not to production, and recorded to the SD
card. The source audio was AAC, so it was copied.

| Cameras | CPU | RAM free | Outputs |
|---:|---:|---:|---|
| 3 | 44 % | 140 MB | all at full rate |
| 9 | 71 % | 118 MB | all at full rate |
| 11 | ~100 % | 107 MB | all at full rate, no headroom left |
| 13 | 100 %, load rising | 90 MB | two outputs fall to ~1.25 Mbps |

- **CPU is the limit, not RAM.** Even at 13 cameras, 90 MB of RAM is still free.
- **Audio matters.** Re-encoding the audio to AAC costs about 18 % CPU per
  camera, against about 7 % for the copy-only relay. With every camera
  re-encoding, the limit dropped to **7 cameras**. Since then, the gateway's
  default `audio: auto` copies AAC sources.
- **Sizing:** plan on **up to 9 cameras per Pico Max** at 1080p.

---

## Bugs found and fixed

All of these are fixed in the code these tests cover.

| Area | Symptom | Fix |
|---|---|---|
| Gateway / ffmpeg | the static ffmpeg can't resolve DNS, so the ingress never received video | the gateway resolves hostnames itself and passes IPs to ffmpeg |
| Gateway / LiveKit ingress | republishing right after closing the previous session (HD → normal) left the ingress in `error` | wait 5 s before republishing to the same ingress |
| Gateway / commands | `ptz/dir` was randomly answered as `expired` | the core stamps `ts` in whole seconds, so expiry now compares whole seconds |
| Gateway / snapshots | the photo never arrived, because the panel rotates the webhook token with `config/import` | `config/import`/`config/set` are implemented, and the change is persisted in a 0600 overlay |
| Gateway / recordings | the panel showed an empty list | `record/list` now returns a list of `{file, size}` |
| Gateway / presets | the preset argument was read from the wrong field | it is now read from `preset` |
| Gateway / audio probe | under load the probe timed out and the audio track was dropped | the probe only reads the stream listing, runs one at a time, and failures aren't cached |
| C agent / recording | ~150 MB per recorder | stream copy (see section 1) |
| C agent / snapshot | killed by the OOM killer | memory gate (see section 1) |
| C agent / storage | the SD card filled up | oldest-first pruning |
| C agent / boot | the clock was never set | BusyBox-compatible time sync |
| C agent / supervision | orphan ffmpeg after the agent crashed | killed on respawn. The gateway sets `Pdeathsig` |

## Known limitations

- **Camera presets:** the test camera's ONVIF service lists presets but has no
  real ones (`NoToken`), so preset save and recall couldn't be checked on this
  camera. The gateway implements them with standard ONVIF calls.
- **No real Pico Pro was available.** Its 128 MB budget was emulated on the
  Pico Max, as described in section 1.
- **Static ffmpeg and DNS:** any tool that shells out to a static glibc ffmpeg
  on these boards has to pass it IP addresses.
- **LiveKit RTMP ingress:** after a session closes, wait a few seconds before
  republishing to the same ingress.
