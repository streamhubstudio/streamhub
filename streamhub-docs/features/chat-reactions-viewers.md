# Chat, reactions & viewer counter

## What it does

Interactive overlay features built on LiveKit **data channels**, plus a live
subscriber count. All three are per-app feature flags (see apps-multitenant.md):
`chat`, `reactions`, `viewerCounter`.

- **Chat** — messages over data channel topic `chat` (emojis included).
- **Reactions** — animated floating reactions over topic `reaction` (hearts/likes).
- **Viewer counter** — live subscriber count per stream (real subscribers,
  excluding publishers and hidden/QC participants).

The client sends data messages directly over the LiveKit data channel; the
server-side endpoint lets the backend **inject** a message into a room and fire
the matching outbound callback (`chat_message` / `reaction`). The player/sample
pages include a shared chat + reactions + viewers addon panel.

## Endpoint

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| POST | `/apps/:app/streams/:id/data` | stream:write | Inject a data message (chat/reaction) + fire callback |

### Body

```json
{
  "topic": "chat",
  "message": "hello world",
  "reaction": "❤️",
  "from": "user-123",
  "payload": "<raw string, optional>",
  "destinationIdentities": ["user-a", "user-b"],
  "reliable": true
}
```

- `topic` `chat` requires the app `chat` feature; `reaction` requires `reactions`
  (else 404 "disabled for this app").
- If `payload` is omitted, an envelope `{topic, from, message, reaction, ts}` is
  built and broadcast.
- `destinationIdentities` restricts delivery; `reliable` default true.

### Response

```json
{ "data": { "sent": true, "room": "demo-room1", "topic": "chat" } }
```

Sending `chat`/`reaction` also dispatches the outbound `chat_message` /
`reaction` callback (best-effort).

## Viewer counter

Exposed on stream **detail** as `viewers` when the app enables `viewerCounter`:

```bash
curl -s "$BASE/apps/demo/streams/demo-room1%2Falice" -H "Authorization: Bearer $TOKEN"
# → data.viewers = 3
```

The player shows it live (poll or data channel). Also exported to Prometheus as
`streamhub_stream_viewers`.

## Example

```bash
# inject a chat message server-side
curl -s -X POST $BASE/apps/demo/streams/demo-room1%2Falice/data \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"topic":"chat","from":"system","message":"Welcome!"}'

# a reaction
curl -s -X POST $BASE/apps/demo/streams/demo-room1%2Falice/data \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"topic":"reaction","reaction":"❤️","from":"alice"}'
```

## Notes

- Clients normally publish chat/reactions directly over their LiveKit data
  channel; this endpoint is for server-originated messages and to guarantee a
  callback is emitted.
- Hidden QC/recorder participants never count toward `viewers`.
</content>
