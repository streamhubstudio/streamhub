# ESP32-CAM → StreamHub (end-to-end, reproducible)

The **ESP32-CAM** (AI-Thinker, OV2640) cannot do WebRTC and cannot reliably do RTMP from
the sketch. The realistic, reproducible path is:

```
ESP32-CAM  ──MJPEG/RTSP──►  ffmpeg relay (PC / Raspberry Pi)  ──RTMP──►  StreamHub ingress
   (Arduino CameraWebServer)        (transcode to H.264/FLV)        rtmp://…:1935/live/<key>
                                                                          │
                                       viewers ◄── HLS  https://streamhub.example.com/hls/<app>/<room>/index.m3u8
                                       moderator ◄── WebRTC (subscribe token)
```

The ESP32 just publishes MJPEG on its LAN; a tiny **ffmpeg relay** (any always-on machine)
transcodes to H.264 and pushes it into a StreamHub **RTMP ingress**. Then anyone watches over
HLS or WebRTC.

---

## 1. ESP32-CAM sketch — MJPEG stream (Arduino)

This is essentially Espressif's stock **CameraWebServer** example, trimmed to expose the
MJPEG stream. With the standard example the stream lives at
`http://<esp32-ip>:81/stream`.

`esp32cam_mjpeg.ino`:

```cpp
#include "esp_camera.h"
#include <WiFi.h>
#include "esp_http_server.h"

// ---- AI-Thinker ESP32-CAM pin map ----
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

const char* WIFI_SSID = "your-wifi";
const char* WIFI_PASS = "your-pass";

static const char* STREAM_CT = "multipart/x-mixed-replace;boundary=frame";
static const char* BOUNDARY  = "\r\n--frame\r\n";
static const char* PART_HDR  = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

static esp_err_t stream_handler(httpd_req_t* req) {
  httpd_resp_set_type(req, STREAM_CT);
  char hdr[64];
  while (true) {
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) return ESP_FAIL;
    int n = snprintf(hdr, sizeof(hdr), PART_HDR, fb->len);
    if (httpd_resp_send_chunk(req, BOUNDARY, strlen(BOUNDARY)) != ESP_OK ||
        httpd_resp_send_chunk(req, hdr, n) != ESP_OK ||
        httpd_resp_send_chunk(req, (const char*)fb->buf, fb->len) != ESP_OK) {
      esp_camera_fb_return(fb);
      break;
    }
    esp_camera_fb_return(fb);
  }
  return ESP_OK;
}

static httpd_handle_t server = nullptr;
static void start_server() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 81;
  httpd_uri_t stream_uri = { "/stream", HTTP_GET, stream_handler, nullptr };
  if (httpd_start(&server, &config) == ESP_OK)
    httpd_register_uri_handler(server, &stream_uri);
}

void setup() {
  Serial.begin(115200);

  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0; c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM; c.pin_d1 = Y3_GPIO_NUM; c.pin_d2 = Y4_GPIO_NUM; c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM; c.pin_d5 = Y7_GPIO_NUM; c.pin_d6 = Y8_GPIO_NUM; c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM; c.pin_pclk = PCLK_GPIO_NUM; c.pin_vsync = VSYNC_GPIO_NUM;
  c.pin_href = HREF_GPIO_NUM; c.pin_sccb_sda = SIOD_GPIO_NUM; c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn = PWDN_GPIO_NUM; c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000; c.pixel_format = PIXFORMAT_JPEG;
  c.frame_size = FRAMESIZE_VGA;     // 640x480 — safe; HD/SXGA on PSRAM boards
  c.jpeg_quality = 12; c.fb_count = 2;

  if (esp_camera_init(&c) != ESP_OK) { Serial.println("camera init failed"); return; }

  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(400); Serial.print("."); }
  Serial.printf("\nMJPEG: http://%s:81/stream\n", WiFi.localIP().toString().c_str());

  start_server();
}

void loop() { delay(1000); }
```

Board: **AI Thinker ESP32-CAM**, PSRAM **Enabled**, partition **Huge APP**. After flashing,
note the IP printed on serial, e.g. `http://192.168.1.50:81/stream`. Verify in a browser /
VLC first.

---

## 2. Create the StreamHub RTMP ingress

Ask StreamHub for an ingress on the room the camera should feed:

```bash
curl -s -X POST https://streamhub.example.com/api/v1/apps/live/ingress \
  -H "Authorization: Bearer $STREAMHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"inputType":"rtmp","room":"cam1","enableTranscoding":true}'
```

```json
{
  "data": {
    "ingressId": "IN_abc123",
    "url": "rtmp://media.example.com:1935/live",
    "streamKey": "sk-9f3c...",
    "roomName": "live-cam1"
  }
}
```

Your push URL = `url` + `/` + `streamKey` =
`rtmp://media.example.com:1935/live/sk-9f3c...`. (You can also create it from the
StreamHub UI → app → **Ingress** → New RTMP, which shows the same URL + key.)

---

## 3. The ffmpeg relay (MJPEG → H.264/FLV → RTMP)

Run this on any always-on machine on the same network (PC, Raspberry Pi, the StreamHub box
itself). It pulls the ESP32's MJPEG and pushes H.264 to the ingress:

```bash
ESP=http://192.168.1.50:81/stream
RTMP="rtmp://media.example.com:1935/live/sk-9f3c..."

ffmpeg -fflags nobuffer -f mjpeg -i "$ESP" \
  -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p \
  -r 15 -g 30 -b:v 1500k \
  -an \
  -f flv "$RTMP"
```

Notes:

- `-f mjpeg -i <url>` reads the multipart MJPEG directly. ffmpeg also accepts the `:81/`
  CameraWebServer endpoint.
- `-an` = no audio (the ESP32-CAM has no mic). Add `-f lavfi -i anullsrc -c:a aac
  -shortest` if a downstream consumer insists on an audio track.
- The ESP32-CAM is bandwidth-limited; **VGA @ ~15 fps** is a sane target. Push the camera
  harder only on PSRAM boards.
- **RTSP variant:** if you run an RTSP firmware instead of MJPEG, swap the input:
  `ffmpeg -rtsp_transport tcp -i rtsp://192.168.1.50:554/mjpeg/1 ...` — or skip the relay
  and create a **pull** ingress so StreamHub pulls the RTSP itself:
  `POST /apps/live/ingress {"inputType":"url","room":"cam1","url":"rtsp://192.168.1.50:554/mjpeg/1"}`
  (good when the camera is reachable from the server; otherwise keep the local relay).

Keep it alive with a `while true; do ffmpeg ...; sleep 2; done` loop, a systemd unit, or a
`Restart=always` service.

---

## 4. Watch it

The room `live-cam1` goes live the moment ffmpeg connects.

- **HLS** (any browser, VLC, Smart TV, video.js):
  `https://streamhub.example.com/hls/live/live-cam1/index.m3u8`
- **WebRTC** (low latency): mint a subscribe token and use the embed/player —
  ```bash
  curl -s -X POST https://streamhub.example.com/api/v1/apps/live/tokens \
    -H "Authorization: Bearer $STREAMHUB_TOKEN" -H "Content-Type: application/json" \
    -d '{"room":"cam1","canPublish":false,"ttl":"30m"}'
  ```
  then open the returned `embedUrl`, or feed `{ token, wsUrl }` to `livekit-client` /
  `streamhub-adaptor`.
- **Confirm the stream server-side:**
  ```bash
  curl -s https://streamhub.example.com/api/v1/apps/live/streams \
    -H "Authorization: Bearer $STREAMHUB_TOKEN"
  ```
- **Record it** to S3: `POST /apps/live/recording/start {"roomName":"live-cam1"}`.

---

## 5. Can the ESP32 push RTMP directly? (alternatives & limits)

You can try to skip the relay, but for the AI-Thinker ESP32-CAM it's usually not worth it:

- **RTMP libraries for ESP32** exist (e.g. community ports / `esp_rtmp` in some
  `esp-media` experiments), but they're immature, RAM-hungry, and the ESP32 has **no
  H.264 encoder** — it produces **MJPEG**, while RTMP/FLV expects H.264. You'd be pushing a
  non-standard FLV that most servers (LiveKit ingress included) won't accept. So in
  practice **a transcoding hop is unavoidable** — that's exactly what the ffmpeg relay
  does.
- **ESP32-P4 / ESP32-S3 with hardware H.264** (or external encoder chips) change this — on
  those you could encode H.264 on-device and a direct RTMP push becomes feasible. For the
  classic ESP32-CAM, **stick with MJPEG/RTSP → ffmpeg relay → RTMP**.
- **WHIP/WebRTC on ESP32:** not practical (no DTLS-SRTP/ICE stack that fits). Don't.

**Bottom line:** the reproducible, supported path is the one above — MJPEG from the sketch,
ffmpeg relay transcodes to H.264, push to the StreamHub RTMP ingress, watch over HLS/WebRTC.

---

## Checklist

1. Flash the MJPEG sketch; note `http://<esp-ip>:81/stream`.
2. `POST /apps/:app/ingress {inputType:"rtmp"}` → `url` + `streamKey`.
3. Run the ffmpeg relay: `-f mjpeg -i <esp-stream>` → `-c:v libx264 -f flv <url/streamKey>`.
4. Watch HLS `/hls/<app>/<room>/index.m3u8` or mint a subscribe token for WebRTC.
5. Optionally start a recording to push the VOD to the app's S3.
