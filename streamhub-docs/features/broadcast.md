# Broadcast (webcam → external RTMP)

## What it does

Takes a LiveKit room of the app and forwards it to an **external RTMP/RTMPS
target** (YouTube / Twitch / custom) via a RoomComposite egress. This powers the
"Transmitir" (broadcast) widget: a browser connects and publishes webcam/mic to
the room with a `canPublish` token, then the server starts the egress that
renders the live room and pushes it to the destination.

Starting a broadcast is subject to the tenant `max_egress_gb_month` quota.

> Para reenviar un stream YA en vivo a **varios destinos a la vez** (simulcast
> YouTube + Twitch + custom, con estado por endpoint, retry y stop individual),
> usá la feature [restream](restream.md) (`/apps/:app/streams/:id/restream`) —
> este módulo broadcast es el flujo simple "webcam → 1 RTMP externo".

## Endpoints (under `/apps/:app`)

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| POST | `/broadcast/start` | broadcast:start | Start pushing a room to an external RTMP URL |
| POST | `/broadcast/:id/stop` | broadcast:stop | Stop a broadcast (egress id) |
| GET | `/broadcast` | broadcast:read | List active broadcasts of the app |

### POST /apps/:app/broadcast/start — body

```json
{
  "roomName": "live-room-1",
  "rtmpUrl": "rtmp://a.rtmp.youtube.com/live2/xxxx-xxxx-xxxx-xxxx",
  "layout": "grid"
}
```

- `roomName` required (namespaced under the app prefix); the room must already
  be published to.
- `rtmpUrl` required, must match `^rtmps?://`.
- `layout` optional (e.g. `grid`, `speaker`).

### Response

```json
{ "data": { "egressId": "EG_xxx", "status": "starting",
            "roomName": "demo-live-room-1", "rtmpUrl": "rtmp://a.rtmp.youtube.com/live2/xxxx" } }
```

## Examples

```bash
# 1) browser publishes to room 'live-room-1' with a canPublish token (POST /apps/demo/tokens)
# 2) start the broadcast to YouTube
curl -s -X POST $BASE/apps/demo/broadcast/start -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"roomName":"live-room-1","rtmpUrl":"rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl-mnop"}'

# list / stop
curl -s $BASE/apps/demo/broadcast -H "Authorization: Bearer $TOKEN"
curl -s -X POST $BASE/apps/demo/broadcast/EG_xxx/stop -H "Authorization: Bearer $TOKEN"
```

## Notes

- This is a **stream egress** (RTMP output), distinct from recording (file
  egress) and HLS (segmented egress).
- The sample `webrtc-publish.html` / the panel "Transmitir" tab drive the
  publish step; broadcast/start only starts the outbound egress.
</content>
