# Ingress (RTMP / WHIP / RTSP-relay)

## What it does

Ingest external media into a LiveKit room of the app using LiveKit's ingress
service. Three input types:

- **rtmp** — returns a push URL + **stream key** (OBS/ffmpeg push to
  `rtmp://<RTMP_PUBLIC_HOST>:1935/live/<key>`). Optionally a **stream password**
  (feature `rtmpPassword`): LiveKit has no native RTMP password, so StreamHub
  registers the ingress and, on `ingress_started`, **terminates** the push if it
  was not authorized via `POST /ingress/:id/validate` first.
- **whip** — a WHIP (WebRTC-HTTP) endpoint.
- **url** — pull a remote source (e.g. `rtsp://camera/stream`) = RTSP relay.

RTMP/URL ingest defaults to **transcoding on** (multi-layer) — required for the
adaptive player; WHIP defaults off unless the app opts in. Creating an ingress
counts against `max_concurrent_streams`.

## Endpoints (under `/apps/:app`)

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| POST | `/ingress` | ingress:create | Create an RTMP/WHIP/URL ingress |
| GET | `/ingress` | ingress:read | List ingresses for the app |
| GET | `/ingress/:id` | ingress:read | Get one ingress |
| DELETE | `/ingress/:id` | ingress:delete | Delete an ingress |
| POST | `/ingress/:id/validate` | ingress:write | Validate the RTMP stream password |

### POST /apps/:app/ingress — body

```json
{
  "inputType": "rtmp",
  "room": "demo",
  "participantIdentity": "rtmp-publisher",
  "participantName": "RTMP source",
  "url": "rtsp://camera.local/stream",
  "enableTranscoding": true
}
```

- `inputType` ∈ {rtmp, whip, url} (required).
- `url` required when `inputType=url`.
- `room` defaults to the app prefix (namespaced).
- `enableTranscoding` defaults from `adaptivePlayer`/`rtmp.transcode` (rtmp/url on).

### Response

```json
{ "data": {
  "ingressId": "IN_xxx",
  "streamKey": "abc123",
  "url": "...",                       
  "rtmp_url": "rtmp://media.example.com:1935/live/abc123",
  "stream_key": "abc123",
  "stream_password": "s3cr3t",        // only when rtmpPassword feature on
  "requires_password": true,
  "adaptive": true,
  "player_url": "https://streamhub.example.com/play/demo/demo",
  "embed_iframe": "<iframe ...></iframe>"
} }
```

`GET /ingress` also returns `stream_key` + `rtmp_url` on each row so the panel
can show OBS settings after creation (not just at create time).

### POST /apps/:app/ingress/:id/validate — body

```json
{ "password": "s3cr3t" }
```

Marks the ingress authorized. Meant to be called (e.g. by an RTMP edge
`on_publish` hook, or the panel) before/while the push starts. Returns
`{ data: { ingressId, valid } }`. If an RTMP push starts unauthorized, the
webhook handler deletes the ingress and fires `stream_ended` with reason
`unauthorized_rtmp_password`.

## Examples

```bash
# RTMP ingress (with password feature enabled on the app)
curl -s -X POST $BASE/apps/demo/ingress -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"inputType":"rtmp","room":"demo"}'

# authorize the RTMP password before pushing
curl -s -X POST $BASE/apps/demo/ingress/IN_xxx/validate \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"password":"s3cr3t"}'

# RTSP relay (pull)
curl -s -X POST $BASE/apps/demo/ingress -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"inputType":"url","room":"cam1","url":"rtsp://camera.local/stream"}'

# push with OBS/ffmpeg
ffmpeg -re -i input.mp4 -c:v libx264 -c:a aac -f flv \
  rtmp://media.example.com:1935/live/abc123
```

## Notes

- The public RTMP host is `RTMP_PUBLIC_HOST`; the ingest port is `1935`, path `/live/<key>`.
- An ingress publisher appears in LiveKit as a participant of kind `INGRESS`;
  the webhook layer dedupes it with its ingress event so **1 ingress = 1 stream**.
- ESP32-CAM and other non-WebRTC devices ingest by relaying MJPEG/RTSP → RTMP
  (see the integrations docs).
</content>
