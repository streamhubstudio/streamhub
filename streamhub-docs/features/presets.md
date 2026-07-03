# Config presets (G4)

Presets apply a **declarative delivery/quality profile** to an app's
`config.yaml` in one call: they deep-merge a partial config over the current one,
take a timestamped backup, write it, and **hot-reload** the app in place (no
process restart, no cut streams). They exist so an operator can pick a use case
("baja latencia", "grabación premium", "audiencia masiva") instead of hand-tuning
a dozen keys.

Defined declaratively in
[`streamhub-core/src/modules/apps/config-presets.ts`](../../streamhub-core/src/modules/apps/config-presets.ts).

## Endpoints

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | `/apps/:app/presets` | `config:read` | List the presets (id, title, description, use case, what each sets) |
| POST | `/apps/:app/presets/:name/apply` | `config:write` | Apply a preset → backup + write + hot-reload; returns the diff |

```json
// GET /apps/:app/presets
{ "data": [ { "name": "low-latency", "title": "Baja latencia (WebRTC-first)",
             "description": "…", "useCase": "CCTV, subastas, 1:1…",
             "sets": ["transcoding.enabled = false", "webrtc.adaptive = true", "…"] } ] }

// POST /apps/:app/presets/low-latency/apply
{ "data": { "preset": "low-latency", "applied": true, "reloaded": true,
            "changed": true, "diff": "- transcoding:\n-   enabled: true\n+ …",
            "warnings": [] } }
```

## The three presets

### `low-latency` — WebRTC-first

Reproducción interactiva sub-segundo. Passthrough puro para no agregar el costo de
un re-encode server-side, y **simulcast ON** (que según
[LATENCY-TUNING](../operations/LATENCY-TUNING.md) es *mejor* para latencia: el
subscriber arranca por la capa rápida).

| Key | Valor | Por qué |
|-----|-------|---------|
| `transcoding.enabled` | `false` | passthrough puro, sin re-encode |
| `webrtc.adaptive` | `true` | simulcast ON (−100ms vs sin simulcast) |
| `rtmp.transcode` | `false` | ingress passthrough |
| `features.adaptive_player` | `true` | player adaptativo |
| `distribution.mode` | `edge` | WebRTC-first, sin indirección de CDN |
| `hls.segment_seconds` / `hls.list_size` | `2` / `3` | segmentos cortos por si se usa HLS puntual |

> **Playout delay bajo** no es una key del yaml: se setea por track/room desde el
> SDK/player (LATENCY-TUNING **L3**). Los samples de baja latencia usan el path
> WebRTC (`play-token`), no HLS.

**Caso:** CCTV, monitoreo, subastas, telemedicina/soporte, live-shopping interactivo.

### `high-quality-recording` — grabación premium

Transcoding ON con ladder, grabación H.264 (opción `h264+vp8` para una alternativa
WebM/VP8) y VOD adaptativo (master `.m3u8` + renditions). Prioriza calidad y
compatibilidad del archivo sobre latencia.

| Key | Valor |
|-----|-------|
| `transcoding.enabled` | `true` |
| `transcoding.encoding` | `h264` (editable a `h264+vp8`) |
| `transcoding.vod_adaptive` | `true` |
| `transcoding.vod_renditions` | `1080/5000`, `720/2800`, `480/1400` |
| `recording.enabled` / `recording.mode` | `true` / `room-composite` |
| `rtmp.transcode` | `true` |
| `webrtc.adaptive` + `webrtc.layers` | `true` + `1080/720/480` |

**Caso:** eventos grabados, clases, VOD premium, archivo/QC.

### `mass-audience-HLS` — audiencia masiva

HLS con segmentos/list optimizados detrás de un **CDN** + ladder transcodificado,
para miles/cientos de miles de espectadores. Latencia 6–15s a cambio de escala
barata y cacheable (ver [DISTRIBUTION-CDN-P2P](../architecture/DISTRIBUTION-CDN-P2P.md)).

| Key | Valor |
|-----|-------|
| `transcoding.enabled` + `vod_adaptive` | `true` |
| `transcoding.vod_renditions` | `720/2800`, `480/1400`, `360/800` |
| `webrtc.adaptive` + `features.adaptive_player` | `true` |
| `recording.enabled` | `true` |
| `distribution.mode` | `cdn` (completá `distribution.cdn.base_url` con el dominio del CDN) |
| `hls.segment_seconds` / `hls.list_size` | `4` / `10` |

**Caso:** eventos masivos, streams públicos, radio/audio 24/7, webinars grandes.

## Seguridad — qué NO tocan los presets

Un preset **nunca** sobreescribe credenciales ni identidad. Antes de mergear, estas
keys se descartan del patch (`PRESET_PROTECTED_KEYS`):

- `s3` — provider/bucket/region/endpoint/prefix y los `*_env` refs; las claves S3
  reales viven en `data/secrets.json` (chmod 600) y **jamás** las toca un preset;
- `callbacks` — incluido el `secret` HMAC del webhook;
- `name`, `display_name`, `room_prefix` — identidad/branding del app.

El merge además: mergea objetos anidados en profundidad, **reemplaza** arrays
enteros (un ladder nuevo swapea el viejo, no concatena) e ignora valores
`undefined`.

## Notas

- **`distribution:` y `hls:`** son la superficie de config *forward-looking* de
  [DISTRIBUTION-CDN-P2P §6](../architecture/DISTRIBUTION-CDN-P2P.md) y la matriz
  **B1**. Se escriben y **persisten** en el YAML (round-trip por `GET
  /apps/:app/config/raw`) para que un setup de CDN/edge las lea; las consume el
  sistema a medida que esas features aterrizan (F1/F2). Las keys que tienen efecto
  **hoy** (`transcoding`, `webrtc`, `rtmp`, `features`, `recording`) son config
  real y resuelta.
  - Caveat: un `PATCH /apps/:app/config` **estructurado** posterior re-serializa
    sólo los bloques tipados y podría descartar `distribution`/`hls`. Editá esos
    bloques desde el editor **raw** (o re-aplicá el preset) hasta que F1/F2 los
    cablee al `AppConfig`.
- Aplicar un preset deja un **backup** timestamped (`config.yaml.bak.<ts>`),
  revertible desde la tab Config → backups.
- El `diff` devuelto es el mismo formato unificado del dry-run del editor raw.
