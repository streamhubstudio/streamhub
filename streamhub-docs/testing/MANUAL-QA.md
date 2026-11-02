# StreamHub — Guía de QA manual

Documento de referencia para validar **todo el producto a mano**. Está pensado
para un/a tester con **conocimientos básicos** (sabe usar el navegador, OBS,
la terminal y copiar/pegar comandos `curl`), no para un desarrollador.

Cada suite agrupa casos de prueba. Cada caso tiene el mismo formato:

- **Objetivo** — qué se valida.
- **Precondiciones** — qué tiene que estar listo antes.
- **Pasos** — la secuencia exacta.
- **Resultado esperado** — cómo saber si pasó.
- **Config usada** — valores concretos (para poder reproducir).

Al final hay una **matriz-resumen** (área × casos × prioridad) para reportar
resultados, y una lista de **inconsistencias código/docs** detectadas al armar
esta guía (útiles para no confundir un bug conocido con un fallo de la prueba).

> Los enlaces "Ref:" apuntan a la documentación de detalle. Esta guía no duplica
> esa profundidad: describe **cómo probar**, no cómo está implementado.

---

## Convenciones (leer una vez)

- **Dominio de ejemplo:** `your-server.example.com`. Reemplazalo por el dominio
  real de tu instancia. Nunca pongas IPs ni hostnames reales en un reporte que
  vayas a compartir.
- **App por defecto:** una instalación nueva siembra la app `live`. Los ejemplos
  usan `live` como app y `cam1` / `demo` como *room* (sala).
- **Base de la API:** `https://your-server.example.com/api/v1`. En los ejemplos
  se abrevia como `$BASE`. La salud está en `GET $BASE/health` y el Swagger
  interactivo en `https://your-server.example.com/api/v1/docs`.
- **Envelope de respuesta:** casi todos los endpoints devuelven
  `{ "data": <payload>, "error": null }`. Los errores usan el HTTP status
  correcto (401, 403, 404, 429, etc.).
- **Autenticación (dos planos):**
  - **Dashboard (navegador):** login JWT. Para entrar sin haber creado usuarios,
    usá las credenciales *break-glass* `ADMIN_USER` / `ADMIN_PASS` (del `.env`).
  - **API (curl):** token `sk_...` en el header `Authorization: Bearer sk_...`.
    En los ejemplos se usa la variable de entorno `STREAMHUB_TOKEN`.
- **Cómo exportar el token en tu terminal** (una sola vez por sesión):
  ```bash
  export BASE="https://your-server.example.com/api/v1"
  export STREAMHUB_TOKEN="sk_...."     # el token global sembrado (ver Suite 0)
  ```
- **Puertos que NO pasan por el dominio:** el media (RTMP 1935, WHIP 8080,
  WebRTC 7882/udp, passthrough 1937+) llega **directo a la IP del server**, no
  por Caddy/nginx. Sólo HTTPS/WSS (`/`, `/api/v1`, `/hls`, `/sdk`, `/live/*`,
  `/ingest/ws`, `/metrics`) pasan por el reverse proxy.
- **Prioridades:** **P1** = camino crítico (tiene que pasar para poder publicar
  el producto). **P2** = secundario / avanzado / requiere infra que un tester
  básico quizá no tenga.
- **Marcas de infraestructura:** `[REQUIERE GPU]`, `[REQUIERE 2ª MÁQUINA]`,
  `[REQUIERE S3]`, `[REQUIERE MQTT]`, `[REQUIERE HW]` señalan casos que necesitan
  algo extra; en cada uno se da la **alternativa mínima** para un tester con una
  sola máquina.

---

# Suite 0 — Entorno

**Objetivo de la suite:** dejar una instancia funcionando y verificar los puntos
de entrada (health, Swagger, login, token) que usarán todas las demás suites.

### Qué necesita el tester

| Herramienta | Para qué | Cómo obtenerla |
|---|---|---|
| Un servidor Linux (Ubuntu 24.04/26.04 x64) | correr StreamHub | VM/host propio, o `docker compose` local en Linux |
| Navegador (Chrome/Firefox; probar también Safari/iOS) | dashboard, players | ya lo tenés |
| **OBS Studio** 30+ | publicar por RTMP / WHIP | obsproject.com |
| **ffmpeg** | publicar/simular streams sin OBS | `apt install ffmpeg` |
| Cliente MQTT (`mosquitto_pub`/`mosquitto_sub` o **MQTTX**) | IoT/MQTT (Suites 6-7) | `apt install mosquitto-clients` |
| `websocat` | ws-ingest (ESP32/MJPEG, IoT) | `cargo install websocat` o binario |
| `curl` + `jq` | API a mano | `apt install curl jq` |
| (opcional) **MinIO** en Docker | probar grabación→S3 sin nube | imagen `quay.io/minio/minio` |

Ref: `INSTALL.md`, `streamhub-docs/operations/INSTALL-NODE.md`,
`streamhub-docs/operations/MANUAL-BUILD-INSTALL.md`.

### 0.1 — Instalar con el one-liner (origin/standalone)
- **Prioridad:** P1
- **Objetivo:** levantar una instancia completa desde cero.
- **Precondiciones:** servidor con Docker, un dominio con registro DNS A
  apuntando a la IP, puertos abiertos (80, 443, 7880/tcp, 7881/tcp, 7882/udp,
  1935/tcp, 3478/udp).
- **Pasos:**
  1. Ejecutar el instalador hospedado (modo standalone es el default):
     ```bash
     curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- \
       --standalone --domain your-server.example.com --email you@example.com
     ```
  2. Esperar a que termine. Al final imprime un resumen con la URL del
     dashboard, la de Swagger y el **API token** (`sk_...`).
- **Resultado esperado:** el instalador termina sin error y muestra
  `API + Swagger : https://your-server.example.com/api/v1/docs` y un token
  `sk_...`. Guardá ese token.
- **Config usada:** `--standalone`, `--domain your-server.example.com`,
  `--email you@example.com`. (`--admin-user`/`--admin-pass` se pueden pasar; si
  no, se generan y aparecen en el resumen / en el `.env`.)

### 0.2 — Alternativa: docker compose desde el repo [para tester local]
- **Prioridad:** P2
- **Objetivo:** levantar el stack sin el one-liner (build local).
- **Precondiciones:** repo clonado en un host Linux (LiveKit usa host networking,
  así que **no** funciona en macOS/Windows), `.env` creado desde `.env.example`.
- **Pasos:**
  1. `docker compose up -d --build`
  2. Sembrar el token global:
     ```bash
     grep '^STREAMHUB_API_TOKEN=' .env | cut -d= -f2 | docker compose exec -T core streamhub-core seed-token - bootstrap
     ```
- **Resultado esperado:** los servicios `redis`, `livekit`, `ingress`, `egress`,
  `core`, `caddy` quedan `Up`; el seed devuelve OK (es idempotente: si ya hay un
  token global, no hace nada).
- **Config usada:** `.env` por defecto.

### 0.3 — Verificar health y Swagger
- **Prioridad:** P1
- **Objetivo:** confirmar que el core responde.
- **Precondiciones:** 0.1 o 0.2 hechos.
- **Pasos:**
  1. `curl -s $BASE/health | jq` (o `curl http://127.0.0.1:3020/api/v1/health` en el host).
  2. Abrir `https://your-server.example.com/api/v1/docs` en el navegador.
- **Resultado esperado:** el health devuelve `200` con un JSON que incluye la
  versión y el estado; Swagger carga la lista de endpoints.
- **Config usada:** —

### 0.4 — Login al dashboard con break-glass admin
- **Prioridad:** P1
- **Objetivo:** entrar al panel como superadmin sin haber creado usuarios.
- **Precondiciones:** conocer `ADMIN_USER` / `ADMIN_PASS` (del `.env`).
- **Pasos:**
  1. Abrir `https://your-server.example.com/` → pantalla de login.
  2. Ingresar `ADMIN_USER` / `ADMIN_PASS`.
- **Resultado esperado:** entra al dashboard; `GET $BASE/auth/me` (con la sesión)
  muestra `isSuperadmin: true`. La cuenta admin está exenta de 2FA y no se puede
  bloquear.
- **Config usada:** credenciales break-glass del `.env`.
  Ref: `streamhub-docs/features/auth.md`.

### 0.5 — Probar el token `sk_` contra la API
- **Prioridad:** P1
- **Objetivo:** confirmar que el token global autentica.
- **Precondiciones:** token de 0.1/0.2 exportado en `$STREAMHUB_TOKEN`.
- **Pasos:**
  1. `curl -s $BASE/apps -H "Authorization: Bearer $STREAMHUB_TOKEN" | jq`
- **Resultado esperado:** `200` con la lista de apps (al menos `live`). Sin el
  header, o con un token inválido, devuelve `401`.
- **Config usada:** `Authorization: Bearer $STREAMHUB_TOKEN`.

---

# Suite 1 — Ingest (publicar un stream)

**Objetivo de la suite:** validar cada forma de meter video/datos al server.
Ref: `streamhub-docs/features/ingress.md`, `rtmp-single-port.md`,
`rtmp-passthrough.md`, `integrations/ESP32-WS-INGEST.md`.

> **Dónde se sacan las credenciales de ingest:** en el dashboard, abrí la app
> (`/apps/live`) → pestaña **Ingress** → **Create ingress**. Elegí el tipo de
> input, creá, y el ícono del **ojo** ("View ingest credentials") revela el
> Server y el Stream Key para OBS. `GET $BASE/apps/live/ingress` re-devuelve esas
> credenciales en cada fila.

### 1.1 — RTMP → LiveKit (transcodificado) con OBS
- **Prioridad:** P1
- **Objetivo:** publicar por RTMP a través de LiveKit (con WebRTC + HLS + record).
- **Precondiciones:** OBS instalado; una app (`live`).
- **Pasos:**
  1. Dashboard → app `live` → **Ingress** → **Create ingress** → Input type
     **RTMP (push)**, room `cam1`, dejar transcoding activado → crear.
  2. Click en el ojo de la fila → copiar **Server** y **Stream Key**.
  3. En OBS: Settings → Stream → Service **Custom**:
     - **Server:** `rtmp://your-server.example.com:1935/live`
     - **Stream Key:** el `stream_key` copiado (token opaco, no incluye app/room).
  4. **Start Streaming** en OBS.
- **Resultado esperado:** la fila del stream pasa a activa; en la pestaña
  **Streams** (o **En vivo**) aparece el stream y se puede ver por WebRTC/HLS.
  La URL completa que arma OBS es `rtmp://your-server.example.com:1935/live/<key>`.
- **Config usada:** input `rtmp`, room `cam1`, transcoding on. Puerto 1935/tcp
  directo a la IP.
- **Equivalente API:**
  ```bash
  curl -s -X POST $BASE/apps/live/ingress -H "Authorization: Bearer $STREAMHUB_TOKEN" \
    -H 'Content-Type: application/json' -d '{"inputType":"rtmp","room":"cam1","enableTranscoding":true}'
  ```

### 1.2 — RTMP con password de stream (opcional)
- **Prioridad:** P2
- **Objetivo:** validar la protección por password de un ingress RTMP.
- **Precondiciones:** feature `rtmpPassword` habilitada en la app (Config tab).
- **Pasos:**
  1. Crear el ingress RTMP: la respuesta ahora incluye `stream_password` y
     `requires_password: true`.
  2. Autorizar el push antes/durante:
     `POST $BASE/apps/live/ingress/:id/validate` body `{"password":"..."}`.
  3. Probar publicar **sin** autorizar.
- **Resultado esperado:** el push no autorizado se corta y dispara `stream_ended`
  con motivo `unauthorized_rtmp_password`; con el password validado, publica bien.
- **Config usada:** `features.rtmpPassword: true`.

### 1.3 — RTMP passthrough (remux → HLS, sin transcode)
- **Prioridad:** P1
- **Objetivo:** publicar por RTMP directo a HLS, sin LiveKit (menor latencia, sin
  WebRTC ni grabación).
- **Precondiciones:** passthrough habilitado en el server
  (`STREAMHUB_RTMP_PASSTHROUGH_ENABLE=on`; si está off, la creación da 503).
- **Pasos:**
  1. Dashboard → Ingress → Create ingress → tildar **Passthrough (remux, no
     transcode)**, room `cam1` → crear. Se emite una key `ptk_...`.
  2. En OBS (fijate que acá **la app va en el path**, no `/live`):
     - **Server:** `rtmp://your-server.example.com:1937/live`
     - **Stream Key:** `ptk_...`
     - URL efectiva: `rtmp://your-server.example.com:1937/live/ptk_...`
  3. Start Streaming.
- **Resultado esperado:** reproduce por HLS en `/hls/live/cam1/index.m3u8` o en
  `/play/live/cam1` (~2 segmentos de latencia). No hay grabación ni sala WebRTC.
- **Config usada:** input `rtmp`, `mode: passthrough`. Puerto base 1937/tcp
  (cada canal concurrente toma el siguiente libre: 1938, 1939…).
- **Nota single-port:** si `STREAMHUB_MEDIAMTX_ENABLE=true`, la key `ptk_` también
  entra por el `:1935` compartido: `rtmp://your-server.example.com:1935/live/ptk_...`.

### 1.4 — WHIP (WebRTC-HTTP ingest)
- **Prioridad:** P2
- **Objetivo:** publicar por WHIP (sub-segundo, sin transcode).
- **Precondiciones:** OBS 30+ (salida WHIP) o un navegador con `livekit-client`.
- **Pasos:**
  1. Crear ingress tipo **WHIP**, room `cam1`. La respuesta trae el **endpoint
     WHIP** en el campo `url` (puerto 8080, directo a la IP del server) y, si
     corresponde, un `streamKey` como Bearer token.
  2. En OBS: Settings → Stream → Service **WHIP** → WHIP URL = el `url` (`:8080`),
     Bearer Token = el `streamKey`.
  3. Start Streaming.
- **Resultado esperado:** el stream aparece en vivo y se ve por WebRTC.
- **Config usada:** input `whip`, room `cam1`. Puerto 8080/tcp directo a la IP.
- **Nota:** el handshake WHIP lo maneja LiveKit; la fuente de verdad es el campo
  `url` de la respuesta.

### 1.5 — RTSP pull (el server tira de una cámara)
- **Prioridad:** P2
- **Objetivo:** que el server **traiga** un stream RTSP de una cámara/URL.
- **Precondiciones:** una fuente RTSP alcanzable desde el server (una cámara IP,
  o un feed RTSP público). Es un ingress tipo `url` (pull), no un tipo aparte.
- **Pasos:**
  1. Dashboard → Ingress → Create ingress → Input type **URL (pull)** → **Source
     URL** = `rtsp://camera.local/stream`, room `cam1` → crear.
- **Resultado esperado:** el server tira del RTSP, lo transcodifica y lo publica
  por el camino LiveKit normal (WebRTC/HLS). Acepta `rtsp://`, `rtmp://`,
  `http(s)://`, `srt://`. Hay un guard anti-SSRF: URLs a hosts privados/loopback/
  link-local se rechazan con `400`.
- **Config usada:** input `url`, `url: rtsp://camera.local/stream`. Sin puerto de
  entrada en StreamHub: es una conexión **saliente** al puerto RTSP de la cámara
  (típicamente 554).

### 1.6 — ws-ingest (ESP32/MJPEG) simulado con websocat [OPCIONAL, sin HW]
- **Prioridad:** P2
- **Objetivo:** validar el ingest de JPEG por WebSocket sin una ESP32 real.
- **Precondiciones:** `websocat` instalado; un JPEG de prueba (`frame.jpg`).
- **Pasos:**
  1. Crear una key ws-ingest:
     ```bash
     curl -s -X POST $BASE/apps/live/ws-ingest -H "Authorization: Bearer $STREAMHUB_TOKEN" \
       -H 'Content-Type: application/json' -d '{"room":"cam1"}'
     # → data.streamKey = wsk_...  data.wsUrl = wss://your-server.example.com/ingest/ws?app=live&room=cam1
     ```
  2. Empujar un JPEG por segundo como **frames binarios**:
     ```bash
     while true; do cat frame.jpg; sleep 1; done | \
       websocat --binary -H "Authorization: Bearer wsk_XXXX" \
       "wss://your-server.example.com/ingest/ws?app=live&room=cam1"
     ```
  3. Ver el resultado: abrir `https://your-server.example.com/live/live/cam1/frame.jpg`
     (último frame) o `https://your-server.example.com/play/live/live-cam1`.
- **Resultado esperado:** en la pestaña Ingress, la card **WebSocket cameras
  (ESP32/MJPEG)** muestra estado en vivo y un thumbnail `frame.jpg`. El stream
  aparece en `GET $BASE/apps/live/streams` como `type: ws-mjpeg`. Al cortar la
  conexión dispara `stream_ended`.
- **Config usada:** key `wsk_...`, room `cam1`. Límites por app: `maxFps 15`,
  `maxFrameKb 256`. Pasa por Caddy (puerto 443), no directo a la IP.
- **Con ESP32 real [REQUIERE HW]:** flashear `integrations/esp32cam_ws_ingest.ino`
  apuntando a `/ingest/ws?app=live&room=cam1` con `Authorization: Bearer wsk_...`.

---

# Suite 2 — Playback (reproducción)

**Objetivo:** validar cada superficie de reproducción. Ref:
`streamhub-docs/features/players.md`, `hls-live.md`.

### 2.1 — Página pública `/play`
- **Prioridad:** P1
- **Objetivo:** ver un stream en vivo sin autenticación.
- **Precondiciones:** un stream activo (Suite 1).
- **Pasos:**
  1. Abrir `https://your-server.example.com/play/live/cam1`.
  2. Para un room transcodificado, usar el toggle **WebRTC | HLS**.
- **Resultado esperado:** WebRTC muestra video sub-segundo (LIVE); HLS muestra el
  feed con ~6-15s de latencia. Un canal passthrough abre directo en HLS (WebRTC
  mostraría escenario vacío porque no hay sala LiveKit). Una cámara MJPEG
  (ws-ingest) tiene precedencia y se ve como MJPEG.
- **Config usada:** ruta pública `/play/<app>/<room>` (bypass de auth).

### 2.2 — Embed / iframe público
- **Prioridad:** P2
- **Objetivo:** validar la incrustación embebible.
- **Precondiciones:** un stream activo.
- **Pasos:**
  1. `https://your-server.example.com/embed/live/cam1` en el navegador.
  2. Alternativa: pegar el snippet `<iframe>` (que devuelve el token/menú
     Compartir) en un HTML propio.
- **Resultado esperado:** el reproductor embebido carga y reproduce; el iframe
  respeta `allow="autoplay; fullscreen; camera; microphone"`.
- **Config usada:** ruta pública `/embed/<app>/<room>`.

### 2.3 — Players del dashboard (WebRTC / HLS / VOD)
- **Prioridad:** P1
- **Objetivo:** ver un stream desde el panel autenticado.
- **Precondiciones:** logueado; un stream activo.
- **Pasos:**
  1. App `live` → pestaña **Streams** / **En vivo** → en la fila del stream:
     **Ver (WebRTC)**, **Ver (HLS)**, y el menú **Compartir**.
  2. Probar cada uno; en Compartir, copiar la URL pública `/play/...` y el
     snippet `/embed/...`.
- **Resultado esperado:** WebRTC abre el `<LivePlayer>` (sub-segundo); HLS abre
  el modal HLS; el menú Compartir copia URLs válidas. Filas passthrough abren
  **Ver (HLS)** directo sobre `/hls/live/cam1/index.m3u8` sin arrancar egress.
- **Config usada:** —

### 2.4 — URL HLS directa
- **Prioridad:** P2
- **Objetivo:** validar el playlist HLS crudo.
- **Precondiciones:** un stream (transcodificado o passthrough).
- **Pasos:**
  1. Abrir en VLC o `ffplay`:
     `https://your-server.example.com/hls/live/cam1/index.m3u8`.
- **Resultado esperado:** el playlist carga y reproduce los segmentos `.ts`.
- **Config usada:** ruta pública `/hls/<app>/<room>/index.m3u8`.

### 2.5 — Samples / examples embebidos
- **Prioridad:** P2
- **Objetivo:** validar las páginas de ejemplo autogeneradas.
- **Precondiciones:** app `live`.
- **Pasos:**
  1. App `live` → pestaña **Samples** → abrir la URL embebida de
     `webrtc-play.html` / `hls-player.html` / `cctv-grid.html`.
- **Resultado esperado:** cada sample abre en `/samples/live/<archivo>` y, si la
  app tiene `publicPlayback`, reproduce anónimamente.
- **Config usada:** — (detalle en Suite 4, caso 4.19).

### 2.6 — Latencia esperada por modo (checklist)
- **Prioridad:** P2
- **Objetivo:** confirmar que cada modo tiene la latencia correcta de orden de
  magnitud.
- **Pasos/Resultado esperado:**
  - **WebRTC:** sub-segundo (< 1s).
  - **HLS (transcodificado):** ~6-15s.
  - **RTMP passthrough (HLS):** ~2 segmentos (más bajo que HLS transcodificado).
  - **MJPEG (ws-ingest):** cerca de tiempo real (fan-out por frame).
- **Config usada:** —

---

# Suite 3 — Salas, chat, reacciones, viewers, broadcast

Ref: `streamhub-docs/features/chat-reactions-viewers.md`, `broadcast.md`,
`restream.md`. Chat/reactions/viewers son **feature flags por app** (`chat`,
`reactions`, `viewerCounter`) que se activan en la pestaña **Config** de la app.

### 3.1 — Publicar en una sala WebRTC (webcam)
- **Prioridad:** P1
- **Objetivo:** publicar cámara/mic desde el navegador a una sala.
- **Precondiciones:** app `live`; permiso de cámara/mic en el navegador.
- **Pasos:**
  1. Abrir el sample `webrtc-publish.html` (Samples tab) o la pestaña
     **Transmitir** del panel.
  2. Permitir cámara/mic y publicar al room `demo`.
- **Resultado esperado:** el stream aparece en vivo; se puede ver por WebRTC en
  otra pestaña (`/play/live/demo`).
- **Config usada:** token `canPublish` (lo mintea la página).

### 3.2 — Chat sobre data channel
- **Prioridad:** P2
- **Objetivo:** validar el chat.
- **Precondiciones:** feature `chat: true` en la app; una sala con al menos un
  espectador y un publisher.
- **Pasos:**
  1. Activar `chat` en Config.
  2. Desde el player, enviar un mensaje de chat.
  3. Inyectar uno desde el servidor:
     ```bash
     curl -s -X POST "$BASE/apps/live/streams/demo%2Falice/data" \
       -H "Authorization: Bearer $STREAMHUB_TOKEN" -H 'Content-Type: application/json' \
       -d '{"topic":"chat","from":"system","message":"Bienvenido!"}'
     ```
- **Resultado esperado:** los mensajes aparecen en el panel de chat de todos los
  clientes de la sala; la inyección server-side devuelve `{sent:true}` y dispara
  el callback `chat_message`. Con `chat` desactivado, el POST con `topic:chat`
  da `404` ("disabled for this app").
- **Config usada:** `features.chat: true`, topic `chat`.

### 3.3 — Reacciones
- **Prioridad:** P2
- **Objetivo:** validar reacciones animadas.
- **Precondiciones:** feature `reactions: true`.
- **Pasos:**
  1. Enviar una reacción desde el player, o server-side:
     ```bash
     curl -s -X POST "$BASE/apps/live/streams/demo%2Falice/data" \
       -H "Authorization: Bearer $STREAMHUB_TOKEN" -H 'Content-Type: application/json' \
       -d '{"topic":"reaction","reaction":"❤️","from":"alice"}'
     ```
- **Resultado esperado:** aparece la reacción flotante (❤️) sobre el video;
  dispara el callback `reaction`.
- **Config usada:** `features.reactions: true`, topic `reaction`.

### 3.4 — Contador de viewers
- **Prioridad:** P2
- **Objetivo:** validar el conteo de espectadores reales.
- **Precondiciones:** feature `viewerCounter: true`; abrir el stream en 2-3
  pestañas.
- **Pasos:**
  1. Activar `viewerCounter` en Config.
  2. Abrir el mismo room en varias pestañas de espectador.
  3. `curl -s "$BASE/apps/live/streams/demo%2Falice" -H "Authorization: Bearer $STREAMHUB_TOKEN" | jq .data.viewers`
- **Resultado esperado:** `viewers` refleja el número de subscriptores reales
  (excluye publishers y participantes ocultos/QC). También se exporta a
  Prometheus como `streamhub_stream_viewers`.
- **Config usada:** `features.viewerCounter: true`.

### 3.5 — Broadcast a RTMP externo (YouTube/Twitch)
- **Prioridad:** P2 `[REQUIERE destino RTMP]`
- **Objetivo:** reenviar una sala a un destino RTMP externo.
- **Precondiciones:** una sala con alguien publicando; una URL RTMP de destino
  (YouTube/Twitch/custom).
- **Pasos:**
  1. Publicar a la sala `live-room-1` (paso 3.1).
  2. Iniciar el broadcast:
     ```bash
     curl -s -X POST $BASE/apps/live/broadcast/start -H "Authorization: Bearer $STREAMHUB_TOKEN" \
       -H 'Content-Type: application/json' \
       -d '{"roomName":"live-room-1","rtmpUrl":"rtmp://a.rtmp.youtube.com/live2/xxxx"}'
     ```
  3. Listar (`GET /apps/live/broadcast`) y detener
     (`POST /apps/live/broadcast/:egressId/stop`).
- **Resultado esperado:** `start` devuelve un `egressId` con `status: starting`;
  el destino externo recibe el stream; `list` lo muestra activo; `stop` lo corta.
  Sujeto a la cuota `max_egress_gb_month`.
- **Config usada:** `rtmpUrl` debe matchear `^rtmps?://`.
- **Alternativa sin destino público:** apuntar a un nginx-rtmp/MediaMTX local y
  verificar que llega el stream. Para multi-destino simultáneo, ver `restream.md`.

---

# Suite 4 — Core (multi-tenant, grabación, tokens, seguridad, backups)

Ref: `streamhub-docs/features/apps-multitenant.md`, `config-editor.md`,
`recording.md`, `vod.md`, `tokens.md`, `auth.md`, `quotas.md`,
`network-security.md`, `samples.md`, `EXAMPLES.md`,
`streamhub-docs/operations/BACKUPS.md`.

> **Mapa de navegación:** Apps (`/apps`) · Studio/plugins (`/studio`) · Cluster
> (`/cluster`) · Logs (`/logs`) · **Server Settings** (`/settings`, sólo
> superadmin: Network security + Database backups + OS tuning) · Audit
> (`/audit`) · Compliance (`/compliance`) · Account (`/account`). La página de
> una app tiene pestañas: Overview, Streams, Vods, Tokens, Samples, Plugins,
> Config (+ Ingress/Logs/Maintenance/Integraciones).

## 4A. Apps multi-tenant + editor de config.yaml

### 4.1 — Crear una app
- **Prioridad:** P1
- **Objetivo:** crear un tenant nuevo.
- **Precondiciones:** logueado; cuota `maxApps` no agotada.
- **Pasos:**
  1. Apps → **Create app** → name `qa-demo`.
- **Resultado esperado:** aparece la card; se scaffoldea `apps/qa-demo/`
  (config.yaml, DB, recordings/, snapshots/, samples/); `GET $BASE/apps` la lista.
  El name debe matchear `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$`.
- **Config usada:** `{ "name": "qa-demo" }`.

### 4.2 — Editar config.yaml (form + raw + validar + revertir)
- **Prioridad:** P1
- **Objetivo:** validar el editor de configuración y sus backups.
- **Precondiciones:** app `qa-demo`.
- **Pasos:**
  1. Abrir `qa-demo` → **Config** → editor **raw YAML** → cambiar
     `split_minutes: 30`.
  2. **Validate** (dry-run): muestra el diff sin escribir.
  3. **Save**: escribe, hace backup timestamped y hot-reload.
  4. Ir a la lista de backups → **Revert** al anterior.
- **Resultado esperado:** Validate devuelve `{valid, diff, changed}` sin escribir;
  Save devuelve `{reloaded:true}` y agrega una entrada de backup; Revert restaura
  el valor y recarga (sin reiniciar el proceso).
- **Config usada:** `split_minutes: 30`. Rutas:
  `PUT/GET/POST .../config/raw`, `.../config/backups[/:ts/revert]`.

### 4.3 — Borrar una app
- **Prioridad:** P1
- **Objetivo:** eliminar un tenant sin afectar otros.
- **Precondiciones:** app `qa-demo` existente.
- **Pasos:**
  1. Apps → borrar `qa-demo` (opcional `deleteVods=true`).
- **Resultado esperado:** desaparece; las demás apps quedan intactas.
- **Config usada:** `DELETE /apps/qa-demo?deleteVods=true`.

## 4B. Grabación + S3 por app + VODs

### 4.4 — Configurar S3 por app (con MinIO) [REQUIERE S3/MinIO]
- **Prioridad:** P1
- **Objetivo:** validar el round-trip de configuración S3.
- **Precondiciones:** MinIO corriendo local.
- **Pasos:**
  1. Levantar MinIO:
     ```bash
     docker run -p 9000:9000 -p 9001:9001 quay.io/minio/minio server /data --console-address ":9001"
     ```
     Crear el bucket `streamhub-qa` en la consola (`:9001`).
  2. Configurar S3:
     ```bash
     curl -s -X PUT $BASE/apps/live/s3 -H "Authorization: Bearer $STREAMHUB_TOKEN" \
       -H 'Content-Type: application/json' \
       -d '{"provider":"minio","bucket":"streamhub-qa","endpoint":"http://127.0.0.1:9000","forcePathStyle":true,"prefix":"streamhub/live","key":"minioadmin","secret":"minioadmin"}'
     ```
  3. Leer con `GET /apps/live/s3` (credenciales enmascaradas).
- **Resultado esperado:** el cliente S3 se re-inicializa sin reiniciar; `GET`
  muestra la config con `key`/`secret` enmascarados. MinIO exige
  `forcePathStyle:true`.
- **Config usada:** provider `minio`. Providers válidos: `aws | wasabi | minio`.
- **Nota:** activar un `public_url` no vacío exige `confirmPublic: true`.

### 4.5 — Grabar → VOD en S3 [REQUIERE S3 + LiveKit/egress]
- **Prioridad:** P1
- **Objetivo:** grabar una sala y verla como VOD en el bucket.
- **Precondiciones:** stack LiveKit+egress corriendo (Linux); S3 configurado
  (4.4); `recording.enabled: true` en config.yaml.
- **Pasos:**
  1. Activar grabación (Config tab: `recordingEnabled`, o raw YAML).
  2. Publicar un stream corto (Suite 1) y arrancar grabación:
     `POST /apps/live/recording/start` (o **Grabar** en la fila del stream).
  3. Detener; esperar el upload.
- **Resultado esperado:** el VOD pasa `recording → uploading → ready`; el MP4
  aparece en el bucket bajo `streamhub/live/...`; `GET /apps/live/vods/:id`
  devuelve `presignedUrl` válida.
- **Config usada:** `recording.enabled: true`. Sujeto a cuota
  `maxRecordingMinutesMonth`.
- **Alternativa sin egress:** si no hay stack LiveKit, validar sólo el round-trip
  de config S3 (4.4) y la lista/borrado de VODs sembrados.

### 4.6 — Listar / descargar / borrar VODs
- **Prioridad:** P1
- **Objetivo:** validar el ciclo de vida de VODs.
- **Precondiciones:** al menos un VOD `ready`.
- **Pasos:**
  1. App → **Vods** → listar, reproducir, **Download**.
  2. Borrar un VOD.
- **Resultado esperado:** `GET /apps/live/vods` lista; `/download` transmite el
  MP4; `DELETE /apps/live/vods/:id` cascada: borra fila DB + objeto S3 + snapshot
  + variantes + archivo local, devolviendo `{deleted, s3Deleted, localDeleted}`.
- **Config usada:** —

## 4C. Tokens sk_ + RBAC

### 4.7 — Crear un token global y uno per-app
- **Prioridad:** P1
- **Objetivo:** validar creación/revocación de tokens API.
- **Precondiciones:** logueado.
- **Pasos:**
  1. Crear un token global:
     ```bash
     curl -s -X POST $BASE/tokens -H "Authorization: Bearer $STREAMHUB_TOKEN" \
       -H 'Content-Type: application/json' -d '{"name":"ci","scope":"global"}'
     ```
  2. Crear uno per-app (requiere `appId`):
     `{"name":"app-ci","scope":"app","appId":<id>}`.
  3. Revocar: `DELETE /tokens/:id`.
- **Resultado esperado:** el POST devuelve `{id, token:"sk_..."}` **una sola vez**
  (se guarda hasheado). Un token `app` sólo opera dentro de su app; endpoints
  globales (`/system`, `/security`, `/cluster`) le dan `403`. `GET /tokens` nunca
  devuelve los hashes. `DELETE` → 204.
- **Config usada:** `scope: global` / `scope: app` + `appId`.
- **Nota:** en el dashboard, los tokens se gestionan en la pestaña **Tokens** de
  la app (mintea también tokens LiveKit de join).

### 4.8 — Modos de enforcement RBAC (off/log/on)
- **Prioridad:** P1
- **Objetivo:** ver la diferencia entre los tres modos.
- **Precondiciones:** un usuario con rol `editor` (ver 4.11); poder cambiar
  `STREAMHUB_AUTHZ_ENFORCE` en `.env` y reiniciar.
- **Pasos:**
  1. Confirmar el modo actual en **Server Settings** (lo muestra read-only).
  2. Como `editor`, intentar `DELETE /apps/:name` (requiere `app:delete`) en cada
     modo.
- **Resultado esperado:**
  - `off` → permitido (sin chequeos).
  - `log` → permitido, pero aparece un "would-deny" en Logs.
  - `on` → **403**.
- **Config usada:** `STREAMHUB_AUTHZ_ENFORCE=off|log|on`.
- **Nota importante:** las instalaciones nuevas arrancan en `on` (según
  `CLAUDE.md`), aunque algunos docs citan `log` como default. **Verificá el modo
  real en Server Settings antes de fijar expectativas** de pass/fail.

## 4D. Usuarios del dashboard

### 4.9 — Login break-glass (ya cubierto)
- Ver caso **0.4**.

### 4.10 — Invitar un miembro al equipo
- **Prioridad:** P2
- **Objetivo:** crear un usuario del dashboard con rol.
- **Precondiciones:** logueado como owner/superadmin.
- **Pasos:**
  1. **Account** → pestaña **Equipo** → invitar `bob@example.com` con rol
     `editor`.
- **Resultado esperado:** Bob aparece como pendiente; `GET /teams/mine` lo lista.
  Si el email no existe, se crea un usuario pending (setea password al registrarse
  con el mismo email). Roles: `owner | editor | viewer`.
- **Config usada:** `{ "email":"bob@example.com", "role":"editor" }`.

### 4.11 — Un editor no puede hacer acciones de owner
- **Prioridad:** P2
- **Objetivo:** validar el gate de rol.
- **Precondiciones:** usuario `editor`; `STREAMHUB_AUTHZ_ENFORCE=on`.
- **Pasos:**
  1. Loguearse como el editor.
  2. Intentar borrar una app.
- **Resultado esperado:** **403** (falta `app:delete`). El editor sí puede
  leer/operar apps/config/streams/recording/vod, pero no borrar la app ni
  gestionar tenant/tokens.
- **Config usada:** rol `editor`, enforcement `on`.

## 4E. Cuotas

### 4.12 — Disparar una cuota (maxApps)
- **Prioridad:** P1
- **Objetivo:** ver el rechazo por cuota.
- **Precondiciones:** `STREAMHUB_AUTHZ_ENFORCE=on`; tenant free (`maxApps=2`).
- **Pasos:**
  1. Como owner del plan free, crear 2 apps (llena `maxApps`).
  2. Intentar crear una 3ª.
- **Resultado esperado:** **429**
  `{"error":"quota_exceeded","metric":"maxApps","limit":2,"used":2}`. En modo
  `log` se permite pero se loguea "QUOTA-WOULD-DENY". Superadmin y tokens API
  nunca tienen cuota.
- **Config usada:** plan free. Otras métricas: `maxConcurrentStreams` (2),
  `maxRecordingMinutesMonth` (300), `maxEgressGbMonth` (5), `maxStorageGb` (5).
- **Nota:** un superadmin puede bajar límites en **Account → Plataforma**
  (`PATCH /tenants/:id/quotas`) para disparar la cuota más rápido.

## 4F. Seguridad de red

### 4.13 — Bloquear una IP (allow/block)
- **Prioridad:** P2
- **Objetivo:** validar el bloqueo por IP.
- **Precondiciones:** `STREAMHUB_IP_ACCESS_MODE=enforce`; una IP **pública**
  desde la que puedas originar (ej. un teléfono con datos móviles). **No sirve una
  IP privada/loopback**: esas siempre están permitidas y no se pueden banear.
- **Pasos:**
  1. **Server Settings → Network security** → agregar una regla **block** para tu
     CIDR público (ej. `203.0.113.0/24`).
  2. Desde esa IP, pegarle a cualquier ruta.
  3. Borrar la regla.
- **Resultado esperado:** **403** `{error:{code:"forbidden"}}` (genérico, no revela
  qué regla); al borrar la regla se restablece de inmediato (recarga en memoria,
  sin reiniciar).
- **Config usada:** modo `enforce`, regla `block` sobre CIDR público.

### 4.14 — Auto-ban por abuso
- **Prioridad:** P2
- **Objetivo:** validar el fail2ban interno.
- **Precondiciones:** `STREAMHUB_AUTOBAN_ENABLED=true`; IP pública.
- **Pasos:**
  1. Desde una IP pública, enviar >10 logins fallidos en <300s.
  2. Ver `GET /security/bans`; luego `POST /security/bans/:ip/unban`.
- **Resultado esperado:** tras superar el umbral, las requests reciben **429**; la
  IP aparece en la lista `active` de bans; el unban limpia el estado. Los bans
  persisten en `ip_bans` y sobreviven un reinicio.
- **Config usada:** `STREAMHUB_AUTOBAN_MAX_OFFENSES=10`, `_WINDOW_S=300`,
  `_BASE_TTL_S=900` (se duplica por reincidencia, tope 7 días).

## 4G. Backups

### 4.15 — Backup on-demand
- **Prioridad:** P1
- **Objetivo:** generar un snapshot manual.
- **Precondiciones:** superadmin.
- **Pasos:**
  1. **Server Settings → Database backups** → **Back up now** (o
     `POST /system/backups`).
- **Resultado esperado:** devuelve un resumen del run; `GET /system/backups`
  muestra nuevos snapshots por DB (global `streamhub` + cada `app-<name>`), con
  archivo/tamaño/timestamp. Los snapshots van a
  `<DATA_DIR>/backups/<db>/<stamp>.db.gz`.
- **Config usada:** —

### 4.16 — Restore con verificación de integridad
- **Prioridad:** P1
- **Objetivo:** restaurar un snapshot y validar los guards de seguridad.
- **Precondiciones:** al menos un snapshot (4.15).
- **Pasos:**
  1. Hacer un cambio visible (crear app `qa-tmp`).
  2. Restaurar el snapshot previo de `app-live` o `streamhub`: tipear la frase de
     confirmación → confirmar.
  3. Prueba negativa: intentar restaurar un archivo corrupto/no-SQLite.
- **Resultado esperado:** el restore crea una copia `.pre-restore`, corre
  `PRAGMA integrity_check` (si falla, aborta con `400` y **no toca** la DB viva),
  hace swap atómico y re-corre migraciones. Restaurar el `streamhub` global
  devuelve `restartRecommended: true`. El archivo corrupto → `400`, DB intacta.
- **Config usada:** `{ "db":"app-live", "snapshot":"<archivo>", "confirm":true }`.

## 4H. Samples / examples bundles

### 4.17 — Abrir y editar un sample
- **Prioridad:** P2
- **Objetivo:** validar las páginas sample por app.
- **Precondiciones:** app `live`.
- **Pasos:**
  1. App → **Samples** → abrir la URL embebida de un sample.
  2. Editar un sample → **Save** (`PUT`).
  3. **Regenerate** (`POST .../samples/regenerate`).
- **Resultado esperado:** el sample abre público en `/samples/live/<file>`; el
  Save cambia sólo la copia de esta app; Regenerate restaura el set estándar y
  devuelve la lista regenerada.
- **Config usada:** —

### 4.18 — Descargar bundle standalone
- **Prioridad:** P2
- **Objetivo:** validar el bundle descargable.
- **Precondiciones:** app `live`.
- **Pasos:**
  1. Samples → card **Download standalone bundles** → **Download .zip** de un
     example (o **Download all**).
  2. Descomprimir → editar `config.js` (`baseUrl`, `wsUrl`, `app`, `room`) →
     abrir `index.html`.
- **Resultado esperado:** el zip trae `index.html` + `config.js` + `README.md`,
  **sin secretos** (sólo URLs públicas y slugs); al abrirlo conecta de vuelta a la
  instancia. `index.html` es idéntico a la página servida; sólo cambia `config.js`.
- **Config usada:** `GET /apps/live/examples/<id>.zip` / `all.zip`.

---

# Suite 5 — Studio Apps (plugins)

Ref: `streamhub-docs/features/STUDIO-APPS.md`, `plugins.md`, `vision-edge.md`.

> **Ciclo de vida común (vale para TODAS):**
> - **Instalar:** app → pestaña **Plugins** (o `/studio`) → instalar el plugin
>   (`POST /apps/:app/plugins/:id/install`, idempotente).
> - **Habilitar + configurar:** abrir el Studio App (full-page en
>   `apps/:app/studio/:id`) → pestaña **Settings** → completar campos →
>   habilitar. Equivale a `PATCH /apps/:app/plugins/:id` con `{enabled, config}`
>   (valida contra el `configSchema`; habilitar arranca el worker).
> - **Verificar el worker (los que tienen `needsWorker`):**
>   `GET /apps/:app/plugins/:id/worker/status` (estado) y
>   `GET /apps/:app/plugins/:id/logs?limit=200` (stdout). En el host:
>   `ps aux | grep <worker>`.
> - **Ver eventos/detecciones:** `GET /apps/:app/plugins/:id/data` (canal live
>   autenticado del app-tab); para lpr y las apps vision además
>   `GET /apps/:app/plugins/:id/events?limit=`.
> - **Modelos:** todos los workers de visión **descargan el modelo la primera
>   vez** (latencia/red inicial — tenelo en cuenta al validar el primer run).
> - **GPU:** ninguno **requiere** GPU; todos corren en CPU por defecto con un
>   toggle `cuda`/`device`. En CPU, bajá el `fps` (1-3).

### 5.1 — yolo (YOLO Object Detection)
- **Prioridad:** P2. Worker Python (torch/ultralytics). `player-overlay`.
- **Objetivo:** detectar objetos sobre un stream y recibir detecciones por callback.
- **Precondiciones:** un stream HLS activo (room `cam1`); un endpoint que reciba
  el callback (ej. webhook.site).
- **Pasos:** instalar → Settings → `room=cam1`, `callbackUrl=<tu-webhook>` →
  habilitar → ver el overlay en el player.
- **Resultado esperado:** el worker arranca (`worker/status` = running); el player
  muestra cajas de detección (overlay); el callback recibe
  `{app,room,ts,detections:[{class,conf,bbox}]}` por frame. Sin evento firmado.
- **Config usada (campo → default):** `room` **(req)**, `model=nano`
  (nano/small/medium/large/xlarge), `cuda=false`, `callbackUrl` **(req)**,
  `confidence=0.35`, `fps=2`, `classes=''` (vacío = las 80 clases COCO).

### 5.2 — deface (Face Obfuscation)
- **Prioridad:** P2. Worker Python (onnxruntime/CenterFace). `player-overlay`.
- **Objetivo:** anonimizar caras en el player.
- **Precondiciones:** un stream con caras (room `cam1`).
- **Pasos:** instalar → `room=cam1`, `replacewith=blur` → habilitar → abrir el
  player.
- **Resultado esperado:** el worker publica cajas de cara al canal live; el player
  las enmascara del lado cliente (blur/mosaic/solid, elipse o caja).
  **Importante:** anonimiza SÓLO el player — el media crudo (WebRTC/HLS) y las
  grabaciones **siguen conteniendo caras**.
- **Config usada:** `room` **(req)**, `thresh=0.2`, `replacewith=blur`
  (blur/mosaic/solid/none), `maskScale=1.3`, `boxes=false`, `mosaicSize=20`,
  `scale=''`, `backend=auto`, `cuda=false`, `fps=2`, `drawScores=false`.

### 5.3 — lpr (License Plate Recognition)
- **Prioridad:** P1. Worker Python (fast-alpr/ONNX). `app-tab`. **Emite eventos
  firmados** (único plugin que declara `events`). DB `lpr.db`.
- **Objetivo:** detectar patentes + whitelist/blacklist + eventos `plate.*`.
- **Precondiciones:** un stream de una cámara con patentes (o un video de prueba
  con patentes); callbacks firmados de la app configurados para ver el webhook.
- **Pasos:**
  1. Instalar → Settings → `room=gate-cam`, `whitelist=AB123CD`,
     `blacklist=XX999XX` → habilitar.
  2. Pasar un vehículo (o el video de prueba).
  3. Ver la pestaña del app (lecturas recientes) y el webhook firmado de la app.
- **Resultado esperado:** worker running; `plate.detected` siempre; `plate.allowed`
  si matchea whitelist; `plate.denied` si matchea blacklist (blacklist gana). Los
  eventos llegan por **callbacks firmados de la app (webhook + MQTT)**, por el
  `callbackUrl` opcional, y a la DB `apps/live/lpr/lpr.db` + snapshots JPEG.
- **Config usada:** `room` **(req)**, `detector=yolo-v9-t-384-...`,
  `ocrModel=cct-xs-v1-global-model`, `confidence=0.5`, `fps=2`,
  `dedupeWindowSec=10`, `whitelist`, `blacklist`, `callbackUrl`, `snapshots=true`,
  `cuda=false`.

### 5.4 — presence (Workstation Monitoring)
- **Prioridad:** P2. Worker Python (torch/ultralytics). `app-tab`. DB `presence.db`.
- **Objetivo:** detectar presencia/ausencia por zona + horarios.
- **Precondiciones:** un stream de un puesto/oficina (room `office`).
- **Pasos:** instalar → dibujar una zona en la pestaña del app → setear
  `schedule` y `thresholdMin` → habilitar → dejar la zona vacía > `thresholdMin`.
- **Resultado esperado:** el app-tab muestra ocupación por zona; eventos
  `presence.absent` / `presence.returned` / `presence.after_hours` en la DB
  `presence.db` y por el `callbackUrl` externo.
- **⚠️ Nota (bug conocido):** el worker postea `presence.*` al canal de eventos del
  framework, pero el manifest **no declara** `events`, así que el spoof-guard los
  rechaza con `400` — el relay por **webhook/MQTT firmados NO se dispara**. Sólo
  funcionan el `callbackUrl` externo + el panel live + `presence.db`. No lo
  reportes como fallo de la prueba.
- **Config usada:** `room` **(req)**, `zones='[]'`, `schedule='08:00-18:00'`,
  `scheduleDays='mon-fri'`, `timezone=''`, `thresholdMin=5`, `afterHours=true`,
  `model=nano`, `cuda=false`, `confidence=0.35`, `fps=2`, `callbackUrl=''`.

### 5.5 — perimeter (Intrusion Detection)
- **Prioridad:** P1. Worker Python (torch/ultralytics) + ffmpeg del sistema.
  `app-tab`. DB `perimeter.db`.
- **Objetivo:** detectar persona en zona restringida mientras está *armado*, con
  evidencia (snapshot + clip).
- **Precondiciones:** un stream de una cámara (room `cam-1`).
- **Pasos:**
  1. Instalar → dibujar una **zona restringida** en la pestaña → setear
     `armMode=armed` (o `schedule`) → `callbackUrl` + `callbackSecret` → habilitar.
  2. Hacer entrar una persona a la zona (o pasar un video).
  3. Ver la cola de alertas en el app-tab; acusar recibo (ack).
- **Resultado esperado:** evento `perimeter.intrusion` por el `callbackUrl`
  **firmado** (HMAC en `X-StreamHub-Signature: sha256=...`); evidencia en
  `apps/live/perimeter/` (snapshot JPEG + clip ~10s `-c copy`); fila en
  `perimeter.db`; el dashboard lee el estado armado + cajas por
  `GET .../plugins/perimeter/live/state`. El ack actualiza `ackThrough`.
- **Config usada:** `room` **(req)**, `zones='[]'`, `armMode=schedule`
  (schedule/armed/disarmed), `armSchedule='22:00-06:00'`, `armWeekends=true`,
  `confidence=0.5`, `fps=1`, `cooldown=60`, `clipSeconds=10`, `anchor=foot`,
  `model=nano`, `cuda=false`, `callbackUrl`, `callbackSecret`.

### 5.6 — safety-ppe (Safety PPE Monitor) [EXPERIMENTAL]
- **Prioridad:** P2. Worker Python (onnxruntime). `app-tab`. DB `safety-ppe.db`.
- **Objetivo:** detectar personas sin casco/chaleco.
- **Precondiciones:** un stream de una zona de trabajo (room `live`); primer run
  descarga el modelo ONNX desde `modelUrl`.
- **Pasos:** instalar → dibujar zona(s) de trabajo → `requireHelmet=true`,
  `requireVest=true` → habilitar → simular una violación.
- **Resultado esperado:** evento `ppe.violation` por el `callbackUrl` firmado
  (HMAC); evidencia JPEG en `<DATA_DIR>/evidence/`; filas en
  `<DATA_DIR>/safety-ppe.db` (ojo: en la **raíz** de DATA_DIR, no bajo
  `apps/<app>/`). Modelo advisory/experimental (mAP50 ≈ 0.78).
- **Config usada:** `room` **(req)**, `requireHelmet=true`, `requireVest=true`,
  `zones=''`, `workHours=''`, `workDays=''`, `sustainFrames=3`,
  `cooldownSeconds=120`, `confidence=0.35`, `association=0.5`, `fps=1`,
  `cuda=false`, `callbackUrl`, `callbackSecret`, `modelUrl=<huggingface .onnx>`.
- **Nota CPU:** en CPU ~1s/core por frame; mantené `fps ≤ 1`.

### 5.7 — people-counter (People Counter)
- **Prioridad:** P1. Worker Python (torch/ultralytics + ByteTrack). `app-tab`.
  DB `people-counter.db`.
- **Objetivo:** contar personas cruzando una línea + webhook.
- **Precondiciones:** un stream de una puerta/pasillo (room `door`).
- **Pasos:**
  1. Instalar → en la pestaña, **dibujar la línea** de conteo sobre el video (o
     dejar la horizontal por defecto) → `capacity` opcional → `callbackUrl` +
     `callbackSecret` → habilitar.
  2. Hacer cruzar personas en ambos sentidos.
- **Resultado esperado:** eventos `count.in` / `count.out` / `occupancy.limit`
  por el `callbackUrl` firmado (HMAC); contadores en el app-tab; filas en
  `people-counter.db` (en la raíz de DATA_DIR).
- **Config usada:** `room` **(req)**, `lineX1=0.2`, `lineY1=0.5`, `lineX2=0.8`,
  `lineY2=0.5`, `inDirection=right`, `capacity=0` (0 = sin límite), `fps=5`,
  `model=nano`, `cuda=false`, `confidence=0.3`, `callbackUrl`, `callbackSecret`.

### 5.8 — transcription (VOD Transcription)
- **Prioridad:** P2. Worker Python (faster-whisper). `panel`. **Batch/VOD**, no
  live. Sin eventos ni DB propia.
- **Objetivo:** transcribir un VOD y subir el SRT a S3.
- **Precondiciones:** un VOD `ready` (Suite 4B); S3 configurado.
- **Pasos:**
  1. Instalar → Settings → `provider=local`, `model=small` → habilitar.
  2. Disparar on-demand: `POST /apps/live/vods/:id/transcribe` (o dejar
     `autoTranscribe=true` para que corra en cada VOD nuevo).
- **Resultado esperado:** el worker whisper procesa el job
  (`apps/live/transcripts/jobs/` → `results/`); el core arma el `.srt` y lo sube
  al bucket junto al VOD. Verificar con `worker/status` + `logs` y el `.srt` en S3.
- **Config usada:** `provider=local` (local/openai), `model=small`
  (tiny/base/small/medium/large-v3), `openaiModel=whisper-1`, `language=auto`,
  `autoTranscribe=true`, `apiKey=''` (sólo openai), `device=auto` (auto/cpu/cuda).

### 5.9 — occupancy (Zone Dwell & Sessions) [Vision]
- **Prioridad:** P1. Worker `vision-edge-runtime` (YOLO11 + ByteTrack). `app-tab`.
  DB `occupancy.db`. Edge-capable.
- **Objetivo:** medir permanencia/sesiones por zona.
- **Precondiciones:** un stream con personas (room `office`).
- **Pasos:**
  1. Instalar → **Settings**: sólo `device/fps/confidence`.
  2. **Streams** tab: dibujar una **zona** (polígono) sobre el video, elegir
     `personas`/`vehiculos`, opcional `alertLimit`/`alertAfterSec` → guardar.
  3. Habilitar → generar ocupación.
- **Resultado esperado:** eventos `occupancy.session_started` /
  `session_ended` / `occupancy.alert`; visibles en el **Overview** (detecciones de
  hoy), `GET .../plugins/occupancy/events?limit=`, callbacks firmados, y
  `occupancy.db`.
- **Config usada:** Settings: `device=cpu`, `fps=3.5`, `confidence=0.35`. La
  geometría (zonas) NO está en Settings: se dibuja por room en la pestaña Streams.

### 5.10 — counting (Line-Crossing People Counter) [Vision]
- **Prioridad:** P1. Worker `vision-edge-runtime`. `app-tab`. DB `counting.db`.
- **Objetivo:** contar cruces de línea (variante "vision" del conteo).
- **Precondiciones:** un stream (room `door`).
- **Pasos:** instalar → Settings (`device/fps/confidence`) → Streams: dibujar la
  **línea** de cruce, setear su lado `inside` (top/bottom/left/right) y opcional
  `capacity` → habilitar → hacer cruzar personas.
- **Resultado esperado:** eventos `count.in` / `count.out` / `count.occupancy`;
  en callbacks + `counting.db` + Overview. FPS fijo 3.5 (deliberado, para no
  romper el tracking).
- **Config usada:** Settings: `device=cpu`, `fps=3.5`, `confidence=0.35`.
  Geometría (línea + `inside` + `capacity`) por room en Streams.

### 5.11 — crowd (Density Threshold) [Vision]
- **Prioridad:** P2. Worker `vision-edge-runtime`. `app-tab`. DB `crowd.db`.
- **Objetivo:** contar cabezas por zona y alertar por umbral sostenido.
- **Precondiciones:** un stream con varias personas (room `plaza`).
- **Pasos:** instalar → Settings → Streams: dibujar zona(s) → habilitar.
- **Resultado esperado:** eventos `crowd.count` y `crowd.threshold` (alerta
  multi-ciclo) en callbacks + `crowd.db`.
- **Config usada:** Settings: `device=cpu`, `fps=3.5`, `confidence=0.35`. Zonas
  por room (mismo editor de polígonos que occupancy).

### 5.12 — demography (Age / Gender / Emotion) [Vision]
- **Prioridad:** P2 `[REQUIERE modelo local o API]`. Worker `vision-edge-runtime`.
  `app-tab`. DB `demography.db`.
- **Objetivo:** estimar edad/género/emoción por cara.
- **Precondiciones:** un stream con caras (room `entrance`). Motor `local`
  descarga InsightFace buffalo_l (~300 MB); motores `openai`/`deepseek` requieren
  `ai_api_key`.
- **Pasos:** instalar → Settings: `engine=local` (o `openai`/`deepseek` +
  `ai_api_key`) → Streams: opcional dibujar 1 ROI → habilitar.
- **Resultado esperado:** evento `demography.face`
  `{age, ageRange, gender, emotion, engine}` en callbacks + `demography.db`.
- **Config usada:** Settings: `device=cpu`, `engine=local` (local/openai/deepseek),
  `ai_api_key=''`, `fps=3.5`, `confidence=0.35`. Por room: `intervalSec=120`,
  `roi` opcional, `aiPrompt`, `aiBudgetMonthly` (tope $ mensual, hard-stop).
- **Nota:** la `ai_api_key` NO se envía a nodos edge (se omite deliberadamente en
  el assignment); sólo la usa el worker co-localizado.

### 5.13 — cockpit (camera wall) [Studio App sin worker]
- **Prioridad:** P2. Sin worker, todo client-side. `panel`.
- **Objetivo:** validar la grilla tipo CCTV.
- **Precondiciones:** app con ≥1 stream en vivo.
- **Pasos:** instalar + habilitar en la app → abrir `apps/live/studio/cockpit` →
  ajustar `gridSize`, `autoPlay`, `showLabels`, `refreshSeconds`.
- **Resultado esperado:** grilla paginada de players embebidos, reordenable por
  drag; `2x2` muestra 4 tiles, los labels togglean, refresca en el intervalo. **No
  hay worker** que verificar; la validación es la UI.
- **Config usada:** `gridSize=4x3` (1x1/2x2/3x3/4x3), `autoPlay=true`,
  `showLabels=true`, `refreshSeconds=10`.

### 5.14 — fleet (Agent Management) [Studio App sin worker] `[REQUIERE MQTT + agente]`
- **Prioridad:** P2. Sin worker spawneado (servicio in-core sobre MQTT). `app-tab`.
  DB `fleet.db`.
- **Objetivo:** gestionar agentes IoT/edge por MQTT.
- **Precondiciones:** `mqtt.enabled: true` en el config.yaml de la app; un agente
  StreamHub (`scripts/fleet_agent.py`) apuntando al mismo broker/topicPrefix.
- **Pasos:** instalar + habilitar → apuntar el agente al broker → ver
  `GET /apps/live/plugins/fleet/agents` → mandar un comando
  `POST /apps/live/plugins/fleet/command` (`ping`/`restart`/`ota`/`config`).
- **Resultado esperado:** el agente aparece con telemetría (CPU/RAM/temp/uptime);
  se marca offline tras `offlineAfterSec` de silencio; un comando ida-y-vuelta
  responde en `.../cmd/result` dentro de `commandTimeoutSec`.
- **Config usada:** `offlineAfterSec=90`, `historyPoints=120`,
  `commandTimeoutSec=30`. Topics bajo `mqtt.topicPrefix` (default `streamhub/live`).

### 5.15 — Otros plugins utilitarios (smoke)
- **Prioridad:** P2.
- **Objetivo:** smoke-test de los plugins livianos que no necesitan worker.
- **Plugins:** `vidstack` (player provider — al habilitarlo, el modal HLS y el
  player de VOD renderizan Vidstack en vez de video.js; ver `players.md`),
  `watermark`, `timestamp` (overlay CCTV en el player), `radio`, `quality`,
  `scheduled-live`, `streaming`.
- **Pasos/Resultado esperado:** instalar + habilitar en la app y verificar el
  efecto visible (overlay/player/panel). No tienen `worker/status`.
- **Config usada:** según cada plugin (todos con defaults).

---

# Suite 6 — Streamflow (constructor de workflows)

Ref: código en `streamhub-core-go/internal/streamflow/` + la entrada `streamflow`
de `internal/plugins/builtin/builtins.json`. Studio App **sin worker** (motor in-core), `app-tab`,
DB `streamflow.db`. Config: `ai_provider=openai`, `ai_api_key`,
`ai_model=gpt-4o-mini`, `ai_budget_monthly_usd=20`, `max_runs_per_min=60`.

**Tipos de caja (16):**
- **Triggers:** `trigger.event` (evento del sistema, soporta `prefix.*`),
  `trigger.schedule` (cron/everySeconds), `trigger.mqtt` (matchea `iot.data` por
  topic), `trigger.manual` (botón/API).
- **Actions:** `action.snapshot`, `action.s3`, `action.http`, `action.ai`,
  `action.emit`, `action.mqtt`, `action.notify`, `action.plugin`.
- **Logic:** `logic.condition`, `logic.delay`, `logic.setvar`, `logic.switch`.

### 6.1 — Insertar el template de intrusión
- **Prioridad:** P1
- **Objetivo:** cargar el workflow de ejemplo caja por caja.
- **Precondiciones:** streamflow instalado + habilitado en `live`.
- **Pasos:**
  1. App → Streamflow tab → **Workflows** → **start from template** (o el botón
     "insert starter template" en el editor).
- **Resultado esperado:** se crea un workflow con estas cajas y aristas:
  1. `trigger.event` (`event: perimeter.intrusion`) → 2. `action.snapshot` →
  3. `action.ai` (jsonMode, prompt que pide `{"intrusion",...,"confidence"}`,
  `imageUrl: {{snapshot.url}}`) → 4. `logic.condition`
  (`ai.confidence >= 0.7`) → **[true]** → 5. `action.notify`
  (`title: Confirmed intrusion`, `channels: []`).
- **Config usada:** template `intrusion`.

### 6.2 — Correr un workflow manualmente + inspeccionar runs/steps
- **Prioridad:** P1
- **Objetivo:** ejecutar el workflow y ver el detalle por caja.
- **Precondiciones:** un workflow (6.1).
- **Pasos:**
  1. Editor → botón **Run** (o `POST /apps/live/plugins/streamflow/workflows/:id/run`
     con `{"payload":{...}}`).
  2. Sección **Runs**: ver la lista (poll cada 5s), abrir un run.
- **Resultado esperado:** se encola un run; en Runs aparece con estado
  (`queued/running/ok/failed`); al abrirlo se ve cada step (`boxId · boxType`,
  status, `ms`, y JSON In/Out expandible). Rutas:
  `GET .../runs?limit=` y `GET .../runs/:id` (devuelve `{run, steps}`). El
  ciclo dispara `streamflow.run_started/finished/failed` por callbacks + MQTT.
- **Config usada:** run manual (entra por `trigger.manual` si existe, si no por el
  primer `trigger.*`).
- **⚠️ Notas (comportamiento esperado, no bug de la prueba):**
  1. El template trae `channels: []` en notify → aunque el branch `true` se
     dispare, **no entrega nada** salvo que configures canales (ej. `["discord"]`)
     o el notifier de la app.
  2. La condición usa `ai.confidence`, pero la salida de `action.ai` deja el JSON
     parseado en `ai.json.confidence`. Con una respuesta real de IA, `ai.confidence`
     resuelve a `undefined` y el branch `true` **no** se dispara. Para una prueba
     determinística, corré manual con un `payload` que setee `ai.confidence`, o
     ajustá la regla a `ai.json.confidence`.

### 6.3 — Trigger por evento real (encadenar con perimeter)
- **Prioridad:** P2
- **Objetivo:** que un evento real dispare el workflow.
- **Precondiciones:** perimeter (5.5) emitiendo `perimeter.intrusion`.
- **Pasos:** dejar el workflow de 6.1 habilitado → provocar una intrusión.
- **Resultado esperado:** aparece un run nuevo disparado por `perimeter.intrusion`
  (respetando el rate-limit `max_runs_per_min`).
- **Config usada:** —

---

# Suite 7 — IoT (ws-ingest data + MQTT-in)

Ref: `streamhub-docs/features/mqtt.md`,
`streamhub-docs/integrations/ESP32-WS-INGEST.md`, `config-reference.md`.

### 7.1 — Data frame por ws-ingest → evento `iot.data`
- **Prioridad:** P2
- **Objetivo:** empujar un dato (no-video) por WebSocket y ver el evento.
- **Precondiciones:** una key ws-ingest (`wsk_...`, ver 1.6); `websocat`.
- **Pasos:**
  1. Con la key `wsk_...`, mandar un **frame de texto** (sin `--binary`):
     ```bash
     echo '{"type":"data","topic":"temp","data":{"c":22.4,"rh":51}}' | \
       websocat -H "Authorization: Bearer wsk_XXXX" \
       "wss://your-server.example.com/ingest/ws?app=live&room=cam1"
     ```
- **Resultado esperado:** se dispara `iot.data`
  `{topic:"temp", deviceId:<identity>, data:{...}, source:"ws"}`; llega al webhook
  firmado de la app y, si MQTT está on, se republica en
  `streamhub/live/iot/iot.data`. `topic` debe matchear `^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$`;
  `data` objeto JSON (prof. ≤8); tope 16KB; máx 5/s (excesos se descartan sin
  cerrar el socket).
- **Config usada:** `features.ws_ingest.max_data_bytes=16384`,
  `max_data_per_sec=5`.

### 7.2 — MQTT-in (`mqtt.subscribe`) → `iot.data` [REQUIERE MQTT]
- **Prioridad:** P2
- **Objetivo:** que un mensaje MQTT externo se convierta en `iot.data`.
- **Precondiciones:** un broker MQTT alcanzable; `mosquitto_pub`/`sub` o MQTTX.
- **Pasos:**
  1. En el config.yaml de la app (raw YAML editor), agregar el bloque:
     ```yaml
     mqtt:
       enabled: true
       url: "mqtt://broker.example.com:1883"
       topic_prefix: streamhub/live
       subscribe:
         - topic: devices/#
     ```
  2. Suscribirse para ver el republish:
     ```bash
     mosquitto_sub -h broker.example.com -p 1883 -t 'streamhub/live/iot/#' -v
     ```
  3. Publicar un mensaje que matchee el filtro:
     ```bash
     mosquitto_pub -h broker.example.com -p 1883 -t 'devices/sensor1' -m '{"c":22.4,"rh":51}'
     ```
- **Resultado esperado:** el core recibe el mensaje y dispara `iot.data`
  `{topic:"devices/sensor1", data:{...}, source:"mqtt"}`; lo ves republicado en
  `streamhub/live/iot/iot.data` en tu `mosquitto_sub`, y en el webhook firmado.
- **Config usada:** `mqtt.enabled`, `mqtt.url`, `mqtt.subscribe` (máx 64 filtros;
  se lee del YAML crudo, NO del DTO `PUT /apps/:app/mqtt`).
- **Nota:** mantené el `topic_prefix` de salida (`streamhub/live/...`) distinto de
  los filtros de `subscribe` (`devices/#`) para no armar un loop.

### 7.3 — `iot.data` dispara un `trigger.mqtt` en Streamflow
- **Prioridad:** P2
- **Objetivo:** encadenar IoT → Streamflow.
- **Precondiciones:** un workflow con `trigger.mqtt` (`topic: devices/#` o
  `temp`); 7.1 o 7.2 funcionando.
- **Pasos:** dejar el workflow habilitado → generar el `iot.data` (7.1/7.2).
- **Resultado esperado:** el `trigger.mqtt` matchea el `payload.topic` y crea un
  run nuevo (visible en Runs / `GET .../runs`). No hay un subscriber MQTT aparte:
  Streamflow usa el mismo funnel de eventos.
- **Config usada:** `trigger.mqtt { topic: "devices/#" }`.

---

# Suite 8 — Cluster / Edge

Ref: `streamhub-docs/operations/INSTALL-NODE.md`, `CLUSTER-2NODE-TEST.md`,
`CLUSTER-UPDATES.md`, `features/vision-edge.md`.

> **Realidad para un tester de una sola máquina:** el **plano de control**
> completo (CLI `streamhub cluster`, dashboard Cluster/Edge, métricas del master,
> procesamiento **co-localizado**) se valida en una sola caja. Lo que **sí**
> necesita una 2ª máquina (y a veces GPU) es un join real, el estado `online` por
> WS de un nodo remoto, assignments que aterricen en un nodo remoto, y el
> failover online/offline. Esos casos están marcados `[REQUIERE 2ª MÁQUINA]` con
> su alternativa mínima.

### 8.1 — Join de un nodo common (streaming) [REQUIERE 2ª MÁQUINA]
- **Prioridad:** P2
- **Objetivo:** sumar un nodo de media al cluster.
- **Precondiciones:** un 2º host Linux; el master corriendo; el cluster token
  (`clt_...`) del resumen del install / `.env` del master.
- **Pasos:** en el 2º host:
  ```bash
  curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- \
    --join --master-token clt_... --master-ip <master-private-ip> \
    --master-url https://your-server.example.com \
    --node-name edge-ams-1 --region eu-west
  ```
- **Resultado esperado:** el nodo arranca sólo `livekit ingress egress`
  (`--no-deps`), se registra por `POST /cluster/join`, y late cada 60s
  (`POST /cluster/heartbeat`). Aparece en `GET /cluster/nodes` y en el dashboard
  **Cluster → registry**. Se marca `stale` si `last_seen_at` > 90s.
- **Config usada:** `--node-type common` (default).
- **Alternativa 1 caja:** no se puede "unir" un nodo a sí mismo, pero el master
  **se auto-registra**, así que ya aparece un nodo en Cluster → registry.

### 8.2 — Join de un nodo edge (CV) [REQUIERE 2ª MÁQUINA]
- **Prioridad:** P2
- **Objetivo:** sumar un nodo de cómputo/visión.
- **Precondiciones:** un 2º host; el master corriendo.
- **Pasos:** igual que 8.1 pero con `--node-type edge`.
- **Resultado esperado:** el nodo **omite** LiveKit/ingress/egress, instala
  `streamhub-edge.service`, hace el heartbeat HTTP **y** disca el WebSocket de
  control saliente a `/api/v1/edge/ws?nodeId=<id>`. Aparece en `GET /edge/nodes`
  con liveness `connected`. `journalctl -u streamhub-edge -f` muestra
  `registered with master`.
- **Config usada:** `--node-type edge` (o `STREAMHUB_NODE_TYPE=edge`).
- **Alternativa 1 caja:** correr el procesamiento **co-localizado** (5.9-5.12): la
  app vision spawnea su worker en el master vía el ciclo de vida del plugin, sin
  nodo edge. Verificalo con `ps aux | grep vision_edge`.

### 8.3 — Ver los nodos en el dashboard
- **Prioridad:** P2
- **Objetivo:** validar las dos sub-pestañas de Cluster.
- **Precondiciones:** master corriendo.
- **Pasos:** abrir **Cluster** → pestaña **registry** y pestaña **edge**.
- **Resultado esperado:**
  - **registry:** estado del cluster, el **joinCommand** copiable, el token (con
    toggle de reveal), la URL de redis, y una tabla de nodos (nombre, URL, región,
    estado, last-seen; expandible a health; con Edit/Delete).
  - **edge:** una card por nodo (estado online/stale/offline, tipo, región, barras
    CPU/MEM/DISK, bloque GPU/VRAM), selector de `type`, editor de `weight`, botones
    Restart/Reboot; una matriz de **Assignments** (App · Plugin · Stream · Node ·
    Status) que es **read-only**; y la sección de **Sizing**.
- **Config usada:** —
- **Nota 1 caja:** ambas pestañas renderizan; el master se ve como único nodo; sin
  GPU el bloque muestra "no GPU".

### 8.4 — Crear un assignment per-stream
- **Prioridad:** P2
- **Objetivo:** asignar un plugin edge a un stream.
- **Precondiciones:** una app con un plugin edge-capable instalado + habilitado
  (occupancy/counting/crowd/demography/lpr/presence/deface/yolo/safety-ppe/
  perimeter/people-counter).
- **Pasos:** (no hay botón en el dashboard; es REST o auto-reconcile)
  ```bash
  curl -s -X POST $BASE/apps/live/edge/assignments -H "Authorization: Bearer $STREAMHUB_TOKEN" \
    -H 'Content-Type: application/json' -d '{"pluginId":"occupancy","streamId":"office","policy":"weighted"}'
  ```
- **Resultado esperado:** con un nodo edge conectado, el assignment aparece en la
  matriz Cluster → Edge y pasa `pending → offered → running`. Sin nodo edge, queda
  **pending** (también válido de verificar). El POST da `400` si el plugin no está
  instalado o su meta no declara `worker.edge`.
- **Config usada:** `{pluginId, streamId?, policy?}`.
- **Nota:** el reconcile automático (cada 30s, sólo con ≥1 nodo edge conectado)
  crea los assignments espejando los rooms activos.

### 8.5 — Pesos + drain/activate + CLI `streamhub cluster`
- **Prioridad:** P2
- **Objetivo:** validar el control de scheduling.
- **Precondiciones:** correr en el **master** (el CLI aborta en un nodo join);
  `STREAMHUB_API_TOKEN` en el `.env`.
- **Pasos:**
  ```bash
  streamhub cluster status          # tabla de nodos + assignments + pending
  streamhub cluster nodes           # JSON crudo de nodos
  streamhub cluster events -n 50     # últimos eventos edge (GET /logs?source=edge)
  streamhub cluster weight <node> 200
  streamhub cluster drain <node>     # PATCH /cluster/nodes/:id {status:draining}
  streamhub cluster activate <node>
  ```
- **Resultado esperado:** `status`/`nodes`/`events` devuelven datos reales incluso
  en 1 caja (contra el master auto-registrado). `weight`/`drain`/`activate`/
  `restart`/`reboot` necesitan un nodo destino en el registry.
- **Config usada:** política `weighted` (default `round_robin`; peso default 100).
- **⚠️ Limitación conocida:** `draining` es sólo del registry, **no** está cableado
  al allocator de LiveKit, así que un room de **media** nuevo puede caer igual en
  un nodo draining. Para assignments **edge**, el scheduler sí respeta `active`.

### 8.6 — Alerta de capacidad (matar el runtime) [REQUIERE 2ª MÁQUINA]
- **Prioridad:** P2
- **Objetivo:** ver el failover + la alerta de capacidad.
- **Precondiciones:** un nodo edge con assignments corriendo.
- **Pasos:** matar el runtime en el nodo edge (`systemctl stop streamhub-edge`).
- **Resultado esperado:** el nodo se marca offline tras la ventana stale (90s) →
  evento `node.offline`; tras 45s de gracia, sus assignments se re-reparten; los
  que no entran quedan **pending** (gauge `streamhub_edge_pending_assignments`
  sube). Reglas Prometheus: `EdgePendingAssignments` (warning),
  `EdgeNoGpuCapacity` (critical). Log central `cluster.capacity` visible en
  `GET /logs?source=edge`, `streamhub cluster events`, o Grafana.
- **Config usada:** —
- **Alternativa 1 caja:** hacer `POST` de un assignment sin ningún nodo edge
  conectado → queda `pending`, el gauge sube y (sin nodos GPU) dispara
  `EdgeNoGpuCapacity`. Verificá el gauge en `/metrics` del master.

### 8.7 — Upgrade master + nodos (pin / rollback)
- **Prioridad:** P2
- **Objetivo:** validar el flujo de actualización y rollback.
- **Precondiciones:** root en el master; `streamhub doctor` OK.
- **Pasos:**
  1. Master primero: `sudo streamhub upgrade` (o `--version 2.15.0` para pinear).
  2. Luego cada nodo (en su propia caja): `sudo streamhub upgrade` (resume el rol
     desde `.join-profile`).
  3. Rollback: `sudo streamhub upgrade --version <version-anterior>`.
- **Resultado esperado:** el upgrade hace backup pre-upgrade de todas las DBs,
  `docker compose up -d --build`, corre migraciones, espera health y re-estampa
  `VERSION`. Pinear una versión **anterior** = rollback. Si el core no queda
  healthy, conserva el backup, deja el `VERSION` viejo y sale con error.
- **Config usada:** `--version X.Y.Z`, `--channel latest`, `--force`.
- **Verificar rejoin (desde el master):**
  ```bash
  curl -s -H "Authorization: Bearer $STREAMHUB_TOKEN" $BASE/cluster/nodes | \
    jq '.[] | {name, type, last_seen_at, stale}'
  ```
- **Nota:** `[REQUIERE 2ª MÁQUINA]` sólo para los pasos de upgrade de nodo; el
  upgrade/pin/rollback del master es 100% testeable en una caja.

---

# Suite 9 — Observabilidad

Ref: `streamhub-docs/operations/OBSERVABILITY.md`,
`CLUSTER-OBSERVABILITY.md`, `features/observability.md`,
`deploy/observability/`.

### 9.1 — `/metrics` con token
- **Prioridad:** P1
- **Objetivo:** validar el endpoint de métricas y su auth.
- **Precondiciones:** el instalador genera un `METRICS_TOKEN` (`mtk_...`); leelo
  del `.env`.
- **Pasos:**
  ```bash
  curl -s -H "Authorization: Bearer mtk_..." http://127.0.0.1:3020/metrics | grep streamhub_
  # desde 3.3.4 el query param ya no vale (403):
  curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:3020/metrics?token=mtk_..."
  ```
- **Resultado esperado:** con el token correcto, exposición Prometheus con series
  `streamhub_*`. **Sin token configurado → `404`** (default-deny, ni confirma que
  existe). Con token configurado pero ausente/incorrecto → **`403`**.
- **Config usada:** env var **`METRICS_TOKEN`** (¡no `STREAMHUB_METRICS_TOKEN`!).
- **Nota:** los nodos edge no se scrapean directo (NAT); el master **re-exporta**
  su telemetría como `streamhub_cluster_node_*` + `streamhub_edge_*`. Scrapeá sólo
  el master para toda la flota.

### 9.2 — Levantar el stack de observabilidad
- **Prioridad:** P2
- **Objetivo:** levantar Prometheus + Grafana single-node.
- **Precondiciones:** repo en el host; el `METRICS_TOKEN` del core.
- **Pasos:**
  ```bash
  cd deploy/observability
  cp .env.example .env                                   # setear GRAFANA_ADMIN_PASSWORD
  cp secrets/metrics_token.example secrets/metrics_token # pegar el mtk_... del core
  docker compose -f docker-compose.observability.yml --env-file .env up -d
  curl -s http://127.0.0.1:9091/api/v1/targets | jq '.data.activeTargets[]|{job:.labels.job,health}'
  ```
- **Resultado esperado:** Prometheus en **9091** (no 9090), Grafana en
  **127.0.0.1:3001** (acceder por túnel SSH: `ssh -L 3001:127.0.0.1:3001 <host>`).
  Los targets `127.0.0.1` quedan `UP` (los jobs livekit-ingress/egress pueden
  quedar `down` hasta habilitar su `prometheus_port` — es esperado).
- **Config usada:** compose de `deploy/observability`. Nunca exponer a internet.

### 9.3 — Revisar los dashboards
- **Prioridad:** P2
- **Objetivo:** verificar cada dashboard Grafana.
- **Precondiciones:** 9.2 hecho.
- **Pasos/Resultado esperado:** importan y renderizan:
  - **server-global** — CPU/RAM/disco/red del host + up/down de servicios;
    verificar targets `UP` y series `streamhub_*` presentes.
  - **per-app** — elegir `$app`; viewers, streams activos, grabaciones, VODs por
    estado, fallos de callback, uso vs cuota.
  - **media-latency** — RTT/latencia/packet-loss de LiveKit (se puebla con
    tráfico WebRTC real y el `prometheus_port: 6789` habilitado).
  - **edge-nodes** — CPU/mem/disco + GPU/VRAM/peso por nodo y estado del
    scheduler; en 1 caja muestra sólo el master; el panel de pending reacciona al
    hacer un assignment sin nodo elegible (liga con 8.6).
  - **cluster-overview** / **cluster-logs** — `[REQUIERE 2ª MÁQUINA]` / overlay de
    cluster (Loki).
- **Config usada:** dashboards en `deploy/observability/grafana/dashboards/`.

---

# Suite 10 — Responsive (mobile / 390px)

**Objetivo:** validar el dashboard en un viewport chico. Usar el modo responsive
del navegador a **390px** de ancho (iPhone 12/13) o un teléfono real.

### 10.1 — Checklist responsive
- **Prioridad:** P2
- **Objetivo:** que el panel sea usable en mobile sin scroll horizontal.
- **Precondiciones:** logueado; al menos una app con streams/VODs.
- **Pasos + Resultado esperado (marcar cada ítem):**
  - [ ] **Nav / drawer:** el menú lateral colapsa a un drawer/hamburguesa; abre y
        cierra; los items navegan.
  - [ ] **Tablas** (Streams, Vods, Tokens, Nodos): se adaptan (scroll interno o
        layout apilado); **no** empujan la página a scroll horizontal.
  - [ ] **Modales** (crear ingress, ver credenciales, confirmar borrado, restore):
        entran en pantalla, con botones alcanzables y cerrables.
  - [ ] **Sin scroll horizontal** en ninguna vista (Dashboard, Apps, AppDetail y
        sus pestañas, Cluster, Server Settings, Account).
  - [ ] **Players** (`/play`, `/embed`) responsive y con controles usables al tap.
  - [ ] **Studio Apps** (editores de zona/línea): el canvas de dibujo es usable al
        tap en mobile (o degrada de forma clara).
- **Config usada:** viewport 390px.

---

# Inconsistencias código/docs detectadas

Encontradas al verificar esta guía contra el código. Útiles para no confundir un
bug conocido con un fallo de la prueba:

1. **`presence` no entrega por webhook/MQTT firmados.** El worker postea
   `presence.*` al canal de eventos del framework, pero el manifest
   (`plugins/presence/plugin.meta.ts`) **no declara** `events`, así que el
   spoof-guard (`internal/plugins/service.go`) los rechaza con `400`. Sólo funcionan el
   `callbackUrl` externo + el panel live + `presence.db`. (Caso 5.4.)
2. **Template de intrusión de Streamflow — dos detalles:** (a) `notify` viene con
   `channels: []` (no entrega salvo que configures canales); (b) la condición usa
   `ai.confidence`, pero `action.ai` deja el JSON parseado en
   `ai.json.confidence`, así que con una respuesta real de IA el branch `true` no
   se dispara. (Caso 6.2.)
3. **Variable de métricas:** es **`METRICS_TOKEN`**, no `STREAMHUB_METRICS_TOKEN`
   (que no existe). El valor generado lleva prefijo `mtk_`. (Caso 9.1.)
4. **Default de RBAC/quotas ambiguo:** los docs (`quotas.md`, `auth.md`) citan
   `log` como default de `STREAMHUB_AUTHZ_ENFORCE`, pero `CLAUDE.md` dice que las
   instalaciones nuevas arrancan en `on`. Verificá el modo real en Server Settings
   antes de fijar expectativas. (Casos 4.8, 4.12.)
5. **Assignments edge sin botón de UI:** la matriz de Cluster → Edge es read-only;
   los assignments se crean por REST (`POST /apps/:app/edge/assignments`) o por el
   reconcile automático. (Caso 8.4.)
6. **`draining` no llega al allocator de media:** un nodo `draining` puede recibir
   igual rooms de media nuevos (sí frena assignments edge). (Caso 8.5.)
7. **Ubicación de DBs inconsistente:** `lpr`/`presence`/`perimeter` guardan su DB
   bajo `apps/<app>/<plugin>/`, pero `safety-ppe` y `people-counter` la guardan en
   la **raíz** de `DATA_DIR`. (Casos 5.6, 5.7.)

---

# Matriz-resumen (para reportar resultados)

Leyenda de estado: `OK` / `FALLA` / `N/A` (no aplicable / infra faltante) /
`BLOQUEADO`.

| Área | Casos | P1 | P2 | Requiere infra extra | Estado |
|---|---|---|---|---|---|
| 0. Entorno | 0.1–0.5 | 0.1, 0.3, 0.4, 0.5 | 0.2 | — | |
| 1. Ingest | 1.1–1.6 | 1.1, 1.3 | 1.2, 1.4, 1.5, 1.6 | 1.5 (cámara RTSP), 1.6 (websocat/ESP32) | |
| 2. Playback | 2.1–2.6 | 2.1, 2.3 | 2.2, 2.4, 2.5, 2.6 | — | |
| 3. Salas/chat/broadcast | 3.1–3.5 | 3.1 | 3.2, 3.3, 3.4, 3.5 | 3.5 (destino RTMP) | |
| 4. Core | 4.1–4.18 | 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.12, 4.15, 4.16 | 4.10, 4.11, 4.13, 4.14, 4.17, 4.18 | 4.4–4.6 (S3/MinIO + egress) | |
| 5. Studio Apps | 5.1–5.15 | 5.3, 5.5, 5.7, 5.9, 5.10 | resto | worker Python (todas 5.1–5.12); 5.12 (modelo/API); 5.14 (MQTT+agente) | |
| 6. Streamflow | 6.1–6.3 | 6.1, 6.2 | 6.3 | 6.3 (perimeter activo) | |
| 7. IoT | 7.1–7.3 | — | 7.1, 7.2, 7.3 | 7.2 (broker MQTT) | |
| 8. Cluster/Edge | 8.1–8.7 | — | todos | 8.1, 8.2, 8.6, 8.7 (2ª máquina) | |
| 9. Observabilidad | 9.1–9.3 | 9.1 | 9.2, 9.3 | 9.2–9.3 (stack observ.) | |
| 10. Responsive | 10.1 | — | 10.1 | — | |

**Total: 72 casos de prueba** (0:5, 1:6, 2:6, 3:5, 4:18, 5:15, 6:3, 7:3, 8:7,
9:3, 10:1) — **28 P1** (camino crítico) y **44 P2**.

Para reportar: por cada caso, anotá `ID · Estado · nota` (ej.
`5.4 · FALLA · el webhook firmado no llegó` — pero recordá la inconsistencia #1
antes de marcarlo FALLA). Un área se considera **aprobada** cuando todos sus P1
pasan; los P2 se reportan como cobertura adicional.
