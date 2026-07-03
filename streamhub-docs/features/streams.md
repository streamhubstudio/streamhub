# Streams (list / detail / stop)

## What it does

Exposes the app's active streams, reconciled between the per-app `streams` table
and live LiveKit rooms/participants. A stream is created by a publisher joining
(webrtc) or an ingress (rtmp/whip/rtsp). Hidden QC/recorder participants are not
counted as streams. Stopping a stream disconnects the participant / removes the
ingress / ends the room and marks it ended.

Stream ids are canonical: `${room}/${participantIdentity}` — one publisher =
one row (shared by the webhook path and reconcile).

## Endpoints (under `/apps/:app`)

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | `/streams` | stream:read | List active streams (reconciled with LiveKit) |
| GET | `/streams/:id` | stream:read | Stream detail (+ viewer count when enabled) |
| DELETE | `/streams/:id` | stream:stop | Stop the stream (204) |

Related per-stream actions live in other docs:
- `POST /streams/:id/record/start|stop` → [recording.md](recording.md)
- `POST /streams/:id/hls/start|stop`, `GET /streams/:id/hls` → [hls-live.md](hls-live.md)
- `POST /streams/:id/data` (chat/reactions) → [chat-reactions-viewers.md](chat-reactions-viewers.md)

### StreamResponse (detail)

```json
{ "data": {
  "id": 4, "appId": 3, "streamId": "demo-room1/alice",
  "type": "webrtc", "room": "demo-room1", "participant": "alice",
  "status": "active", "startedAt": "...", "endedAt": null,
  "lastStatsJson": "{...}",
  "viewers": 3
} }
```

`type` ∈ webrtc | rtmp | rtsp | whip. `status` ∈ active | ended. `viewers` is
present on detail reads only when the app enables the `viewerCounter` feature
(real subscribers, excluding publishers and hidden/QC).

## Examples

```bash
curl -s $BASE/apps/demo/streams -H "Authorization: Bearer $TOKEN"
curl -s "$BASE/apps/demo/streams/demo-room1%2Falice" -H "Authorization: Bearer $TOKEN"
curl -s -X DELETE "$BASE/apps/demo/streams/demo-room1%2Falice" -H "Authorization: Bearer $TOKEN"
```

## Notes

- Stream ids contain a `/`; URL-encode it (`%2F`) in paths.
- Webhooks (`participant_joined/left`, `ingress_started/ended`) drive stream
  upserts + `stream_started`/`stream_ended` callbacks; a periodic reconcile keeps
  the table honest against LiveKit.
</content>
