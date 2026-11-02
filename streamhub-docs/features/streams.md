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
| GET | `/streams/:id/plugins` | stream:read | This stream's plugin opt-out list |
| PATCH | `/streams/:id/plugins` | stream:write | Replace this stream's plugin opt-out list |
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

### Per-stream plugin opt-out

By default every plugin the app enables applies to **all** of that app's live
streams. You can opt an **individual** stream out of specific plugins — an
opt-out (the stream keeps every plugin you don't turn off), scoped to that one
stream.

- Storage: a per-app `streams.disabled_plugins` column (JSON array of plugin
  ids; default `[]` = affected by everything; migration #10). The setting lives
  on the canonical stream row, so it persists across reconnects of the same
  publisher.
- `GET /streams/:id/plugins` → `{ "streamId": "room/cam", "disabled": ["watermark"] }`.
- `PATCH /streams/:id/plugins` with `{ "disabled": ["watermark"] }` replaces the
  list (deduped/normalized server-side). Pass `[]` to re-affect the stream with
  every app plugin. Other streams are never touched.
- **Overlay resolution is stream-aware.** The player-overlay list endpoints
  (`GET /plugins/public`, `GET /plugins`) accept `?stream=<id>` or `?room=<room>`
  and subtract that stream's / room's opted-out plugins from the app's enabled
  set. A room aggregates the union of its **active** streams' opt-outs (a player
  knows only its room). With no scope the app-level list is returned unchanged.
- UI: the **Streams** tab exposes a **Plugins** action per stream — a toggle per
  app-enabled overlay (ON = affected, OFF = opted out). Players (LivePlayer /
  HLS / MJPEG / `/play` / `/embed`) pass their `room`, so overlays honor the
  opt-out live.

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
