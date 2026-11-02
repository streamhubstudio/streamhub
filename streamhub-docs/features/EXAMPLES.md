# Downloadable examples (self-contained bundles)

## What it does

Every shipped [sample](samples.md) can be pulled as a **downloadable,
self-contained, configurable bundle** that runs on **any static host** (S3,
Netlify, nginx, GitHub Pages) pointed at **any** StreamHub instance. Where the
`/samples/<app>/<file>` pages are served by the core and wired to one app, a
bundle is a standalone folder a user hosts themselves:

```
<example>/
  index.html    # the example — the SAME page served at /samples/<app>/<file>
  config.js      # the knobs you edit (window.STREAMHUB_CONFIG)
  README.md      # "edit config.js, host anywhere, done"
```

The bundle and the served page share the **exact same template source**
(`streamhub-core-go/internal/samples/bundle.go` reuses
`Templates` + `RenderPlaceholders` from `templates.go`). The only
difference: the bundle prepends `<script src="./config.js"></script>`, whose
`window.STREAMHUB_CONFIG` **overrides** the values otherwise baked into the page.
So there is no forked logic — the served page simply has no `config.js`.

## The examples

| id | Title | Auth model | Notes |
|----|-------|-----------|-------|
| `webrtc-publish` | WebRTC publish | publisher | publish cam/mic; needs a token |
| `webrtc-play` | WebRTC play | public | subscribe (low latency) |
| `hls-player` | HLS player | public | video.js HLS |
| `audio-radio` | Radio (master + listener) | publisher | master on air / listener |
| `cctv-grid` | CCTV grid | public | N cameras, comma-separated rooms |
| `live-shopping` | Live shopping | public | viewer + chat/reactions + buy |
| `telemedicine` | Telemedicine 1:1 | ephemeral | private room, per-party token |
| `radio-player` | Radio player | public | embeddable audio listener |
| `conference` | Conference (N-to-N) | publisher | pre-join, tiles, screen, chat |

**Auth models** (drive `config.js` + the per-bundle README):

- **public** — subscribe-only; uses the PUBLIC `play-token`/`listen-token` (no
  login). Works as long as the app has `publicPlayback` enabled.
- **ephemeral** — joins a private room with a pre-minted ephemeral LiveKit JWT.
  Mint one server-side and paste it into `config.js` (`token`) or share a link
  with `#token=…&room=…&ws=…`.
- **publisher** — publishes media; supply an ephemeral `token`, or (dev only) an
  `sk_` `apiToken` to mint on the fly. **Never** ship an `sk_` token to end users.

## Configurability (`config.js`)

```js
window.STREAMHUB_CONFIG = {
  baseUrl: 'https://your-streamhub.example.com', // REST + HLS + SDK origin (no trailing slash)
  wsUrl:   'wss://your-streamhub.example.com',   // LiveKit signaling ws
  app:     'YOUR_APP',                            // app slug
  room:    'demo',                               // default room
  // publisher/ephemeral examples only:
  token:   '',                                    // ephemeral LiveKit JWT (or #token=… in the URL)
  apiToken:'',                                    // DEV ONLY: sk_ token to mint
  // adaptorUrl: '',                              // optional; defaults to baseUrl + /sdk/…
};
```

`index.html` resolves everything from `window.STREAMHUB_CONFIG`:
`API_URL = baseUrl + /api/v1`, `HLS_BASE = baseUrl + /hls/<app>`,
`ADAPTOR_URL = baseUrl + /sdk/streamhub-adaptor.global.js` (falls back to
`livekit-client` if the adaptor is not deployed). **Changing host/app is a
`config.js` edit only — no build step, index.html never changes.**

`livekit-client` loads from a pinned CDN (`livekit-client@2.15.7` — the pair
validated against LiveKit server 1.8.4); you may self-host it if you prefer no
third-party CDN. The adaptor loads from **your own StreamHub** (`/sdk/…`), not a
third-party host.

## Download mechanism

### 1) REST endpoint (per-app, pre-configured)

Under `/apps/:app/examples` (management, Bearer, `sample:read`). The zip's
`config.js` is pre-filled with **that app's** public URLs.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/apps/:app/examples` | List the catalogue (+ per-app download URLs + required config keys) |
| GET | `/apps/:app/examples/:id.zip` | Download one bundle as a zip |
| GET | `/apps/:app/examples/all.zip` | Combined zip of every example (each under its own folder) |

```bash
curl -s $BASE/api/v1/apps/demo/examples -H "Authorization: Bearer $TOKEN"
curl -sOJ $BASE/api/v1/apps/demo/examples/webrtc-play.zip -H "Authorization: Bearer $TOKEN"
curl -sOJ $BASE/api/v1/apps/demo/examples/all.zip        -H "Authorization: Bearer $TOKEN"
```

The zip is produced in-process (dependency-free STORE-method writer,
`streamhub-core-go/internal/samples/zip.go`) — no `zip` binary needed in the core image. Zips carry
**no secrets** (public baseUrl/wsUrl + non-sensitive app/room slugs; credential
fields ship empty).

The dashboard's **Samples** tab has a *Download standalone bundles* card with a
per-example **Download .zip** button and **Download all**.

### 2) Committed `examples/` + build script (generic)

`streamhub-core-go/cmd/build-examples` assembles the **generic** (placeholder-configured)
bundles into the committed `examples/` tree from the SAME source as the served
`/samples` pages and the per-app download (`internal/samples`):

```bash
cd streamhub-core-go && go generate ./cmd/build-examples   # regenerate examples/
# → examples/<id>/{index.html,config.js,README.md}
# → examples/README.md
# → examples/dist/<id>.zip + examples/dist/streamhub-examples.zip  (gitignored)
```

`examples/<id>/` folders are committed (diffable, directly hostable); the
`examples/dist/*.zip` are regenerable and gitignored (the endpoint serves per-app
zips dynamically anyway). `TestCommittedExamplesUpToDate` (`internal/samples`)
fails while the committed tree drifts from the templates.

## CORS (remote hosting)

A bundle on a **different origin** (Netlify/S3/…) fetches the play/listen token
from `baseUrl/api/v1/…`. StreamHub sends `Access-Control-Allow-Origin: *` on the
public token endpoints (`GET play-token/:room`, `GET radio/:room/listen-token`)
so those cross-origin reads succeed. Hosting the bundle on the StreamHub domain
itself needs no CORS. Publisher/ephemeral flows carry the token in `config.js` or
the URL hash, so they do not depend on a cross-origin API call.

## Notes

- The download endpoints reuse the `sample:read` RBAC permission — no new
  resource/action.
- Editing `config.js` is the ONLY change a user makes; `index.html` is identical
  to the page served at `/samples/<app>/<file>`.
