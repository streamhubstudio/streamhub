# DVR / timeshift (G5) y clips instantáneos y por evento (G6)

> 3.4.0. Roadmap: `planning/FEATURE-GAPS-ROADMAP.md` (G5, G6 y el quick win AMS
> `hlsTime`/`hlsListSize`). Todo apagado por defecto: una app sin los bloques nuevos
> se comporta exactamente como antes (mismo egress, mismo `index.m3u8`, nada podado).

## Qué resuelve

- **DVR**: cualquier stream de una app se puede rebobinar en el player (dashboard,
  `/play` y `/embed`) hasta `window_minutes` hacia atrás, con botón **Ir al vivo**,
  línea de tiempo con reloj de pared y deep link `?t=`.
- **hlsTime / hlsListSize** (settings de Ant Media): duración de segmento del egress
  HLS y tamaño de la ventana del playlist servido, por app.
- **Clips**: `POST /apps/:app/streams/:id/clips` corta un rango (`{from, to}`) o un
  evento (`{eventTs, before, after}`) de los segmentos HLS/DVR **sin re-encodear**
  (`ffmpeg -c copy`), lo sube al S3 de la app y lo deja como VOD con `source: clip`.
  Un cajón de Streamflow (`action.clip`) hace lo mismo desde un evento de LPR, PPE,
  perimeter, etc., y el webhook `clip.ready` cierra el circuito.

## Configuración (`config.yaml`)

```yaml
features:
  hls:                     # hlsTime / hlsListSize (AMS)
    segment_seconds: 4     # hlsTime: segmento del egress HLS, 1..30 s (default 4)
    list_size: 0           # hlsListSize: segmentos del playlist servido; 0 = todos (default)
  dvr:
    enabled: false         # ventana rebobinable por stream
    window_minutes: 60     # 1..1440 (default 60)
  clips:
    enabled: false
    max_seconds: 120       # duración máxima de un clip, 1..600
    max_concurrent: 2      # jobs de ffmpeg simultáneos por app, 1..8
    max_queued: 20         # queued + running por app antes de responder 429, 1..200
```

Se editan con el editor de config (`PUT /apps/:app/config/raw`), como `features.linear`.
Se resuelven en `AppConfig.features.{dvr,hls,clips}` **solo** cuando el bloque existe
(si no, quedan fuera del JSON). Valores basura se acotan al rango; solo un `true`
literal habilita. Detalle por clave: [config-reference.md](../config-reference.md#features-spec-16).

### Precedencia y compatibilidad con `linear.dvr`

`features.dvr` **>** `features.linear.dvr` (QW-4, sin cambios) **>** `features.hls.list_size`.

| Config | Playlist servido | Egress | Poda | Watchdog |
|---|---|---|---|---|
| nada (default) | `index.m3u8` (completo) | 4 s | no | — |
| `hls.segment_seconds: N` | `index.m3u8` | N s | no | — |
| `hls.list_size: K` | `dvr.m3u8` (últimos K) | `hls.segment_seconds` | no | — |
| `linear.dvr: true` (legado) | `live.m3u8` (rolling de LiveKit) | + `live.m3u8` | `dvr_window_seconds`, protege `live.m3u8` | si `always_on_hls` |
| `dvr.enabled: true` | `dvr.m3u8` (ventana de `window_minutes`) | `hls.segment_seconds` | ventana + 3 segmentos, protege `dvr.m3u8` | **siempre** (un DVR que no graba no es DVR) |

`linear.dvr` sigue funcionando igual que en 2.x/3.3 (sirve el rolling `live.m3u8`, que
es corto: no permite rebobinar). Para rebobinar, migrar a `features.dvr`. Si una app
tiene los dos, gana `features.dvr`.

`hlsListSize` derivado bajo DVR: `ceil(window_minutes·60 / segment_seconds)` (60 min a
4 s = 900 segmentos). `hls.list_size` se ignora cuando el DVR está activo.

## Cómo funciona el DVR

LiveKit (`SegmentedFileOutput`) no expone un tamaño de ventana: escribe `index.m3u8`
como playlist **EVENT** (todos los segmentos desde que arrancó el egress, con
`#EXT-X-PROGRAM-DATE-TIME`) y, si se le pide, un rolling corto `live.m3u8`. El core
deriva el playlist servido:

- **`dvr.m3u8`** = los últimos N segmentos de `index.m3u8`, como **sliding window**
  (sin `EXT-X-PLAYLIST-TYPE`, porque una ventana pierde la cabeza y EVENT lo prohíbe),
  con `MEDIA-SEQUENCE` / `DISCONTINUITY-SEQUENCE` avanzando por lo descartado, un
  `PROGRAM-DATE-TIME` por segmento (sin PDT en el origen se sintetiza desde el mtime
  del segmento más nuevo) y `ENDLIST` cuando el origen terminó.
- Lo escribe un **writer** en disco (tmp + rename atómico) que chequea `index.m3u8`
  cada 1 s y reescribe solo si cambió. Lo arman `POST …/hls/start`, `GET …/hls` y el
  watchdog (que lo re-arma tras un reinicio del core); `…/hls/stop` lo desarma.
  Corre aunque el watchdog esté apagado (`STREAMHUB_HLS_WATCHDOG=off`).
- Al estar en disco, el **HLS direct-serve** (nginx/Caddy sirviendo `/hls` desde
  `DATA_DIR`, [operations/SCALING.md](../operations/SCALING.md)) lo sirve sin cambios.
- El watchdog mantiene vivo el egress de cada stream activo (DVR implica always-on) y
  poda los `.ts` más viejos que la ventana (+3 segmentos de margen), nunca uno
  referenciado por `dvr.m3u8`.
- `POST/GET /apps/:app/streams/:id/hls` devuelven `playlistUrl` → `…/dvr.m3u8` y
  `dvr: {windowSeconds, segmentSeconds}` (la clave solo existe con `features.dvr`).

Límite conocido: si el egress se relanza (caída de la fuente), LiveKit reescribe
`index.m3u8` desde cero en el mismo directorio — la línea de tiempo del DVR arranca de
nuevo en ese punto (los segmentos viejos quedan huérfanos y los poda el janitor).

## Player: seek, "Ir al vivo", línea de tiempo y `?t=`

`<HlsPlayer dvr>` (video.js) agrega bajo el video: barra de rango sobre la ventana
seekable, reloj de pared de la posición (vía `PROGRAM-DATE-TIME`), "−mm:ss detrás del
vivo", **Ir al vivo** (`liveTracker.seekToLiveEdge`) y **Copiar enlace a este momento**
(la URL actual con `?t=<epoch>`). En modo `auto` una fuente DVR usa video.js aunque la
app tenga un provider (Vidstack) activo, porque el provider no tiene seam para `?t=`.

- **Dashboard** (Streams → HLS): usa el `dvr` que devuelve start/status.
- **`/play/:app/:room`** y **`/embed/:app/:room`**: hacen una segunda sonda one-shot de
  `dvr.m3u8`; si está vivo lo reproducen con la barra DVR y respetan `?t=`.

### Formato de `?t=` (elegido)

| Forma | Ejemplo | Significado |
|---|---|---|
| epoch en **segundos** | `?t=1793282400` | instante absoluto (la forma para enlazar desde un evento: es el `ts` que mandan los workers) |
| epoch en ms | `?t=1793282400123` | instante absoluto |
| ISO-8601 | `?t=2026-10-29T14:00:00Z` | instante absoluto |
| relativo al vivo | `?t=-90`, `?t=-5m`, `?t=-1h30m`, `?t=-45s` | tanto tiempo detrás del vivo |

Cualquier otra cosa se ignora (arranca en vivo). Un instante fuera de la ventana se
acota al borde más cercano y se avisa en la barra. Sin `PROGRAM-DATE-TIME` el mapeo
epoch → tiempo de media se aproxima por "ahora − instante" (error ≈ latencia HLS).
Lógica pura en `streamhub-web/src/lib/dvr.ts` (+ `dvr.spec.ts`).

## Clips (G6)

### API

| Método | Ruta | Permiso | |
|---|---|---|---|
| POST | `/apps/{app}/streams/{id}/clips` | `vod:write` | crea el job (202, `status: queued`) |
| GET | `/apps/{app}/streams/{id}/clips` | `vod:read` | clips del stream, más nuevos primero (`?limit`, default 100, máx 500) |
| GET | `/apps/{app}/clips` | `vod:read` | clips de la app |
| GET | `/apps/{app}/clips/{clipId}` | `vod:read` | estado + `vodId` + `url` (presignada/pública) cuando está listo |

Cuerpo (una de dos formas):

```jsonc
{ "from": 1793282390, "to": "2026-10-29T14:00:10Z" }      // rango explícito
{ "eventTs": 1793282400.25, "before": 10, "after": 10 }   // evento (before/after default 10 s)
```

Instantes: epoch en s o ms (número o string) o ISO-8601. Respuesta:

```json
{ "data": { "id": "clp_…", "app": "live", "streamId": "cam1/enc", "room": "cam1",
  "from": "2026-10-29T13:59:50.000Z", "to": "2026-10-29T14:00:10.000Z", "durationS": 20,
  "status": "queued", "vodId": null, "error": null, "origin": { "kind": "api" },
  "createdAt": "…", "updatedAt": "…" }, "error": null }
```

Errores: 400 si `features.clips` está apagado, el cuerpo es inválido, dura < 1 s o más
que `max_seconds`, empieza antes del segmento más viejo en disco o termina más de 120 s
en el futuro; 404 app/stream; 409 si el room no tiene segmentos HLS en disco (arrancá su
egress HLS o activá `features.dvr`) o la app no tiene bucket (`storage_not_configured`,
el mismo guard de recording); 429 con `max_queued` jobs pendientes.

### Pipeline

1. `queued` → `running`: si el rango llega más allá del vivo, el job espera a que el
   egress escriba esos segmentos (fin del rango + 2 segmentos; acotado a +30 s; si el
   stream terminó antes, corta lo que exista).
2. Lee `index.m3u8`, ubica cada segmento en el reloj (PDT) y elige los que se solapan
   con el rango y siguen en disco. Si no queda ninguno (podado de la ventana DVR entre el
   pedido y el corte) → `failed` con motivo.
3. `ffmpeg -f concat -safe 0 -ss <offset> -i <lista> -t <dur> -c copy -bsf:a aac_adtstoasc
   -movflags +faststart clip-<room>-<UTC>-<id>.mp4`. **Precisión**: `-c copy` arranca en
   el keyframe en/antes del offset → ±1 GOP.
4. El MP4 sube por el uploader de recording (`recording.PublishFile`: probe → snapshot →
   S3 de la app con sus credenciales por `SecretRef` → presign 7 días) bajo `clips/`, y
   queda una fila VOD `ready` con `source: "clip"` y metatags `{source, clipId, clipFrom,
   clipTo, origin}`. No se emiten `recording_*`/`vod_ready` ni se encola transcode.
5. `ready` (con `vodId`) + webhook **`clip.ready`**; si algo falla, `failed` +
   **`clip.failed`**.

Estado persistido en `apps/<app>/app.db` (tabla `clips`, migración de app 015). La cola
es en proceso, con tope por app (`max_concurrent`, FIFO); al arrancar, los clips que un
core anterior dejó `queued`/`running` pasan a `failed` ("interrupted by a core restart")
— no se reanudan porque el rango puede haberse podado.

La lista de VODs filtra por origen: `GET /apps/:app/vods?source=clip` (o `recording`,
que incluye las filas previas a 3.4.0, con la columna en NULL). Cada `VodRecord` trae
`source`.

### Webhooks

`clip.ready` y `clip.failed` salen por el funnel de callbacks (webhook firmado + MQTT +
el tap de Streamflow) y están en el catálogo de eventos de Streamflow (familia
`clips`, con `clip.*`). Payload de `clip.ready`:

```json
{ "clipId": "clp_…", "app": "live", "room": "cam1", "streamId": "cam1/enc",
  "from": "…", "to": "…", "durationS": 20, "vodId": 42, "fileKey": "clips/clip-cam1-…mp4",
  "url": "https://…presigned…", "sizeBytes": 1834221, "source": "clip",
  "origin": { "kind": "streamflow", "event": "plate.detected", "eventTs": 1793282400250,
              "workflowId": "wf_…", "runId": "run_…", "data": { "plate": "AB123CD", "room": "cam1" } } }
```

### Streamflow: `action.clip`

Campos: `room` (default: room del trigger), `eventTs` (templado; default `trigger.ts`,
si no ahora), `before`/`after` (default 10 s), `wait` (bloquea hasta 45 s — dentro del
presupuesto de 60 s de una corrida — para que los cajones siguientes reciban
`{{<id del cajón>.vodId}}` / `{{<id>.url}}`, p. ej. `{{clip.url}}` si el cajón se llama
`clip`). Salida: `{clipId, status, from, to, vodId?, url?,
error?}`. No corre sobre un trigger `clip.*` (guard de loop). El clip guarda el evento,
el workflow y la corrida de origen, así que queda enlazado en ambos sentidos: la corrida
muestra el `clipId`, y `clip.ready` / `GET …/clips/{id}` traen el evento.

Ejemplo — patente detectada → clip de 20 s → aviso con el enlace:

```
trigger.event(plate.detected) → action.clip {wait: true} → action.notify {title: "Patente {{trigger.plate}}", payload: {clip: "{{clip.url}}"}}
```

### Perimeter (app desacoplada) — unificación

El worker de `perimeter` (`plugins-vendor/perimeter`, repo aparte) hoy arma su propia
"evidencia" de clip: concatena los últimos segmentos del `index.m3u8` local con ffmpeg
`-c copy` (`evidence.copy_clip`) y deja el MP4 en `<appDir>/perimeter/evidence/`, sin
S3, sin fila VOD y solo cuando el worker corre en el mismo host que el HLS. Además
postea `perimeter.intrusion` a un webhook propio, no al funnel del core. Cambios a
hacer **en el repo de perimeter**:

1. Declarar `"events": ["perimeter.intrusion"]` en `streamhub.app.json` y emitir el
   evento por el ingest del core (`POST /api/v1/apps/:app/plugins/perimeter/events` con
   `X-Plugin-Ingest-Token`, como el runtime de visión) con `room` y `ts` (epoch s), para
   que llegue a callbacks/MQTT/Streamflow como LPR y PPE.
2. Reemplazar `copy_clip` por el clip del core: o bien dejar que el operador use
   `trigger.event(perimeter.intrusion) → action.clip`, o bien que el worker llame
   `POST /apps/:app/streams/:id/clips {eventTs, before: clipSeconds, after: 0}` y guarde
   el `clipId` en su alerta (`alerts_db`) en lugar de la ruta local.
3. Mantener `clipSeconds` como `before` del clip (y quitar el ffmpeg del worker); el
   panel de alertas enlaza el VOD/`url` vía `GET /apps/:app/clips/{clipId}`.
4. Eso destraba el clip en workers remotos/edge (hoy se saltea si el HLS no es local) y
   lo deja en el S3 de la app con retención/listado de VODs.

## Prueba manual con media (srv03)

Los tests no corren LiveKit/egress/ffmpeg (todo con fakes). Pendiente en srv03:

1. App con `features.dvr {enabled: true, window_minutes: 60}` + un stream RTMP/RTSP
   activo: `POST …/hls/start` → `playlistUrl` termina en `dvr.m3u8`; tras unos minutos
   `curl …/dvr.m3u8` muestra `MEDIA-SEQUENCE` creciente y PDT por segmento.
2. `/play/<app>/<room>` y `/embed/<app>/<room>`: barra DVR, rebobinar 30 min, Ir al vivo,
   `?t=-10m` y `?t=<epoch de hace 20 min>` caen en el momento correcto (± un segmento).
3. Con direct-serve activo, `dvr.m3u8` se sirve desde nginx/Caddy igual.
4. Tras 60+ min, `ls hls/<room>/*.ts | wc -l` se estabiliza (~900 + margen) y la ventana
   no se rompe al podar.
5. `features.clips.enabled: true` + bucket: `POST …/clips {eventTs: <hace 30 s>}` →
   `GET /apps/:app/clips/{id}` pasa a `ready`, el MP4 de ~20 s está en S3 bajo `clips/`,
   aparece en `GET …/vods?source=clip`, llega `clip.ready` al webhook.
6. Workflow `trigger.event(plate.detected) → action.clip {wait: true} → action.notify`
   con el worker LPR: una patente genera el clip y la notificación con `{{clip.url}}`.
