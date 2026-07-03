# Adaptive VOD + encodings de salida (transcoding post-egress)

## Qué resuelve

1. **App nueva SIN transcoding (passthrough)** — el bloque `transcoding:` del
   `config.yaml` per-app trae `enabled: false` por defecto: el ingress RTMP no se
   re-encodea y cada grabación es un único MP4/H.264. Todo lo demás es opt-in.
2. **Encoding de salida de grabaciones** — `transcoding.encoding: h264 | h264+vp8`.
   Con `h264+vp8`, además del MP4 se genera un **WebM/VP8 (+Opus)** por grabación.
3. **VOD multi-variante adaptativo** — con `transcoding.vod_adaptive: true`, cada
   grabación produce UN VOD con N renditions H.264 en HLS + un **master playlist**
   (`.m3u8`) que las referencia, todo subido al S3 de la app.

## Qué hace LiveKit egress vs qué hace ffmpeg (honesto)

| Paso | Quién | Detalle |
|------|-------|---------|
| Grabar la room a archivo | **LiveKit egress** | `EncodedFileOutput` → **un solo MP4/H.264**. El egress NO puede emitir VP8/WebM ni múltiples renditions de archivo en un mismo egress. |
| Variante WebM/VP8 | **ffmpeg post-transcode** | `libvpx` + `libopus` desde el MP4 fuente. |
| Ladder HLS (N renditions + master) | **ffmpeg post-transcode** | Un `ffmpeg` por rendition (`scale=-2:h`, `libx264` + AAC, `-hls_playlist_type vod`) + master `.m3u8` generado por el core. |

El post-transcode corre como job **BullMQ** (`streamhub-vod-transcode`, concurrencia 1
porque ffmpeg es CPU-bound), encolado por `RecordingService` después de que el VOD base
quedó `ready`. Es **best-effort**: si ffmpeg falla, el VOD MP4 queda intacto y el error
se registra en logs + `metatags_json.variantsError` — nunca se degrada el flujo base.

## Flujo completo

```
recording/start ──► egress LiveKit ──► MP4 local ──► (webhook egress_ended)
   ──► job upload (BullMQ): probe + snapshot + S3 upload ──► VOD ready ──► vod_ready
        └─ si transcoding lo pide: NO borra el MP4 local todavía y encola
   ──► job transcode (BullMQ streamhub-vod-transcode), por cada grabación:
        ├─ N renditions HLS → S3 hls/<base>/<h>p/{index.m3u8, seg_NNNN.ts}
        ├─ master playlist  → S3 hls/<base>/master.m3u8
        ├─ (h264+vp8) alternate → S3 <base>.webm
        ├─ filas en vod_variants (kinds master|rendition|alternate)
        ├─ metatags: hlsMasterKey + variantCount
        ├─ callback vod_variants_ready
        └─ borra el MP4 local si delete_local_after_upload (delete diferido)
```

### Config (per-app `config.yaml`)

```yaml
transcoding:
  enabled: true            # master switch (default false = passthrough)
  encoding: h264+vp8       # h264 | h264+vp8
  vod_adaptive: true
  vod_renditions:          # vacío = derivado de webrtc.layers (bitrates por defecto)
    - { height: 720, bitrate_kbps: 2800 }
    - { height: 480, bitrate_kbps: 1400 }
    - { height: 240, bitrate_kbps: 500 }
```

API: `PATCH /apps/{app}/config` con `transcodingEnabled` / `encoding` / `vodAdaptive` /
`vodRenditions`. Ver [api-app.md](../api-app.md#patch-appsappconfig).

### Modelo de datos — `vod_variants` (per-app app.db, migración #6)

| Columna | Notas |
|---------|-------|
| `vod_id` | FK lógica a `vods.id` (cascade hecho por el service en `DELETE /vods/:id`). |
| `kind` | `master` (playlist maestro HLS) \| `rendition` (un escalón del ladder) \| `alternate` (encoding alternativo de archivo completo, ej. WebM). |
| `format` | `hls` \| `hls-h264` \| `webm-vp8`. |
| `height`, `bitrate_kbps` | Sólo renditions/alternates. |
| `file_key` | Key S3: playlist para HLS, archivo para alternates. |
| `size_bytes` | Suma playlist+segmentos (renditions) o el archivo. |
| `extra_json` | Renditions: `{ segmentKeys: [...] }` — para el delete cascade completo. |

`GET /apps/{app}/vods/{id}` expone `adaptive` (masterKey + masterUrl) + `variants[]`;
`DELETE` borra también todos los objetos S3 de las variantes (playlists + segmentos +
webm) además del MP4/snapshot.

### Playback

- El player HLS apunta a `adaptive.masterUrl`. **Requiere `s3.public_url`** (base
  pública/CDN): los segmentos se resuelven relativos al playlist, así que un playlist
  presignado solo no alcanza. Sin base pública, las renditions exponen `url: null`
  (el master/alternates caen a presigned como referencia).
- El MP4 base sigue siendo el download/playback por defecto (`url`/`presignedUrl`).

## Callbacks

- `vod_variants_ready` — `{ vodId, app, room, streamId, masterKey, webmKey, variants[] }`
  al terminar el job (solo si generó al menos una variante).

## Límites conocidos / siguiente paso

- El ladder se genera **en serie** (concurrencia 1) desde el MP4 fuente; para
  grabaciones largas el costo es ~1x duración por rendition en CPU. `hwaccel` (GPU)
  todavía **no** se aplica al post-transcode ffmpeg (sí al egress) — siguiente paso
  natural: reusar `HwAccelService` para elegir `h264_nvenc`/`h264_vaapi` en
  `vod-transcode.util.ts`.
- Split recordings: cada parte (VOD propio) genera su propio set de variantes; no se
  concatenan partes en un único VOD adaptativo.
- No hay re-transcode retroactivo de VODs viejos (solo grabaciones nuevas); un endpoint
  `POST /vods/:id/transcode` sería el siguiente paso para backfill.
