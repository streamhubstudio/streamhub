# Samples (per-app pages)

## What it does

Each app gets self-contained, auto-generated HTML sample pages wired to that
app, editable **without affecting other apps**. Generated on app creation (and
on demand):

- `webrtc-publish.html` — publish cam/mic with the **streamhub-adaptor** (asks
  the API for a token). Fields: app (fixed), room, identity.
- `webrtc-play.html` — subscribe/play WebRTC (low latency) with the adaptor.
- `hls-player.html` — video.js + HLS pointing at `/hls/<app>/<room>/index.m3u8`.
- `audio-radio.html` — radio: master (publishes audio) + listener (audio-only).

### Turnkey verticals (G4)

One self-contained page per use case, wired to the app and ready to embed:

| File | Vertical | Auth model | What it does |
|------|----------|-----------|--------------|
| `cctv-grid.html` | **CCTV baja latencia** | public play-token (no login) | Grilla de N cámaras: WebRTC `subscribe` de una lista de salas (coma-separada). El gemelo autónomo del panel **cockpit**. |
| `live-shopping.html` | **Live-shopping 1→N** | public play-token + ephemeral | Player WebRTC de baja latencia + chat/reactions sobre el data channel de LiveKit + botón "Comprar" (demo, `?buyUrl=` para checkout real). Chat de recepción con token público; para **enviar** pasá un token efímero con `canPublishData`. |
| `telemedicine.html` | **1:1 telemedicina/soporte** | ephemeral token | Sala privada 1:1 con **tokens efímeros**: el operador mintea un token por parte (server-side) y comparte un link `#room=…&token=…&ws=…`. Cámara PiP + remoto grande, mute/cam/colgar. |
| `radio-player.html` | **Radio / audio** | public listen-token (no login) | Player audio-only embebible (listener) sobre el `radio/:room/listen-token`. `?station=` para el nombre de la emisora. |
| `conference.html` | **Conferencia N-a-N (estilo Meet)** | ephemeral token / mint | Sala meeting con **pre-join** (nombre + selector de cámara/mic + preview antes de entrar), grilla responsive de tiles con resalte de active-speaker, compartir pantalla (promociona a tile grande), **chat lateral por data channel** (topic `chat`, sin persistencia, badge de no-leídos) y atajos de teclado (`m`/`v` mic/cam). |

**Cómo se autentican:** las páginas nunca usan el token admin del panel (ver
[Public serving](#public-serving-embeds) para el sandbox real). Por eso:

- las páginas **subscribe-only** (CCTV, radio, viewer de live-shopping) usan los
  endpoints **públicos** `GET /apps/:app/play-token/:room` (video+audio) y
  `GET /apps/:app/radio/:room/listen-token` (audio) — sin login, gateados por la
  feature `publicPlayback` del app;
- las páginas **que publican/interactúan** (telemedicina, conferencia, envío de
  chat en live-shopping) leen un **token efímero** de la URL
  (`#token=…&ws=…&room=…`), minteado server-side por el operador — el patrón
  pre-minted recomendado (nada de token admin en el navegador). En dev, la
  conferencia también puede mintear con `?apitoken=<sk_…>`.

Templates use placeholders resolved at generation time: `{{APP}}`, `{{WS_URL}}`,
`{{API_URL}}`, `{{ADAPTOR_URL}}`, `{{HLS_URL}}`, `{{ROOM}}`. Cargan el
**streamhub-adaptor** best-effort, pero manejan la sala con `livekit-client`
directo desde CDN — pineado a **`livekit-client@2.15.7`** (par validado con el
server LiveKit `v1.13.11`; ver [adaptor-sdk.md](adaptor-sdk.md)). El `room` se
escribe en el input de la página (`?room=` solo aplica junto a un token efímero
en el hash). `hls-player.html` usa video.js 8 con su VHS incluido.

## Management endpoints (under `/apps/:app/samples`)

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | `/apps/:app/samples` | sample:read | List sample files (+ embed URLs) |
| GET | `/apps/:app/samples/:file` | sample:read | Raw contents of one sample |
| PUT | `/apps/:app/samples/:file` | sample:write | Overwrite one sample (this app only) |
| POST | `/apps/:app/samples/regenerate` | sample:write | Regenerate the standard set from templates |

### Responses

```json
// GET /apps/:app/samples
{ "data": [ { "file": "webrtc-publish.html",
              "embedUrl": "https://streamhub.digitalhub.com.ar/samples/demo/webrtc-publish.html",
              "sizeBytes": 4096 } ] }
// GET /apps/:app/samples/:file
{ "data": { "file": "webrtc-publish.html", "content": "<!doctype html>..." } }
// PUT
{ "data": { "file": "webrtc-publish.html", "saved": true } }
// POST regenerate
{ "data": { "regenerated": ["webrtc-publish.html","webrtc-play.html","hls-player.html","audio-radio.html",
  "cctv-grid.html","live-shopping.html","telemedicine.html","radio-player.html","conference.html"] } }
```

## Public serving (embeds)

The rendered HTML is served publicly (no auth) at:

`https://streamhub.digitalhub.com.ar/samples/<app>/<file>`

**Security:** every sample HTML document is served under a CSP `sandbox`
(`sandbox allow-scripts allow-same-origin allow-forms allow-popups allow-modals;
frame-ancestors *`). `allow-same-origin` is there on purpose (since 2.x):
samples call `getUserMedia()`/`getDisplayMedia()` and fetch their tokens, and
Chromium refuses capture under an opaque origin (`SecurityError: Invalid
security origin`). **Samples must authenticate with a public listen/embed token
or an ephemeral token per room**, never the admin token. Static assets
(.js/.m3u8/.ts) keep open CORS/CORP for CDN embeds.

Where that origin is depends on `STREAMHUB_SAMPLES_URL`:

- **Unset (default):** samples share the **dashboard's origin**, whose
  localStorage holds the dashboard JWT — a stored sample would run with the
  session of whoever opens it. So editing samples (`sample:write`: `PUT …/samples/:file`,
  `POST …/samples/regenerate`) is **superadmin-only** (or a global API token),
  whatever the role policies say (since 3.2.1).
- **Set** (e.g. `https://samples.example.com`): samples get **their own
  origin** (see below) and `sample:write` is plain RBAC again (owner/editor,
  app-scoped tokens on their own app).

### Own origin for samples (`STREAMHUB_SAMPLES_URL`)

Point a second hostname (its own DNS record) at the same reverse proxy, forward
it to the core with the original `Host`, and set
`STREAMHUB_SAMPLES_URL=https://samples.example.com` on the core. The core then
splits by `Host`:

| Request | Result |
|---|---|
| samples host: `/samples/*`, `/api/*`, `/sdk/*`, `/hls/*` | served as usual (the pages call these **same-origin**) |
| samples host: anything else (`/`, SPA routes, assets, `/metrics`) | `302` to the same path on `PUBLIC_BASE_URL` — the dashboard is never served there, so nobody logs in on that origin (`404` if `PUBLIC_BASE_URL` is unset) |
| any other host: `/samples/*` | `302` to the same path + query on the samples origin |
| any other host: everything else | unchanged |

Serving the API on the samples host is safe because all auth is bearer-only
(no cookies): a page there can only use a credential it already holds, as it
could cross-origin. What it can no longer reach is the dashboard's localStorage.

With the variable set:

- pages are rendered against the samples origin (`{{API_URL}}`,
  `{{ADAPTOR_URL}}`, `{{HLS_URL}}`), `GET /apps/:app/samples` hands out
  `embedUrl`s on it, and `GET /auth/config` reports it as `samplesUrl` — the
  dashboard's Samples editor (preview iframe, URL, embed snippet, open link) and
  the Radio listener link use it. The preview iframe then also gets
  `allow-same-origin` (it is the samples origin, not the dashboard's), so
  camera/mic work in the preview;
- at boot, standard pages still **untouched** since they were generated
  against `PUBLIC_BASE_URL` are re-rendered against the samples origin; pages
  you edited are left alone — **Regenerate** them (or fix their URLs) so they
  call the API same-origin (cross-origin, only the public token routes send
  CORS headers);
- the legacy `publish.html`/`play.html` written on app creation call the API on
  the samples origin; their `/play`/`/embed` links stay on the dashboard (SPA routes);
- downloadable bundles (`/examples`) keep `PUBLIC_BASE_URL` (they run elsewhere).

**Verified in real Chromium** (3.3.0; Playwright with fake camera/mic and screen capture,
local LiveKit, Caddy running `deploy/Caddyfile` with `app.localhost` + `samples.localhost`):
from the samples origin, webrtc-publish (`#token` and `?apitoken` → `POST …/tokens`
same-origin), webrtc-play, hls-player, conference (2 parties, chat, screen share),
telemedicine, audio-radio master + listener, radio-player, cctv-grid and live-shopping
(chat + buy popup) all work; the samples origin's localStorage is empty while the dashboard
holds its token; `/samples/…` on the dashboard and the SPA on the samples host redirect; the
dashboard editor previews the sample on the samples origin (with `allow-same-origin`). The
legacy `publish.html`/`play.html` still 401 (they mint without a credential), as before.

Proxy recipes: `deploy/Caddyfile` (`SAMPLES_DOMAIN`, Docker shape) and
`deploy/nginx-samples.conf` (second vhost; `install.sh --samples-domain` installs it) — see
[DEPLOY.md](../operations/DEPLOY.md#own-origin-for-samples). An invalid value,
or one equal to `PUBLIC_BASE_URL`'s origin, is ignored (samples stay on the
dashboard origin, stopgap on).

## Examples

```bash
curl -s $BASE/apps/demo/samples -H "Authorization: Bearer $TOKEN"
curl -s $BASE/apps/demo/samples/hls-player.html -H "Authorization: Bearer $TOKEN"
curl -s -X POST $BASE/apps/demo/samples/regenerate -H "Authorization: Bearer $TOKEN"

# public embed (no auth)
open https://streamhub.digitalhub.com.ar/samples/demo/webrtc-play.html
```

## Downloadable bundles

Each sample is also available as a **downloadable, self-contained, configurable
bundle** (index.html + config.js + README) that runs on any static host pointed
at any StreamHub — see **[EXAMPLES.md](EXAMPLES.md)**. List/download via
`GET /apps/:app/examples`, `GET /apps/:app/examples/:id.zip` and
`GET /apps/:app/examples/all.zip` (`sample:read`); the dashboard's Samples tab
exposes per-example download buttons. The bundle shares the exact template
source with the served page (only a `config.js` overlay differs).

## Notes

- Editing a sample only touches that app's `apps/<app>/samples/<file>`.
- The `/samples/*` static mount lives outside `/api/v1` and 404s terminally
  (never falls through to the SPA).
</content>
