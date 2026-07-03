# Players (WebRTC, HLS, VOD) + public /play & /embed

## What it does

Three player experiences, plus public embeddable pages:

1. **WebRTC LivePlayer** (`@livekit/components-react` + `livekit-client`) —
   sub-second latency, for meetings and "watch live now". Gets a subscribe token
   via `POST /apps/:app/tokens { canSubscribe:true, canPublish:false }` and
   connects to `wsUrl`. Renders the room's video/audio tracks with basic controls
   (mute, fullscreen) and connection state (connecting / LIVE / empty room).
2. **HLS player** (video.js + HLS) — for the ~6-15s HLS live feed at
   `/hls/<app>/<room>/index.m3u8` (see [hls-live.md](hls-live.md)).
3. **VOD player** (video.js) — plays the presigned/public MP4 of a VOD (see
   [vod.md](vod.md)).

The chat / reactions / viewer-counter panel is a **reusable addon** shared by
the live players and the meeting view (see
[chat-reactions-viewers.md](chat-reactions-viewers.md)).

## Public player URLs (no auth)

Minting a join token returns copyable public URLs:

- **Play page:** `https://streamhub.example.com/play/<app>/<room>`
- **Embed page:** `https://streamhub.example.com/embed/<app>/<room>`
- **iframe snippet** (returned in the token response):

```html
<iframe src="https://streamhub.example.com/embed/<app>/<room>"
        width="640" height="360" frameborder="0"
        allow="autoplay; fullscreen; camera; microphone" allowfullscreen></iframe>
```

`/play` and `/embed` are public routes (bypass Bearer auth) served by the SPA;
they mint their own public/subscribe token per room as needed.

## Frontend components (SPA)

- `<LivePlayer app room addons={{chat?,reactions?,viewers?}} />` — WebRTC live.
- `<HlsPlayer src />` — video.js + HLS.
- `<VodPlayer src poster? />` — video.js over the presigned MP4.

In the panel's **En vivo** tab each active stream has **Ver (WebRTC)**,
**Ver (HLS)** and **Grabar** actions.

## Examples

```bash
# get a subscribe token + player URLs
curl -s -X POST $BASE/apps/demo/tokens -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"room":"demo-room1","canPublish":false,"canSubscribe":true}'
# → data.playUrl / data.embedUrl / data.iframe
```

## Notes

- Public player/asset prefixes bypass the auth guard: `/play`, `/embed`,
  `/assets`, plus `/samples`, `/hls`, `/sdk`.
- Player URLs are absolute when `PUBLIC_BASE_URL` is set, else relative.
</content>
