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

**Cómo se autentican (invariante Fold-4):** las páginas se sirven en un iframe
`sandbox` sin `allow-same-origin`, así que NUNCA pueden leer el JWT admin del
panel. Por eso:

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
`{{API_URL}}`, `{{ADAPTOR_URL}}`, `{{HLS_URL}}`, `{{ROOM}}`. Todas reusan el
**streamhub-adaptor** (best-effort), y si el script del adaptor no está
disponible caen a `livekit-client` directo desde CDN — pineado a
**`livekit-client@2.15.7`** (par validado con el server LiveKit `v1.8.4`; ver
[adaptor-sdk.md](adaptor-sdk.md)).

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
              "embedUrl": "https://streamhub.example.com/samples/demo/webrtc-publish.html",
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

`https://streamhub.example.com/samples/<app>/<file>`

**Security (Fold-4 isolation):** every sample HTML document is served under a
CSP `sandbox` **without `allow-same-origin`** (`sandbox allow-scripts
allow-forms allow-popups allow-modals; frame-ancestors *`), so the browser loads
it into a **unique opaque origin**. A malicious/edited sample therefore cannot
read the panel's admin JWT from `localStorage`. Consequence for authors:
**samples must authenticate with a public listen/embed token per room**, never
the admin token. Static assets (.js/.m3u8/.ts) keep open CORS/CORP for CDN embeds.

## Examples

```bash
curl -s $BASE/apps/demo/samples -H "Authorization: Bearer $TOKEN"
curl -s $BASE/apps/demo/samples/hls-player.html -H "Authorization: Bearer $TOKEN"
curl -s -X POST $BASE/apps/demo/samples/regenerate -H "Authorization: Bearer $TOKEN"

# public embed (no auth)
open https://streamhub.example.com/samples/demo/webrtc-play.html
```

## Notes

- Editing a sample only touches that app's `apps/<app>/samples/<file>`.
- The `/samples/*` static mount lives outside `/api/v1` and 404s terminally
  (never falls through to the SPA).
</content>
