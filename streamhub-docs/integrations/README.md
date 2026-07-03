# StreamHub — Native / Device Integrations

How to connect non-browser clients (mobile apps, native desktop, embedded cameras) to a
StreamHub app. StreamHub is a management layer over a self-hosted **LiveKit** server, so the
media plane is standard LiveKit / WebRTC, plus an **RTMP ingress** and **HLS** output for
clients that can't do WebRTC.

For the REST API itself see [../api-app.md](../api-app.md) and
[../api-global.md](../api-global.md). For the browser SDK (drop-in AntMedia replacement)
see `streamhub-adaptor`.

---

## The one thing every integration needs: a token

WebRTC clients (Android/iOS/native LiveKit) connect with **two values**:

- a **`wsUrl`** — the public LiveKit WebSocket, currently `wss://media.example.com`;
- a **`token`** — a short-lived LiveKit join JWT.

You get both from **one** StreamHub call. Mint it **server-side** with your StreamHub API
token (never ship the StreamHub Bearer token inside a mobile app or a device):

```bash
curl -s -X POST https://streamhub.example.com/api/v1/apps/live/tokens \
  -H "Authorization: Bearer $STREAMHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"room":"demo","identity":"phone-42","canPublish":true,"canSubscribe":true,"ttl":"1h"}'
```

```json
{
  "data": {
    "token": "<jwt>",
    "app": "live",
    "room": "live-demo",
    "identity": "phone-42",
    "wsUrl": "wss://media.example.com",
    "playUrl": "https://streamhub.example.com/play/live/live-demo",
    "embedUrl": "https://streamhub.example.com/embed/live/live-demo"
  }
}
```

Your app then asks **your own backend** for `{ token, wsUrl }` and feeds them to the
LiveKit SDK. (`room` is namespaced under the app prefix: app `live` + `room=demo` →
`live-demo`.)

RTMP/HLS clients don't use a token; they use the **stream key** returned by
`POST /apps/:app/ingress` (push side) and a plain HLS URL (play side).

---

## Which protocol does each platform use?

| Platform | Publish (send) | Play (receive) | Protocol / SDK | Doc |
|----------|----------------|----------------|----------------|-----|
| **Browser** | WebRTC | WebRTC + HLS fallback | `streamhub-adaptor` (livekit-client) | `streamhub-adaptor/README.md` |
| **Android** | WebRTC | WebRTC | `io.livekit:livekit-android` (Kotlin) | [android.md](./android.md) |
| **iOS** | WebRTC | WebRTC | `LiveKitClient` SPM (Swift) | [ios.md](./ios.md) |
| **C++ / native** | RTMP (recommended) or WebRTC FFI | HLS | ffmpeg/GStreamer → RTMP ingress; HLS for play | [cpp.md](./cpp.md) |
| **ESP32-CAM** | **WS directo** (`wss://…/ingest/ws`, 1 frame JPEG por mensaje binario — sin relay) | MJPEG `/live/<app>/<room>/mjpeg` + `/play` (sub-segundo) | `wsk_` key + arduinoWebSockets | [ESP32-WS-INGEST.md](./ESP32-WS-INGEST.md) (legacy relay: [esp32cam.md](./esp32cam.md)) |
| **Any RTMP encoder** (OBS, drones, etc.) | RTMP | — | `rtmp://media.example.com:1935/live/<streamKey>` | [../api-app.md](../api-app.md#ingress-rtmp--rtsp--whip) |
| **Any HLS player** (Smart TV, VLC, video.js) | — | HLS | `https://streamhub.example.com/hls/<app>/<room>/index.m3u8` | — |

### Rules of thumb

- **Real-time, two-way, low latency** (calls, interactive publishing) → **WebRTC SDK**
  (Android/iOS/browser). Sub-second latency.
- **One-way push from a device/encoder that can't do WebRTC** (IP cameras, OBS,
  native C++) → **RTMP ingress**. A few seconds latency.
- **Microcontroller cameras (ESP32-CAM / CCTV fleets)** → **direct WS ingest**
  (`wss://…/ingest/ws`, JPEG frames) + MJPEG playback on the same `/play` URL.
  Sub-second, no per-camera relay, no transcoding. See
  [ESP32-WS-INGEST.md](./ESP32-WS-INGEST.md).
- **Mass playback / passive viewers / embeds** → **HLS**
  (`/hls/<app>/<room>/index.m3u8`). Highest latency (~3–10 s) but works everywhere and
  scales.

A typical mixed setup: an ESP32-CAM or OBS **pushes RTMP** into a room, viewers **watch
over HLS**, and a moderator joins the same room over **WebRTC** to talk back.

---

## Real endpoints (current deploy)

| Thing | Value |
|-------|-------|
| REST API base | `https://streamhub.example.com/api/v1` |
| Mint token | `POST /apps/:app/tokens` → `{ token, wsUrl, room, ... }` |
| Public LiveKit WSS (`wsUrl`) | `wss://media.example.com` |
| Create ingress | `POST /apps/:app/ingress` → `{ ingressId, url, streamKey, roomName }` |
| RTMP publish URL | `rtmp://media.example.com:1935/live/<streamKey>` |
| HLS playback | `https://streamhub.example.com/hls/<app>/<room>/index.m3u8` |
| WS ingest key (ESP32) | `POST /apps/:app/ws-ingest` → `{ streamKey: "wsk_…", wsUrl, mjpegUrl }` |
| WS ingest publish (device) | `wss://streamhub.example.com/ingest/ws?app=<app>&room=<room>` + `Authorization: Bearer wsk_…` |
| MJPEG playback (no transcode) | `https://streamhub.example.com/live/<app>/<room>/mjpeg` (+ `/frame.jpg`) |

> **Host note.** The WebRTC `wsUrl` and the RTMP host both resolve to the LiveKit edge,
> exposed as `media.example.com` (`PUBLIC_WS_URL` / `RTMP_PUBLIC_HOST`). The REST
> API and HLS are served from `streamhub.example.com`. **Always use the exact `url` /
> `wsUrl` the API returns** rather than hard-coding a host — that way you follow the
> deploy automatically.

---

## Index

- [android.md](./android.md) — Android (Kotlin), `livekit-android` SDK.
- [ios.md](./ios.md) — iOS (Swift), `LiveKitClient` SDK.
- [cpp.md](./cpp.md) — C++: RTMP push (ffmpeg/GStreamer) and notes on WebRTC FFI.
- [ESP32-WS-INGEST.md](./ESP32-WS-INGEST.md) — **ESP32-CAM directo** (implementado):
  cámara → `wss://…/ingest/ws` → MJPEG/`/play` sub-segundo, sin relay. Firmware:
  [esp32cam_ws_ingest.ino](./esp32cam_ws_ingest.ino).
- [esp32cam.md](./esp32cam.md) — ESP32-CAM vía relay (legacy): camera → ffmpeg relay →
  RTMP → HLS. Sigue siendo válido si necesitás HLS/grabación LiveKit hoy (el bridge
  interno F3 lo reemplazará).
