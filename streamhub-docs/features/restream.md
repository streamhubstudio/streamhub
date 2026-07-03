# Restream (reenvío multi-destino a RTMP externos)

## Qué hace

Reenvía un **stream en vivo a N destinos RTMP externos simultáneos** — YouTube,
Twitch, Facebook o cualquier URL `rtmp(s)://` — lo que AntMedia llama
**"endpoints" / RTMP forwarding**. Cada destino corre en su **propio egress**
RoomComposite de LiveKit con un `StreamOutput` (protocol RTMP), de modo que:

- se pueden agregar/quitar destinos en caliente sin tocar los demás;
- un destino que **falla nunca tumba a los otros** (aislamiento por endpoint);
- detener uno es un simple `stopEgress` de su egress dedicado.

El estado por endpoint (`starting` / `active` / `failed` / `stopped`) vive en la
tabla per-app `restream_targets` (app.db) y lo avanzan los webhooks de egress de
LiveKit. Un endpoint `failed` se reintenta con backoff exponencial (5s/10s/20s,
máx. **3 reintentos** — espejo del `endpointRepublishLimit=3` de AntMedia),
best-effort y sin bloquear a los demás.

Agregar un destino está sujeto a la cuota `max_egress_gb_month` del tenant.

## Seguridad de la stream key destino

- La key se pega una sola vez (o viaja dentro de la URL custom). La **URL
  completa se guarda sólo server-side** (necesaria para relanzar en retry), al
  mismo nivel de confianza que `ingress_auth.stream_key`.
- **La API nunca la devuelve**: las respuestas y los callbacks sólo llevan
  `urlMasked` (últimos segmentos redactados, ej.
  `rtmp://a.rtmp.youtube.com/live2/abcd…`).

## Endpoints (bajo `/apps/:app/streams/:id`)

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| POST | `/restream` | broadcast:start | Agregar un destino (arranca su egress RTMP) |
| GET | `/restream` | broadcast:read | Listar destinos + estado por endpoint |
| DELETE | `/restream/:egressId` | broadcast:stop | Detener UN destino (los demás siguen) |

RBAC + aislamiento tenant/app vía el PermissionGuard global (`AUTHZ=on`); las
filas viven en el app.db de cada app, así que otra app/tenant no puede verlas.

### POST /apps/:app/streams/:id/restream — body

```json
{
  "platform": "youtube",
  "key": "abcd-efgh-ijkl-mnop",
  "name": "Mi canal principal"
}
```

- `platform`: `youtube` | `twitch` | `facebook` | `custom` (default `custom`).
- Presets (arman la URL = base conocida + `key`):
  - youtube → `rtmp://a.rtmp.youtube.com/live2/<key>`
  - twitch → `rtmp://live.twitch.tv/app/<key>`
  - facebook → `rtmps://live-api-s.facebook.com:443/rtmp/<key>`
- `custom`: `url` completa `rtmp(s)://...` (con la key incluida; `key` opcional
  se agrega como último segmento).
- `name` opcional (etiqueta), `layout` opcional (`grid`/`speaker`).
- Duplicado (misma URL viva en la misma sala) → **409**.

### Respuesta (key SIEMPRE enmascarada)

```json
{ "data": {
    "id": 1, "name": "Mi canal principal", "platform": "youtube",
    "room": "demo-room1", "streamId": "demo-room1/pub1",
    "urlMasked": "rtmp://a.rtmp.youtube.com/live2/abcd…",
    "egressId": "EG_xxx", "status": "starting",
    "error": null, "retries": 0,
    "startedAt": "2026-07-02 15:00:00", "endedAt": null } }
```

`GET .../restream` devuelve el array de destinos no detenidos con el mismo
shape (estado refrescado contra LiveKit best-effort; los webhooks son la fuente
de verdad).

## Callbacks (HMAC — ver [callbacks.md](callbacks.md))

- `restream_started` — destino agregado (egress lanzado).
- `restream_stopped` — detenido por el usuario (`reason: stopped_by_user`) o
  egress terminado (`completed` / `aborted`).
- `restream_failed` — el destino falló (`error`, `retries`, `willRetry`).

Los payloads llevan `url` **enmascarada** — nunca la key.

## UI

En **AppDetail → En vivo**, cada stream activo tiene el botón **Reenviar** que
abre el diálogo de Restream: elegir plataforma (o URL custom), pegar la stream
key, ver la lista de destinos con badge de estado
(`iniciando`/`activo`/`falló`) y detener cada uno individualmente.

## Ejemplos

```bash
# Agregar YouTube + Twitch al mismo stream (simulcast)
curl -s -X POST "$BASE/apps/demo/streams/demo-room1%2Fpub1/restream" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"platform":"youtube","key":"abcd-efgh-ijkl-mnop","name":"YT"}'
curl -s -X POST "$BASE/apps/demo/streams/demo-room1%2Fpub1/restream" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"platform":"twitch","key":"live_123_abc"}'

# Destino propio (URL completa)
curl -s -X POST "$BASE/apps/demo/streams/demo-room1%2Fpub1/restream" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"platform":"custom","url":"rtmp://ingest.example.com/live/mykey"}'

# Estado por endpoint
curl -s "$BASE/apps/demo/streams/demo-room1%2Fpub1/restream" \
  -H "Authorization: Bearer $TOKEN"

# Detener sólo el destino EG_xxx
curl -s -X DELETE "$BASE/apps/demo/streams/demo-room1%2Fpub1/restream/EG_xxx" \
  -H "Authorization: Bearer $TOKEN"
```

## Relación con broadcast.md

[broadcast.md](broadcast.md) es el flujo "webcam → 1 RTMP externo" (la página
Transmitir arranca un único egress por llamada). Restream generaliza el mismo
mecanismo (StreamOutput RTMP de LiveKit) a **N destinos gestionados por
stream**, con persistencia, estado por endpoint, retry y callbacks — el gap B2
de la [matriz AntMedia](ANTMEDIA-APP-SETTINGS-MATRIX.md) (§8).

## Implementación

- Core: `streamhub-core/src/modules/restream/` (controller + service +
  repository + presets puros). Egress vía `LiveKitService.startStreamEgress`
  (RoomComposite + `StreamOutput{protocol: RTMP, urls:[...]}` —
  livekit-server-sdk ≥2.7, verificado con 2.15.x).
- Webhooks: `WebhooksController.onEgress` notifica a `RESTREAM_SERVICE`
  (además de recording) para avanzar el estado por endpoint.
- Tabla: `restream_targets` (APP_MIGRATIONS #7, app.db per-app).
- Tests: `restream.service.spec.ts` + `restream.presets.spec.ts` (core),
  `src/lib/restream.spec.ts` (web).
