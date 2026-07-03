# Radio & audio-only rooms

## What it does

Audio-first modes on top of the same LiveKit rooms:

- **Audio-only publish** — a token grant (`audioOnly:true`) restricts publishing
  to the microphone (no camera/screenshare). Used for voice channels (Discord-
  style: everyone publishes audio and hears each other).
- **Radio** — a **master** publishes (audio, optional video) with a `canPublish`
  token; **listeners** join subscribe-only, hidden, audio-only (oyentes, not
  participants) → low-latency, embeddable. Listener count = the viewer counter.

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/apps/:app/tokens` (`audioOnly:true`) | Bearer (stream:write) | Audio-only publish/subscribe token |
| GET | `/apps/:app/radio/:room/listen-token` | **public** | Subscribe-only audio listen token for the embed |

### GET /apps/:app/radio/:room/listen-token — response

```json
{ "data": {
  "token": "<livekit-jwt>",
  "app": "demo",
  "room": "demo-radio1",
  "wsUrl": "wss://media.example.com",
  "mode": "listener"
} }
```

The listener token is `canPublish:false, canSubscribe:true, canPublishData:false,
hidden:true, audioOnly:true, ttl:6h` — a random `listener-xxxx` identity. Because
it is public, it can back an audio-only embed player (autoplay after a user
gesture, shows "EN VIVO" + listener count). The **master** uses the normal
publish flow (Transmitir / the `audio-radio.html` sample).

## Examples

```bash
# master: audio-only publisher token
curl -s -X POST $BASE/apps/demo/tokens -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"room":"radio1","identity":"dj","audioOnly":true,"canPublish":true}'

# listener: public listen token (no auth)
curl -s "$BASE/apps/demo/radio/radio1/listen-token"
```

```html
<!-- listener embed -->
<iframe src="https://streamhub.example.com/samples/demo/audio-radio.html?mode=listener&room=radio1"
        width="320" height="120" frameborder="0" allow="autoplay"></iframe>
```

## Notes

- Listeners are hidden and audio-only, so they don't appear as participants and
  don't inflate the stream list — but they do count as viewers/listeners.
- Voice channels reuse the same audio-only token; the `audio-radio.html` sample
  ships both master and listener modes.
</content>
