# ESP32-CAM → StreamHub: ingest directo por WebSocket

**Estado:** **F1 y F2 IMPLEMENTADAS** (ingest WS + frame hub + MJPEG/frame.jpg +
viewer WS + provisioning REST + player MJPEG en `/play`//`/embed` + UI de keys en
el tab Ingress). F3 (bridge LiveKit) y F4 (hardening/escala) siguen como diseño.
Módulo: `streamhub-core/src/modules/ws-ingest/`. Endpoints: ver
[api/README.md §WS ingest](../api/README.md). Config: `features.ws_ingest` en
[config-reference.md](../config-reference.md).

**Desvíos del diseño aplicados en la implementación (F1/F2):**
- `GET /apps/:app/ws-ingest` devuelve las credenciales completas (no solo el
  prefijo) — paridad de producto con el listado de ingress RTMP, que ya expone
  `stream_key` revelable con el permiso `ingress:read`. El hash de keys sigue
  siendo la mejora no bloqueante de F4.
- Se agregó `GET /apps/:app/ws-ingest/live/:room` (público, gateado por
  `publicPlayback`): el dato `type === 'ws-mjpeg'` que el diseño leía de
  `GET /streams` no está disponible anónimamente, y el player público lo
  necesita para elegir el modo MJPEG.
- `features.ws_ingest.enabled` defaultea a **true** (la key `wsk_` sigue siendo
  el gate real); el resto de los límites usa los defaults del diseño
  (maxFps 15, maxFrameKb 256, idle 30 s, ping 15 s).
- La migración per-app #7 reconstruye la tabla `streams` para aceptar el tipo
  `ws-mjpeg` (el CHECK original solo admitía webrtc/rtmp/rtsp/whip).
**Objetivo:** que un ESP32-CAM (y cualquier device liviano) haga streaming **directo** al core
por `wss://`, **sin el relay ffmpeg RTSP→RTMP** que documenta hoy
[esp32cam.md](./esp32cam.md), y que los viewers lo vean **sin transcodificar** (fan-out de
frames JPEG). El bridge a LiveKit (HLS/grabación/CDN) queda como fase 2 **opt-in**.

**Caso real que dimensiona todo:** 615 cámaras CCTV.

```
HOY  (relay):   ESP32 ──MJPEG/RTSP──► ffmpeg (PC/RPi por cámara) ──RTMP──► LiveKit ──► HLS (3–10 s)
V1   (diseño):  ESP32 ──wss:// 1 frame JPEG por mensaje──► core (frame hub) ──► MJPEG HTTP / WS viewers (<0.5 s)
V2   (opt-in):  frame hub ──ffmpeg interno jpeg→h264──► LiveKit ingress ──► WebRTC/HLS/grabación/cluster
```

---

## 1. Capacidades reales del ESP32-CAM (honesto)

Hardware de referencia: **AI-Thinker ESP32-CAM** — ESP32 clásico (dual-core 240 MHz,
520 KB SRAM + 4 MB PSRAM), sensor **OV2640** conectado por DVP, WiFi 2.4 GHz. La lib
oficial es [`esp32-camera`](https://github.com/espressif/esp32-camera) (la usa el ejemplo
CameraWebServer de Arduino).

### Qué SÍ puede emitir

- **JPEG por hardware**: el OV2640 comprime JPEG **en el sensor** (`PIXFORMAT_JPEG`). El
  ESP32 no comprime nada — solo mueve el buffer. Por eso MJPEG (una sucesión de JPEGs) es
  gratis en CPU.
- **Frame rates/resoluciones realistas** (sensor + bus DVP + WiFi, medido por la comunidad,
  ver fuentes §11): el sensor declara ~60 fps VGA / ~30 fps SVGA / ~15 fps UXGA, pero con
  el bus del ESP32 clásico y el envío por WiFi+TLS lo sostenible es:

  | Resolución | fps sostenidos por WiFi | Tamaño JPEG típico (quality 10–14) |
  |---|---|---|
  | QVGA 320×240 | 20–25 | 5–12 KB |
  | VGA 640×480 | **10–20 (target sano: 10–15)** | 15–40 KB |
  | SVGA 800×600 | 8–12 | 30–60 KB |
  | UXGA 1600×1200 | 2–5 | 80–200 KB |

  Para CCTV el perfil recomendado es **VGA @ 10–15 fps, quality 12** (~2–3 Mbps) o
  **QVGA @ 5–10 fps** (~0.4–0.8 Mbps) si son cientos de cámaras (ver §7).

### Qué NO puede (y por qué WebRTC no es el camino acá)

- **No tiene encoder H.264** (ni por hardware ni viable por software: x264-class a 240 MHz
  da ~1 fps QVGA). Todo lo que exige H.264 — RTMP/FLV estándar, WebRTC video hacia
  browsers (H.264/VP8 por RFC 7742), HLS — **requiere un transcode en alguna parte**.
- **WebRTC**: hay que ser preciso, no absolutista. Espressif publicó
  [`esp-webrtc-solution` / `esp_peer`](https://github.com/espressif/esp-webrtc-solution)
  (2025): ICE + DTLS-SRTP + datachannel corren incluso en ESP32 clásico. **Pero** el track
  de video WebRTC que un browser acepta es H.264/VP8, que el ESP32 clásico no puede
  producir; el soporte "MJPEG" de esp_peer solo sirve ESP↔ESP o receptores custom, no
  `/play` en un browser. Además el stack completo (DTLS + SRTP + ICE + buffers) consume
  RAM/CPU que en el AI-Thinker compite con la cámara. **En ESP32-P4 (H.264 por hardware) o
  ESP32-S3 (esp_h264 por software a baja resolución) WebRTC directo sí se vuelve viable** —
  es hardware distinto, camino futuro, no la flota AI-Thinker de hoy.
- **RTMP directo**: librerías RTMP para ESP32 existen pero inmaduras, y sin H.264 el FLV
  resultante no lo acepta ningún ingress serio (LiveKit incluido). Ya está documentado en
  [esp32cam.md §5](./esp32cam.md).

### Por qué WS + JPEG sí es viable

- El firmware solo hace: `esp_camera_fb_get()` → `webSocket.sendBIN(fb->buf, fb->len)`.
  Cero encode, cero framing complejo, un socket TCP+TLS (mbedTLS ya está en el SoC, la usa
  cualquier HTTPS). RAM extra sobre el sketch de cámara: ~40–60 KB (buffers TLS).
- Es un patrón probado por la comunidad (múltiples proyectos ESP32-CAM→WS→backend, §11).
- WSS pasa por el **mismo dominio/443** que ya proxya el deploy (ver §2) — sin abrir
  puertos, sin NAT issues (el device sale, nunca escucha).

**Conclusión honesta:** para AI-Thinker ESP32-CAM, WebRTC directo NO (falta H.264; el
stack DTLS-SRTP/ICE es carga sin beneficio si el video igual no lo acepta un browser);
**WS + MJPEG directo SÍ**, y elimina el relay por-cámara. El transcode solo reaparece si
querés HLS/grabación LiveKit — y ahí es un proceso interno opt-in (§6), no una PC por cámara.

---

## 2. Encaje en la infraestructura actual (verificado en el repo)

- **Proxy: CERO cambios.** Caddy (`deploy/Caddyfile`) proxya todo lo que no es `/rtc` al
  core `127.0.0.1:3020` con upgrade WebSocket automático; nginx
  (`deploy/nginx-streamhub.conf`) ya setea `Upgrade/Connection "upgrade"` en `location /`.
  O sea `wss://<STREAMHUB_DOMAIN>/ingest/ws` y `wss://.../live/ws` llegan al core hoy
  mismo. TLS lo termina el proxy; el core ve `ws://` plano por loopback.
- **Stream keys:** se reusa `ingress_auth` (tabla per-app en `apps/<app>/app.db`,
  servicio `streamhub-core/src/modules/livekit/ingress-auth.service.ts`). Se mintean keys
  propias `wsk_…` con `ingress_id = 'wsi_<rand>'` — mismo store, mismo ciclo de vida.
- **Registro de stream:** se reusa `StreamsService.upsert()/end()`
  (`src/modules/streams/streams.service.ts`) con el stream_id canónico
  `${room}/${identity}` — la cámara aparece en `GET /apps/:app/streams` y en el dashboard
  como cualquier stream. ⚠️ `reconcile()` poda streams que no existen en LiveKit: los de
  tipo `ws-mjpeg` deben **eximirse del prune** (su liveness la gobierna el gateway WS).
- **Callbacks/metrics/quotas:** se reusan `CallbacksService.dispatch('stream_started'|'stream_ended')`,
  `MetricsService`, y `QuotasService.enforceConcurrentStreams()` en el connect.
- **Rooms:** mismo namespacing `<roomPrefix>-<room>` (app `live` + `room=cam1` → `live-cam1`).
- **`STREAMHUB_DOMAIN` / `PUBLIC_BASE_URL`:** las URLs `wsUrl`/`mjpegUrl` que devuelve la
  API de provisioning se derivan de ahí, igual que `playerUrls()` hoy. `RTMP_PUBLIC_HOST`
  no interviene (no hay RTMP en v1).

---

## 3. Protocolo de ingest WS (spec v1)

### 3.1 Endpoint y handshake

```
wss://<STREAMHUB_DOMAIN>/ingest/ws
```

Autenticación en el handshake HTTP (antes del upgrade), dos formas equivalentes:

1. **Header (preferida — no queda en logs de acceso):**
   `Authorization: Bearer wsk_<key>` + query `?app=<app>&room=<room>[&identity=<id>]`
   (el firmware la usa vía `setExtraHeaders`, §9).
2. **Query (fallback para browsers/tests, que no pueden setear headers WS):**
   `?app=<app>&room=<room>&key=wsk_<key>[&identity=<id>]`

Validación server-side: la app existe → `appDb(app).ingress_auth WHERE stream_key = ?` →
la key existe y (si tiene `room` asociado) coincide → quota OK. Falla → close inmediato
con código (§3.5). `identity` default: `wscam-<sufijo de la key>`.

Si la misma key ya tiene una conexión activa, **gana la nueva** (la vieja se cierra con
4409): las cámaras flaky re-conectan sin quedar bloqueadas por su propio socket zombie.

### 3.2 Mensajes

| Dirección | Tipo WS | Contenido |
|---|---|---|
| server → device | text | `{"type":"ready","room":"live-cam1","streamId":"live-cam1/wscam-abc1","maxFps":15,"maxFrameBytes":262144,"idleTimeoutSec":30}` |
| device → server | **binary** | **1 mensaje = 1 frame JPEG completo** (bytes JFIF crudos, `FF D8 … FF D9`). Sin header propio: el timestamp lo pone el server al recibir (para CCTV alcanza; un header `{ts}` de 8 bytes queda especificado como extensión v1.1 si hiciera falta sync). |
| device → server | text (opcional) | `{"type":"stats","fps":12,"rssi":-61,"heapFree":41232}` cada ~30 s → se guarda en `streams.last_stats_json` (aparece en el dashboard). |
| server → device | text | `{"type":"error","code":"...","message":"..."}` antes de un close anómalo. |

El device **espera el `ready`** antes de mandar frames (el server igual tolera frames
tempranos post-upgrade: los descarta sin cerrar).

### 3.3 Keepalive

- Server manda **ping WS (protocolo)** cada 15 s; 2 pongs perdidos → conexión muerta.
- Device: `enableHeartbeat(15000, 3000, 2)` de arduinoWebSockets (responde y verifica).
- **Idle:** sin frames durante `idleTimeoutSec` (30 s) → close 4408 + `streams.end()`.

### 3.4 Límites y backpressure

- **maxFrameBytes** (default 256 KB, por app): frame más grande → close 4413 (es un device
  mal configurado, no un pico).
- **maxFps** (default 15, por app): token-bucket server-side; el exceso se **dropea en
  silencio** (contado en stats) — nunca se desconecta por fps.
- **Ingest:** el server guarda **solo el último frame** por cámara (buffer de profundidad
  1). Nada se encola del lado ingest: memoria acotada por diseño.
- **Fan-out:** cada viewer tiene su propia política de drop (§5). Un viewer lento **jamás**
  frena a la cámara ni a otros viewers.
- **perMessageDeflate: OFF** obligatorio (JPEG no comprime; deflate solo quemaría CPU) y
  `skipUTF8Validation` para mensajes binarios.

### 3.5 Ciclo de vida y códigos de cierre

```
CONNECT ─auth ok→ ready → streams.upsert(type:'ws-mjpeg') + callback stream_started + metric
        ─auth fail→ close 4401 (sin upsert)
FRAMES  → frame hub (último frame + fan-out)
CLOSE / idle / error → streams.end() + callback stream_ended + metric
BOOT del core → marcar 'ended' todo stream ws-mjpeg que quedó 'active' (no hay socket que lo respalde)
```

| Código | Significado |
|---|---|
| 1000 | cierre normal (device apaga) |
| 4401 | key inválida / app inexistente / room no coincide |
| 4403 | app sin `wsIngest` habilitado o quota excedida |
| 4408 | idle timeout (sin frames) |
| 4409 | reemplazado por una conexión nueva con la misma key |
| 4413 | frame > maxFrameBytes |
| 4429 | rate-limit de handshakes (IP) |

### 3.6 Provisioning (REST, reusa auth/quota/RBAC existentes)

```
POST   /api/v1/apps/:app/ws-ingest        {"room":"cam1","identity":"porton-norte"?}
  → { "id":"wsi_ab12", "streamKey":"wsk_…", "room":"live-cam1",
      "wsUrl":"wss://streamhub.example.com/ingest/ws",
      "mjpegUrl":"https://streamhub.example.com/live/live/cam1/mjpeg",
      "playerUrl":"https://…/play/live/cam1" }
GET    /api/v1/apps/:app/ws-ingest        # listar keys (sin plaintext: prefijo + estado)
DELETE /api/v1/apps/:app/ws-ingest/:id    # revocar (cierra la conexión activa si la hay)
```

Permiso `ingress:create` (mismo que el ingress RTMP), quota
`enforceConcurrentStreams` al mint y al connect. Nota: hoy `ingress_auth` guarda
`stream_key` en claro (las de LiveKit ya son así); para las `wsk_` conviene guardar
`sha256(key)` + prefijo de lookup — mejora marcada en el plan, no bloqueante.

---

## 4. Fan-out a viewers SIN relay (v1)

El core mantiene un **frame hub** en memoria: `Map<app/room, { lastFrame, lastTs, viewers }>`.
Cero disco, cero transcode, cero procesos.

### (a) MJPEG multipart HTTP — el modo CCTV

```
GET https://<dominio>/live/<app>/<room>/mjpeg          (+ ?token=<playToken> si publicPlayback está off)
Content-Type: multipart/x-mixed-replace; boundary=frame
```

- Funciona en un `<img src="…/mjpeg">` pelado, en VLC, en cualquier NVR viewer. Cero
  dependencias JS. Ideal para muros de cámaras.
- Al conectar, el viewer recibe **inmediatamente** el último frame conocido (imagen
  instantánea, sin esperar el próximo capture).
- Backpressure por viewer: si `res.write()` devuelve `false`, se saltean frames hasta el
  `drain`. Nunca se bufferea más de 1 frame por viewer.
- Bonus gratis: `GET /live/<app>/<room>/frame.jpg` devuelve el último frame → thumbnails
  del dashboard y "snapshot" sin ffmpeg (hoy `snapshot()` levanta un ffmpeg por captura).

### (b) WS de salida — el modo player/dashboard

```
wss://<dominio>/live/ws?app=<app>&room=<room>[&token=<playToken>]
```

Server → viewer: binarios = frames JPEG (mismo framing que el ingest); text =
`{"type":"info","fps":…,"ts":…}`. Drop por viewer cuando `socket.bufferedAmount > 512 KB`.
En el browser: pintar cada frame en `<img>` vía `URL.createObjectURL(new Blob([data]))`
(revocando el anterior) o `canvas` — ~15 líneas de JS.

### Auth de playback

Misma semántica que `/play` de hoy: si `features.publicPlayback` está **on** (default), los
endpoints `/live/...` son públicos por room; si está **off**, exigen el **play-token**
existente (`GET /api/v1/apps/:app/play-token/:room`) como query `?token=`.

### Integración con /play y /embed

`PlayPublic.tsx` / `Embed.tsx` ya resuelven room + token público. Se agrega: si el stream
activo del room es `type === 'ws-mjpeg'` (dato que ya viaja en `GET /streams`), el player
renderiza el modo **mjpeg** (componente `MjpegPlayer`: `<img>` sobre (a), upgrade a (b) si
hay WS) en vez del `LivePlayer` LiveKit. Sin cambio de URLs públicas: el mismo
`/play/<app>/<room>` muestra la cámara.

### Latencia esperada (honesta)

| Tramo | ms |
|---|---|
| Captura + JPEG en sensor | 30–70 |
| WiFi + TCP/TLS device→server | 5–20 (LAN) / +RTT (WAN, típ. 20–80) |
| Frame hub → viewer | < 5 |
| Render browser | 16–33 |
| **Total** | **~100–250 ms LAN, ~150–400 ms WAN** |

vs. cadena actual relay→RTMP→LiveKit→HLS: 3–10 s. Es el mayor salto de calidad del feature.

**Qué NO da v1 (honesto):** audio (el ESP32-CAM no tiene mic), grabación MP4/HLS,
distribución CDN, adaptive bitrate. Para eso está la v2 (§6) — o la **grabación barata
v1.5**: muxear los JPEG a MKV/AVI `codec mjpeg copy` (ffmpeg sin transcode, CPU ~0) si solo
se necesita retención CCTV.

---

## 5. Frame hub — semántica exacta (para el implementador)

```
publish(app, room, frame):
  slot = hub.get(key) ?? hub.create(key)
  slot.lastFrame = frame            # referencia, no copia; el Buffer de ws ya es nuestro
  slot.lastTs = now()
  for v of slot.viewers:
    if v.kind == 'ws'   and v.socket.bufferedAmount > 512*1024: v.dropped++; continue
    if v.kind == 'http' and v.awaitingDrain:                    v.dropped++; continue
    v.send(frame)

subscribe(app, room, viewer):  manda lastFrame si existe; agrega a viewers
unsubscribe / disconnect:       remueve; si viewers==0 y publisher==null → borra slot
```

- Lógica pura en `frame-hub.ts` (sin `ws`, sin express) → testeable con jest sin red,
  cumpliendo la regla del repo de specs sin infraestructura.
- Métricas Prometheus: `ws_ingest_cameras{app}`, `ws_ingest_frames_total`,
  `ws_ingest_dropped_frames_total{reason}`, `ws_ingest_viewers{app,kind}`,
  `ws_ingest_bytes_total`.

---

## 6. Fase 2 (opt-in): bridge a LiveKit para HLS/grabación/cluster/CDN

Cuando UNA cámara necesita lo que da LiveKit (grabación egress, HLS masivo, WebRTC
subscribers, cluster/CDN), el core levanta **un ffmpeg interno por cámara puenteada** —
no un relay externo por cámara como hoy:

```
frame hub ──pipe stdin (image2pipe/mjpeg)──► ffmpeg -c:v libx264 -preset ultrafast -tune zerolatency
        ──flv──► rtmp://127.0.0.1:1935/<app>/<key>  (LiveKit ingress creado programáticamente)
```

- `POST /apps/:app/streams/:id/bridge/start|stop` (o `features.wsIngest.autoBridge: true`).
- Al entrar por el ingress RTMP local, **todo lo existente aplica sin tocar nada**:
  webhooks, HLS egress, grabación a S3, adaptive player, cluster.
- **Costo honesto:** x264 ultrafast VGA@10–15fps ≈ 5–15 % de un core moderno **por cámara**.
  615 cámaras NO se puentean todas (serían 30–90 cores): el bridge es selectivo (la cámara
  que estás grabando/publicando), o con NVENC si hay GPU (el módulo `system/gpu` ya detecta).
  La dedupe stream se resuelve marcando el stream ws-mjpeg como `bridged` para que el
  ingress derivado no aparezca duplicado en la lista.
- Gestión del proceso: mismo patrón de lifecycle que ya usa el framework de plugins con
  workers (`needsWorker`) / `transcoding` — spawn, watchdog, restart, logs.

**v1 no depende de nada de esto.** Es una fase separada y opcional.

---

## 7. Seguridad y escala (615 cámaras: números)

### Seguridad

- **Auth:** stream key por cámara (revocable individualmente), tenant/app-scoped (per-app
  `app.db`), quota `max_concurrent_streams` existente + nuevo límite
  `features.wsIngest.maxCameras` por app (config.yaml, patrón `features:` existente).
  AUTHZ=on ya cubre el provisioning (permiso `ingress:create`).
- **Rate-limit** de handshakes por IP reusando `shared/http/auth-rate-limit`.
- **Validación de frames:** magic bytes `FF D8` al inicio (basura → drop; reincidencia → close).
- **TLS:** siempre wss en el borde (Caddy/nginx). En el firmware, CA pinning opcional (§9).
- **Playback:** gate `publicPlayback` + play-token, igual que `/play` (§4).

### Escala — ancho de banda (el límite real)

| Perfil | Mbps/cámara | 615 cámaras |
|---|---|---|
| VGA 15 fps q12 (~25 KB/frame) | ~3.0 | **~1.85 Gbps** ⚠️ satura 1 GbE |
| VGA 10 fps | ~2.0 | ~1.2 Gbps ⚠️ |
| QVGA 8 fps (~8 KB/frame) | ~0.5 | **~315 Mbps** ✅ |
| VGA 5 fps (modo vigilancia) | ~1.0 | ~615 Mbps ✅ justo |

⇒ Con 615 cámaras el cuello es la **red, no el software**: o perfil CCTV (QVGA/VGA a
5–8 fps), o NIC 10 GbE, o sharding. El egress de viewers se suma encima (frames × viewers);
para muros de monitoreo usar `frame.jpg` con refresh de 1–2 s en los thumbnails y MJPEG
full solo en la cámara enfocada.

### Escala — core

- **RAM/conexión:** socket `ws` (~30–70 KB, TLS lo paga el proxy) + último frame (8–40 KB)
  ≈ **~100–150 KB/cámara** → 615 cámaras ≈ **60–90 MB**. Trivial.
- **CPU/event loop:** sin transcode ni parse, cada mensaje es un pase de Buffer.
  615 × 10 fps = **~6.150 msgs/s** — manejable en Node si los handlers no alocan
  (deflate off, cero JSON en el hot path), pero hay que **medirlo** (bench en fase 4).
- **Gateway aparte (futuro):** el diseño deja la costura lista — `WsIngestService` habla
  con el resto solo vía contratos (`STREAMS_SERVICE`, `CALLBACKS_SERVICE`, lookup de keys).
  Si un core no alcanza, el mismo protocolo se mueve a un proceso `ws-ingest-gateway`
  (N réplicas detrás del proxy) que autentica contra el core (endpoint interno) y publica
  frames vía redis pub/sub o directo a viewers del mismo gateway. **No se construye ahora**;
  solo se prohíbe acoplar el hub a internals del core para no bloquear esa salida.
- **SQLite:** 1 write al connect + 1 al close por cámara — nada de writes por frame.

---

## 8. Cambios en el core (mapa para el implementador)

### Módulo nuevo `streamhub-core/src/modules/ws-ingest/` (no toca módulos ajenos)

| Archivo | Rol |
|---|---|
| `ws-ingest.module.ts` | wiring NestJS |
| `ws-ingest.gateway.ts` | `ws.Server({ noServer: true })` × 2 (ingest + live) colgado del server HTTP vía `HttpAdapterHost` en `onApplicationBootstrap` (evento `upgrade`, filtrando `/ingest/ws` y `/live/ws`) — **sin tocar main.ts para el WS** |
| `ws-ingest.service.ts` | handshake/auth (lookup key en `appDb`), registro (`streams.upsert/end` + callbacks + metrics + quotas), límites |
| `frame-hub.ts` | fan-out puro (§5), sin I/O — unit-testeable |
| `ws-keys.controller.ts` | REST de provisioning (§3.6) |
| `live-http.controller.ts` + mount | `GET /live/:app/:room/mjpeg` y `/frame.jpg` |
| `dto/`, `*.spec.ts` | contratos + tests |

### Toques mínimos FUERA del módulo (coordinar — archivos scaffolder-owned o de otros módulos)

1. `shared/contracts/types.ts`: `StreamType` += `'ws-mjpeg'` (1 línea).
2. `modules/streams/streams.service.ts` `reconcile()`: eximir `type='ws-mjpeg'` del prune
   (~3 líneas) + el CASE de no-downgrade en `upsert` ya cubre ingress; agregar ws-mjpeg.
3. `main.ts`: 2 líneas `mountLiveHttp(app, …)` (mismo patrón que `mountHlsStatic`) porque
   `/live/*` vive fuera del prefix `/api/v1`. (El upgrade WS no necesita main.ts.)
4. `package.json`: deps `ws` + `@types/ws` (primer uso de WS server en el core — hoy no hay).
5. `config-reference.md` / apps config: bloque `features.wsIngest { enabled, maxCameras, maxFps, maxFrameKb }`.
6. Proxy/ENV: **cero cambios** (verificado §2).

### Qué reusa vs. qué es nuevo

| Reusa (no reinventar) | Nuevo (no existe nada parecido) |
|---|---|
| `ingress_auth` store + servicio (keys) | frame hub + fan-out |
| `StreamsService.upsert/end` + stream_id canónico | servidor WS (`ws` dep nueva) |
| `CallbacksService` (stream_started/ended) | endpoint MJPEG multipart + frame.jpg |
| `QuotasService.enforceConcurrentStreams` | viewer WS + `MjpegPlayer` web |
| `auth-rate-limit`, play-token, `features:` gating | firmware `.ino` |
| `MetricsService` (counters nuevos, plumbing existente) | protocolo `ready/stats/close codes` |

---

## 9. Firmware de ejemplo

Sketch completo y comentado: **[`esp32cam_ws_ingest.ino`](./esp32cam_ws_ingest.ino)**
(AI-Thinker, Arduino core ESP32, lib [Links2004/arduinoWebSockets](https://github.com/Links2004/arduinoWebSockets)).
Resumen de lo que hace:

1. Inicializa `esp32-camera` (VGA, `PIXFORMAT_JPEG`, quality 12, `fb_count 2`,
   `CAMERA_GRAB_LATEST` — siempre el frame más fresco, nunca backlog).
2. `webSocket.beginSSL(host, 443, "/ingest/ws?app=live&room=cam1")` +
   `setExtraHeaders("Authorization: Bearer wsk_…")` + `enableHeartbeat(15000,3000,2)` +
   `setReconnectInterval(3000)` (reconexión automática de por vida).
3. Espera el `{"type":"ready"…}` y recién ahí entra al loop de captura: throttle a
   `TARGET_FPS`, `esp_camera_fb_get()` → `sendBIN(fb->buf, fb->len)` → `fb_return`.
4. Manda `{"type":"stats"…}` cada 30 s (heap/rssi/fps) — visible en el dashboard.
5. Producción: reemplazar el TLS sin verificación por `beginSslWithCA(...)` con el CA root
   del dominio (comentado en el sketch).

---

## 10. Plan de implementación por fases (para el agente que implemente)

| Fase | Alcance | Estado | Criterio de done |
|---|---|---|---|
| **F1 — Ingest + fan-out (el feature)** | Módulo `ws-ingest` completo: gateway WS ingest, frame hub, MJPEG HTTP + frame.jpg, viewer WS, provisioning REST, registro en streams + callbacks + quotas + metrics, toques 1–5 de §8. Tests: `frame-hub.spec` (drop/backpressure), `ws-ingest.service.spec` (auth/lifecycle con sockets fake), `ws-keys.controller.spec`, `live-http.spec` (multipart/backpressure con fakes). `UNIT-TESTS.md` actualizado. | ✅ **IMPLEMENTADA** | Un ESP32 (o `websocat` mandando JPEGs) aparece en `GET /streams`, se ve en `<img …/mjpeg>`, desconecta → `stream_ended`. |
| **F2 — Web** | `MjpegPlayer` (img sobre `/live/...`, retry automático), detección vía live-info público en `PlayPublic`/`Embed` (misma URL), modal Ver de `StreamsTab` en modo MJPEG, tipo de ingest "WebSocket (ESP32/MJPEG)" en `IngressTab` con card de cámaras (estado en vivo + thumbnail `frame.jpg` + credenciales copiables + revocar). i18n EN/ES. | ✅ **IMPLEMENTADA** | `/play/<app>/<room>` muestra la cámara sub-segundo; dashboard lista cámaras con preview. |
| **F3 — Bridge LiveKit (opt-in)** | ffmpeg interno jpeg→h264→RTMP ingress local, `bridge/start|stop`, autoBridge por config, dedupe de stream, lifecycle con watchdog. | ⏳ diseño (§6) | Cámara puenteada graba a S3 y sale por HLS sin relay externo. |
| **F4 — Hardening/escala** | Bench de N cámaras sintéticas (script), métricas/alertas, doc de perfiles CCTV, decisión medida sobre gateway aparte, hash de keys `wsk_`, header `{ts}` v1.1 si hace falta. | ⏳ diseño (§7) | Números reales publicados en `operations/OBSERVABILITY.md`; go/no-go gateway. |

### Probar sin hardware (simular una cámara)

```bash
# 1) Mintear una key (Bearer = token API del panel):
curl -s -X POST https://<dominio>/api/v1/apps/live/ws-ingest \
  -H "Authorization: Bearer $STREAMHUB_TOKEN" -H 'Content-Type: application/json' \
  -d '{"room":"cam1"}'
# → { data: { streamKey: "wsk_…", wsUrl: "wss://<dominio>/ingest/ws?app=live&room=cam1", … } }

# 2) Mandar un JPEG por segundo como frames binarios (websocat):
while true; do cat frame.jpg; sleep 1; done | \
  websocat --binary -H "Authorization: Bearer wsk_XXXX" \
  "wss://<dominio>/ingest/ws?app=live&room=cam1"

# 3) Verla:
#    GET  https://<dominio>/live/live/cam1/frame.jpg      (último frame)
#    <img src="https://<dominio>/live/live/cam1/mjpeg">    (stream MJPEG)
#    https://<dominio>/play/live/live-cam1                 (player público, modo MJPEG)
```

Orden estricto F1→F2; F3/F4 independientes entre sí. Reglas del repo que aplican: specs
sin red/infra, no editar `main.ts`/`shared/**` salvo los toques listados en §8 (coordinar),
actualizar `UNIT-TESTS.md` al agregar suites.

---

## 11. Fuentes (verificación §1)

- [Random Nerd Tutorials — ESP32-CAM OV2640 settings](https://randomnerdtutorials.com/esp32-cam-ov2640-camera-settings/) y [espboards.dev — ESP32 camera modules compared](https://www.espboards.dev/blog/esp32-camera-modules-compared/) — resoluciones/fps reales del OV2640 (≈60 fps VGA de sensor; 10–25 fps efectivos por WiFi), necesidad de PSRAM.
- [Espressif ESP-FAQ — Camera Application](https://docs.espressif.com/projects/esp-faq/en/latest/application-solution/camera-application.html) — límites del bus DVP/PCLK en ESP32 clásico.
- [espressif/esp-webrtc-solution](https://github.com/espressif/esp-webrtc-solution) / [esp_peer](https://components.espressif.com/components/espressif/esp_peer) y [getstream.io — WebRTC en ESP32](https://getstream.io/blog/stream-video-esp32/) — estado real de WebRTC embebido: viable con H.264 en S3/P4; el clásico no tiene encoder → video-a-browser no.
- [Espressif — ESP H.264 usage guide](https://developer.espressif.com/blog/2025/07/esp-h264-use-tips/) — encoder H.264 SW/HW solo S3/P4.
- Patrón ESP32-CAM→WS probado: [Neumi/esp32_camera_webstream](https://github.com/Neumi/esp32_camera_webstream), [cyator/N3-Camera](https://github.com/cyator/N3-Camera), [wms2537/esp32cam-websockets-stream](https://github.com/wms2537/esp32cam-websockets-stream), [iotsharing demo 48](http://www.iotsharing.com/2020/03/demo-48-using-websocket-for-camera-live.html).
- Repo: `deploy/Caddyfile`, `deploy/nginx-streamhub.conf` (proxy WS ya listo), `modules/livekit/ingress-auth.service.ts`, `modules/streams/streams.service.ts`, `modules/livekit/webhooks.controller.ts`, `modules/quotas/quotas.service.ts`, [esp32cam.md](./esp32cam.md) (camino relay actual que este diseño reemplaza).
