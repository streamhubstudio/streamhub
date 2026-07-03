# StreamHub — Functional Simulations (real media path)

These are the three end-to-end scenarios run against a **live** StreamHub node,
exercising the full pipeline that unit tests deliberately mock:

```
ffmpeg / webcam ──RTMP──▶ ingress (transcode) ──▶ LiveKit room ──WebRTC──▶ viewers
                                                        │
                                          egress (Chrome-based recorder) ──▶ MP4 ──▶ S3
                                                        │
                                               snapshots (every N s) ──▶ S3
```

Everything below is **server-side / loopback**: sources are generated on the box
with `ffmpeg`, viewers are faked with `lk load-test` and headless Chrome. This is
deliberate — routing over the real uplink (~8 Mbps) would measure the ISP, not
the node. Loopback isolates the node's own CPU/GPU limits.

Node under test: **4 vCPU / 8 GB RAM**, CPU transcode (no GPU), single node.

## Tooling

| Tool | Role |
|------|------|
| `ffmpeg` | Server-side source. Generates test content with a **burned-in live clock** (`drawtext ... %{localtime}`) for latency measurement, and pushes it to the RTMP ingress. |
| `lk load-test` | LiveKit CLI. Cheap synthetic **viewers** (`--subscribers`) to test fan-out and the viewer counter without real browsers. |
| Playwright + system Chrome | Real browser for view/latency/chat and the `/meeting` 1:1 flow. `--use-fake-device-for-media-stream` supplies a synthetic camera/mic. |
| `/health` (`ts` field) | Server clock reference for glass-to-glass latency (see below). |

### How latency is measured (glass-to-glass, ~2 s result)

1. The source `ffmpeg` burns the **server's live wall-clock** into every frame
   with `drawtext=text='%{localtime\:%T.%3N}'`, so the picture itself carries
   the time it was encoded.
2. That video goes ingress → transcode → WebRTC → into a real Chrome viewer.
3. A screenshot of the viewer shows the burned timestamp of the frame currently
   on screen. Comparing that against the **server clock** — read from
   `GET /api/v1/health` (`ts` is the server's `new Date().toISOString()`) at
   screenshot time — gives the end-to-end delay.
4. Because the burned clock and the `/health` clock are the **same machine's
   clock** (loopback), there is no clock-skew term: the difference is pure
   pipeline latency. Measured **≈ 2 s glass-to-glass** (encode + ingress
   transcode + WebRTC delivery + jitter buffer + decode).

---

## Sim 1 — StoreHub: N cameras, view + snapshots + recording

**Shape:** many fixed cameras (IDs `C000001`, `C000002`, …), each an `ffmpeg`
source pushing test content over RTMP into the ingress (which transcodes), then
watched over WebRTC. Per-camera snapshots to S3 and on-demand recording.

### Setup (reproducible)

Create/confirm the app has RTMP ingress enabled and a valid `rtmp_password`,
snapshots and recording on in its `config.yaml`. For each camera, push a
clock-burned source at the ingress:

```bash
# One camera source (repeat with C000002.. for N cameras).
# testsrc2 = moving content; drawtext burns the server's live clock for latency.
ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=25 \
  -f lavfi -i sine=frequency=1000 \
  -vf "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:\
text='C000001 %{localtime\:%T.%3N}':x=20:y=20:fontsize=42:fontcolor=white:box=1:boxcolor=black@0.6" \
  -c:v libx264 -preset veryfast -tune zerolatency -g 50 -b:v 2500k \
  -c:a aac -b:a 128k -f flv \
  "rtmp://127.0.0.1:1935/live/C000001?rtmp_password=<APP_RTMP_PASSWORD>"
```

Verify the stream is live and singular:

```bash
# Publisher-only stream count (must be 1 per camera, no duplicates)
curl -s -H "Authorization: Bearer $SK" \
  http://127.0.0.1:3020/api/v1/apps/storehub/streams | jq '.data | length, .data[].id'
```

Open a real viewer and screenshot for latency (Playwright + system Chrome):

```bash
# Loads the app's generated player page for the room and snapshots the frame
npx playwright screenshot --wait-for-timeout=8000 \
  "http://127.0.0.1:3020/api/v1/play/storehub/C000001" /tmp/c1-view.png
# Read the server clock at the same instant:
curl -s http://127.0.0.1:3020/api/v1/health | jq -r .ts
```

Trigger a recording and confirm the VOD lands in S3:

```bash
curl -s -X POST -H "Authorization: Bearer $SK" -H 'content-type: application/json' \
  -d '{"roomName":"C000001"}' \
  http://127.0.0.1:3020/api/v1/apps/storehub/recordings/start
# ...let it run, then stop; poll the vod until status:ready
curl -s -H "Authorization: Bearer $SK" \
  http://127.0.0.1:3020/api/v1/apps/storehub/vods | jq '.data[0]'
```

### What it validates

- **Real, watchable frame** — the viewer shows moving content and the burned
  clock, i.e. **not a black frame**.
- **Latency ≈ 2 s** glass-to-glass (method above).
- **RTMP ingress + transcode** path works (source H.264 → ingress → WebRTC).
- **Snapshots**: one JPEG every 60 s uploaded to
  `streamhub/storehub/snapshots/*.jpeg` in S3.
- **Recording**: produced an **82 MB MP4**, uploaded to S3, VOD reached
  `ready` (the `onEgressEvent` → upload → `vod_ready` path from
  `recording.service.spec.ts`, but end-to-end with real egress).
- **Viewer counter** correct; **one stream per camera, no duplicates**
  (the canonical-key dedupe holding under real webhook + reconcile traffic).

### Result

View verified (non-black frame), latency ~2 s, snapshots flowing to S3 every
60 s, recording produced an 82 MB MP4 in S3 with the VOD marked ready, viewer
count correct, exactly one stream per camera.

---

## Sim 2 — StreamBuy: 1 broadcaster + 13 viewers + chat

**Shape:** one real RTMP broadcaster fanned out to many WebRTC viewers — the
"one-to-many live shopping" case — plus data-channel chat.

### Setup

Broadcaster (clock-burned again so any viewer can be latency-checked):

```bash
ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440 \
  -vf "drawtext=text='STREAMBUY %{localtime\:%T.%3N}':x=20:y=20:fontsize=40:\
fontcolor=white:box=1:boxcolor=black@0.6" \
  -c:v libx264 -preset veryfast -tune zerolatency -g 60 -b:v 3000k \
  -c:a aac -f flv "rtmp://127.0.0.1:1935/live/promo?rtmp_password=<PW>"
```

13 synthetic viewers via the LiveKit CLI (cheap subscribers — pure fan-out, no
transcode cost):

```bash
lk load-test \
  --url ws://127.0.0.1:7880 --api-key <KEY> --api-secret <SECRET> \
  --room promo --subscribers 13 --duration 2m
```

Assert the exact participant/publisher/viewer split from the API:

```bash
curl -s -H "Authorization: Bearer $SK" \
  http://127.0.0.1:3020/api/v1/apps/streambuy/streams/promo/stats | jq
# => { "participants": 14, "publishers": 1, "viewers": 13 }
```

Chat: post a message from one browser client and confirm it renders in the
player (data channel).

### What it validates

- **Fan-out** to 13 concurrent viewers off one publisher.
- **Exact counting**: API returns `{ participants: 14, publishers: 1,
  viewers: 13 }` — i.e. **streams = publishers only**, viewers counted
  separately (the fix; subscribers must not inflate the stream count).
- **Chat** message sent and rendered in the player.

### Result

Counter exact (`participants:14, publishers:1, viewers:13`); chat delivered and
rendered. Fan-out of 13 subscribers cost the node almost nothing (see capacity).

---

## Sim 3 — Vivet: 1:1 bidirectional meeting

**Shape:** the `/meeting` room — two participants (operator + client) publishing
and subscribing to each other, with simulcast, chat, reactions and screenshare.
Both participants are **headless Chrome with fake media**.

### Setup

Two browser participants, each with a synthetic camera/mic, joining the same
meeting room:

```bash
# Operator (repeat with a second identity=client for the other side)
google-chrome --headless=new --no-sandbox \
  --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
  "http://127.0.0.1:3020/api/v1/meeting/meetings/room42?identity=operator"
```

(Driven via Playwright so both sessions run concurrently and can be screenshotted
and scripted for chat/reaction/screenshare actions.)

### What it validates

- **Bidirectional media**: each side shows **two `<video>` elements playing**
  (self + remote), both live.
- **Adaptive simulcast**: the remote is received at a **downscaled 320p layer**
  when appropriate — i.e. simulcast layer selection is working, not just a single
  fixed encoding.
- **Chat / reactions / screenshare** over the data channel all function in the
  meeting UI.

### Result

Bidirectional video confirmed (two playing videos per side), simulcast adapting
to a 320p layer for the remote, chat/reactions/screenshare all working.

---

## Capacity findings (single node, 4 vCPU / 8 GB)

Measured against the node's load average while running the sims:

- **Saturation point: ~2 cameras + 1 recording.** With two transcoding ingress
  streams plus one active recording, load average sat at **~10–14** on 4 cores —
  i.e. the box is fully committed.
- **The cost is transcode + recording, not viewers.**
  - **Ingress transcode** (RTMP → normalized WebRTC) is CPU-heavy per source.
  - **Recording egress** is a **headless-Chrome compositor** per recording —
    also CPU-heavy.
  - **Viewer fan-out is nearly free**: 13 `lk load-test` subscribers added
    **load ~1**. Subscribers are just SFU forwarding, no transcode.
- **Implication:** the node scales in **publishers being transcoded** and
  **concurrent recordings**, not in viewers. A handful of publishers with many
  viewers each is comfortable; many simultaneously-transcoded/recorded sources is
  not.
- **Next step for high load:** anything past a light live-shopping / few-camera
  workload needs a **GPU node** (offload transcode + NVENC egress) or a
  **multi-node cluster**. A high-load soak test belongs on that hardware, not on
  the 4c/8GB box.

---

## Bugs found (fixed in this wave)

- **`/play` and `/embed` redirected to `/login`.** The public player/embed
  routes were behind auth. **Fixed** — they are now public
  (`PUBLIC_PATH_PREFIXES` includes `/api/v1/play` and `/api/v1/embed`; locked by
  the public-path bypass tests in `auth.service.spec.ts`).
- **Stream over-count.** Streams were counted by tracking **subscribers**, so a
  single publisher with viewers reported multiple streams. **Fixed** —
  **streams = publishers only**; the canonical key `${room}/${identity}` dedupes
  webhook + reconcile, and viewers are counted separately. Pinned by the
  `REGRESSION` block in `streams.service.spec.ts` and by Sim 2's exact
  `{participants:14, publishers:1, viewers:13}`.

## Non-bugs (correct behaviour, documented so nobody "fixes" them)

- **`live` rejects RTMP** — the `live` app has `rtmp_password: true`, so an
  unauthenticated push is rejected on purpose (the ingress terminates it and
  emits `stream_ended` with `unauthorized_rtmp_password`).
- **Stream IDs containing `/`** (the canonical `room/identity` form) must be
  `encodeURIComponent`-ed in URLs. The front end already does this; it is a URL
  encoding requirement, not a bug.
