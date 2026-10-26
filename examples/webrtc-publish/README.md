# StreamHub example — WebRTC publish

Publish camera/mic to a room over WebRTC (low latency).

## Run it

1. Edit **`config.js`** and set `baseUrl`, `wsUrl`, `app` and `room` to your
   StreamHub instance. (They currently hold placeholders.)
2. Host this folder on **any static host** — S3, Netlify, nginx, GitHub Pages —
   or just open `index.html` locally.
3. Done. No build step.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The example (identical to the page served at `/samples/YOUR_APP/webrtc-publish.html`). |
| `config.js` | The knobs you edit. Sets `window.STREAMHUB_CONFIG`. |

## Authentication

This example **publishes** media. Supply an ephemeral LiveKit JWT (`config.js` `token`, or `#token=…` in the URL). For local dev you may instead set `apiToken` to an `sk_` management token to mint on the fly — never expose that token to end users.

## Notes

- `index.html` loads the **livekit-client** from a pinned CDN
  (`livekit-client@2.15.7`) and the optional **streamhub-adaptor** from your own
  StreamHub (`baseUrl + /sdk/…`); it falls back to livekit-client if the adaptor
  is not deployed. You may self-host either — see `adaptorUrl` in `config.js`.
- **CORS:** the browser fetches the play/listen token from `baseUrl/api/v1/…`.
  A remote static host is a *different origin*, so your StreamHub must allow
  cross-origin reads on the public token endpoints (StreamHub sends
  `Access-Control-Allow-Origin: *` on `play-token`/`listen-token`). Same-origin
  hosting (serving the bundle from the StreamHub domain) needs no CORS.
