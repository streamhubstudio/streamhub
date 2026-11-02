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

- **Play page:** `https://streamhub.digitalhub.com.ar/play/<app>/<room>`
- **Embed page:** `https://streamhub.digitalhub.com.ar/embed/<app>/<room>`
- **iframe snippet** (returned in the token response):

```html
<iframe src="https://streamhub.digitalhub.com.ar/embed/<app>/<room>"
        width="640" height="360" frameborder="0"
        allow="autoplay; fullscreen; camera; microphone" allowfullscreen></iframe>
```

`/play` and `/embed` are public routes (bypass Bearer auth) served by the SPA;
they mint their own public/subscribe token per room as needed.

### HLS fallback on /play + /embed (where the player provider is visible)

Passthrough (remux) channels are **HLS-only** — there is no LiveKit room, so the
WebRTC `<LivePlayer>` would show an empty stage
(see [rtmp-passthrough.md](rtmp-passthrough.md)). On mount both public pages
probe the public playlist once (`HEAD /hls/<app>/<room>/index.m3u8` — no auth,
no polling; GET fallback if the front rejects HEAD):

- **Playlist exists AND is fresh-ish** (Last-Modified within ~90s, compared
  against the server's own `Date` header so client clock skew can't lie):
  the page defaults to `<HlsPlayer app room access="public">`. This is the
  surface where an app's **`player`-slot provider (Vidstack)** becomes visible
  to anonymous viewers — HlsPlayer resolves it through the public plugins
  endpoint. `/play` also shows a small **WebRTC | HLS** toggle so viewers of
  transcoded rooms (which have both) can still choose sub-second WebRTC;
  choosing HLS re-probes once.
- **Playlist exists but stale** (leftover from an ended session): WebRTC stays
  the default; `/play` still offers the HLS toggle.
- **No playlist (404) / probe error**: exactly today's WebRTC-only behavior —
  the probe can never break existing playback. MJPEG (ws-mjpeg cameras) keeps
  precedence over both.

Pure logic (URL builders, probe, freshness, default selection) lives in
`streamhub-web/src/lib/share.ts` (node:test suite `share.spec.ts`).

## Frontend components (SPA)

- `<LivePlayer app room addons={{chat?,reactions?,viewers?}} />` — WebRTC live.
- `<HlsPlayer src app? room? access? />` — HLS (video.js **or** a player provider).
- `<VodPlayer src poster? app? room? access? />` — MP4 (video.js **or** a provider).

In the panel's **En vivo** tab each active stream has **Ver (WebRTC)**,
**Ver (HLS)**, **Grabar** and a **Compartir** menu that copies the public
player URL (`/play/...`), the `/embed/...` `<iframe>` snippet, the public HLS
playlist URL and a self-contained video.js embed. Passthrough rows open
**Ver (HLS)** directly on the existing `/hls/<app>/<room>/index.m3u8` (no
LiveKit egress is started — see
[rtmp-passthrough.md](rtmp-passthrough.md)).

## Swappable player provider (`ui: 'player'` plugin)

The HLS + VOD/MP4 player is **swappable per app** through the plugin framework.
A plugin can occupy a new UI slot, **`player`**, meaning it *provides* the media
player. When an app has an installed **and enabled** `player`-slot plugin, the
HLS + VOD player renders that plugin's player; otherwise it falls back to the
built-in **video.js** player. **Sub-second WebRTC live is unaffected — it always
uses `<LivePlayer>`/LiveKit; only the HLS + VOD player is swapped.**

**First provider shipped: Vidstack** (`@vidstack/react` + `hls.js`) — an advanced,
skinned, keyboard-accessible player. Install it from an app's **Plugins** tab and
enable it; the app's HLS modal and VOD player immediately render Vidstack. In the
[Studio-App taxonomy](STUDIO-APPS.md) `vidstack` is a **plugin** (`kind: 'plugin'`,
a simple in-process extension), not a Studio App — it opens in the modal, not a
full page.

### How the swap resolves

- `<HlsPlayer>` / `<VodPlayer>` keep the **same external props**, so no call site
  changed. Internally each calls `usePlayerProvider(app, { public })`:
  - **auth surfaces** (StreamsTab HLS modal, VodsTab) read the app's authenticated
    plugin catalog (`GET /apps/:app/plugins`);
  - **anonymous surfaces** (`access="public"`) read the no-auth endpoint
    (`GET /apps/:app/plugins/public`) — which now returns enabled **`player`**
    providers as well as `player-overlay` plugins — so a logged-out viewer
    resolves the provider **without a 401** (same pattern as player overlays).
- `usePlayerProvider` returns the first **active + frontend-registered** provider
  that actually ships a `PlayerComponent` (pure selector `pickPlayerProvider`);
  `null` means "use video.js". A component-less or backend-only install can never
  blank out the fallback.
- The chosen provider renders inside `<ProviderPlayer>`, which also mounts the
  app's `player-overlay` plugins (e.g. Timestamp CCTV) on top — parity with the
  video.js players.

### The provider contract

A `player` plugin default-exports a `PluginModule` with a `PlayerComponent`. That
component receives a **stable media contract** (the whole interface the resolver
relies on, so providers are drop-in):

```ts
interface PlayerComponentProps {
  src: string                 // .m3u8 (HLS) or .mp4
  type: 'hls' | 'mp4'
  autoplay?: boolean          // provider MUST mute to satisfy browser policy
  poster?: string
  live?: boolean              // true → live-edge HLS UI; false/omitted → VOD
  config?: ConfigValues       // the plugin's merged settings (e.g. theme)
  pluginId?: string
  className?: string
}
```

Backend meta: the `vidstack` entry in `streamhub-core-go/internal/plugins/builtin/builtins.json`
(`category:'tool'`, `ui:'player'`, no worker). Frontend plugin:
`streamhub-web/src/plugins/vidstack/{index.tsx,VidstackPlayer.tsx}`. Config keys
(`theme`, `autoplay`) are kept in lock-step on both sides.

Safari/iOS parity: Vidstack autoplays muted, is `playsInline`, and its own big
play-button is the tap-to-play affordance when autoplay is refused; hls.js is
bundled locally (no CDN fetch). It honours `prefers-reduced-motion`.

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
- **Safari/iOS:** the players carry the WebKit mitigations (playsinline, muted
  autoplay, tap-to-play unlock, H.264 publish default, TURN guidance) — see
  [WEBRTC-BROWSER-COMPAT.md](WEBRTC-BROWSER-COMPAT.md).
</content>
