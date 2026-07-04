# streamhub-adaptor (drop-in AntMedia SDK)

## What it does

`@streamhub/adaptor` is a **drop-in replacement** for AntMedia's
`@antmedia/webrtc_adaptor` (`WebRTCAdaptor`) that talks to a StreamHub/LiveKit
server under the hood via `livekit-client`. Apps that use the AntMedia SDK
migrate by changing (almost) only the import / `<script src>`. The public surface
— constructor options, methods, and the **string-based callbacks**
(`"initialized"`, `"publish_started"`, `"newStreamAvailable"`, …) — is emulated.
`WebRTCAdaptor` is an alias of `StreamHubAdaptor`, so `new WebRTCAdaptor({...})`
keeps working.

```ts
// before
import { WebRTCAdaptor } from "@antmedia/webrtc_adaptor";
// after
import { WebRTCAdaptor } from "@streamhub/adaptor";
```

## How it gets a token

StreamHub mints LiveKit join tokens at `POST /apps/:app/tokens` →
`{ data: { token, wsUrl, room, identity, playUrl, embedUrl, iframe } }`. The
adaptor resolves credentials in order:

1. **Pre-minted** — pass `token` + `wsUrl` in the constructor (no network call;
   recommended for production, mint server-side with your StreamHub API token).
2. **Mint client-side** — pass `streamhubTokenUrl` (or `streamhubApiUrl` +
   `appName`) and optionally `streamhubApiToken`; the adaptor POSTs the token
   request for you.
3. **Derive from `websocket_url`** — an AntMedia-style
   `wss://host/<app>/websocket` is parsed to
   `https://host/api/v1/apps/<app>/tokens`.

## Distribution

- **npm:** `npm install @streamhub/adaptor livekit-client` (livekit-client is a
  peer dep for the ESM/CJS builds).
- **CDN / script tag:** the browser build bundles livekit-client and is served by
  the core at `https://streamhub.example.com/sdk/streamhub-adaptor.global.js`
  (the `/sdk` static mount; `SDK_DIR` configurable, default `<DATA_DIR>/sdk`). A
  missing file simply 404s and samples fall back to livekit-client.

> **Pinned version pair:** the SDK build, `streamhub-web` and every generated
> sample are pinned to **`livekit-client@2.15.7`**, validated against the
> **LiveKit server `v1.8.4`** image this stack ships (`docker-compose.yml`).
> Treat client and server as a matched pair — upgrade both together, not one
> at a time.

## Constructor options (subset)

| Option | Origin | Notes |
|--------|--------|-------|
| `websocket_url` | AntMedia | `wss://host/<app>/websocket`; `<app>` used to mint tokens |
| `mediaConstraints` | AntMedia | `{ video, audio }` → LiveKit capture options |
| `localVideoElement`/`localVideoId` | AntMedia | Local preview `<video>` |
| `bandwidth` | AntMedia | kbps → `videoEncoding.maxBitrate` |
| `dataChannelEnabled` | AntMedia | default `true` |
| `isPlayMode`/`playOnly` | AntMedia | subscribe-only (no cam/mic) |
| `callback` | AntMedia | `(info, obj) => void` string events |
| `token` + `wsUrl` | StreamHub | pre-minted credentials |
| `streamhubTokenUrl` / `streamhubApiUrl` + `appName` / `streamhubApiToken` | StreamHub | client-side minting |

## Example

```html
<script src="https://streamhub.example.com/sdk/streamhub-adaptor.global.js"></script>
<script>
  const adaptor = new WebRTCAdaptor({
    streamhubApiUrl: "https://streamhub.example.com/api/v1",
    appName: "demo",
    streamhubApiToken: "sk_...",        // or mint server-side and pass token+wsUrl
    localVideoId: "local",
    mediaConstraints: { video: true, audio: true },
    callback: (info, obj) => {
      if (info === "initialized") adaptor.publish("room1");
    },
  });
</script>
```

## Notes

- The adaptor emulates AntMedia's event names, so existing `switch(info)` handlers
  keep working.
- Used by the generated `webrtc-publish.html` / `webrtc-play.html` samples.
</content>
