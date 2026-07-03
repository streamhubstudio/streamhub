# StreamHub — SPEC maestro (capa de gestión sobre LiveKit, estilo AntMedia)

StreamHub es la **app core** que ordena un servidor LiveKit self-hosted y lo hace comportarse como
AntMedia: gestión por **Apps**, grabación a **S3 por app**, API propia (global + por app), player
embebible, transcoding adaptativo, logs, snapshots, callbacks. Corre en un VPS Ubuntu
(deploy plain-server) **arriba** del LiveKit ya desplegado.

## 0. Stack (decidido)
- **streamhub-core**: Node 20 + **NestJS** (TypeScript, MVC). Servicio systemd. Es el cerebro: API,
  integración LiveKit (SDK oficial `livekit-server-sdk`), DB SQLite, S3, jobs de grabación.
- **streamhub-ui**: **Laravel 11 + Livewire** (TALL). Solo presentación: consume la API de streamhub-core.
  NO tiene DB propia (la verdad vive en core). php-fpm detrás de nginx.
- nginx enruta un único dominio: `/api/*` → streamhub-core (Node :3020), resto → streamhub-ui (Laravel).
- Reusa el LiveKit existente: `ws://127.0.0.1:7880`, ingress RTMP `:1935`, egress (Docker), redis.

## 1. Dominios / red
- Dominio StreamHub: **`streamhub.example.com`** (A record → 203.0.113.10, lo crea el user; mientras
  tanto se puede servir en `admin.example.com` que ya tiene cert).
- `/api/v1/*` → `http://127.0.0.1:3020` (streamhub-core). Resto → Laravel public/.
- LiveKit público sigue en `wss://media.example.com`. Player usa esa wss.
- Puertos internos: streamhub-core **3020** (bind 127.0.0.1). php-fpm socket. (admin viejo :3010 se retira.)

## 2. Layout de filesystem (en el server)
```
/opt/streamhub/
  data/streamhub.db            # DB GLOBAL (apps registry, api_tokens, server_logs)
  apps/<appName>/
    config.yaml              # config de la app (ver §7)
    vods.db                  # SQLite por-app: VODs + metatags
    recordings/             # archivos locales temporales (antes de subir a S3)
    snapshots/
    samples/                # paginas de ejemplo generadas (publish.html, play.html, embed.html)
  logs/                      # logs de la app (rotados)
```
La app de ejemplo por defecto se llama `live` (como AntMedia).

## 3. Concepto de App (núcleo, paridad AntMedia)
Cada **App** es un tenant lógico: namespace de rooms/streams, su propia config S3, sus claves, sus
VODs, sus tokens. Crear una app:
1. inserta en `streamhub.db.apps`
2. crea `apps/<name>/` con `config.yaml`, `vods.db` (migrado), `recordings/`, `samples/`
3. genera las páginas de ejemplo (publish/play/embed) con la URL pública embebible
Borrar app: opción de conservar o borrar VODs/S3.

## 4. Data model
**Global `streamhub.db`:**
- `apps(id, name UNIQUE, display_name, livekit_room_prefix, created_at, updated_at, settings_json)`
- `api_tokens(id, name, token_hash, scope[global|app], app_id NULL, allowed_ips_json NULL, last_used_at, created_at, revoked)`
- `server_logs(id, ts, level, source, app_id NULL, message, meta_json)`
**Por-app `vods.db`:**
- `vods(id, app_id, stream_id, room, name, file_key, s3_url, public_url, size_bytes, duration_s, width, height, format, status[recording|uploading|ready|failed], local_path, started_at, ended_at, metatags_json, snapshot_key)`
- `streams(id, app_id, stream_id UNIQUE, type[webrtc|rtmp|rtsp|whip], room, participant, status[active|ended], started_at, ended_at, last_stats_json)`

ORM: usar **better-sqlite3** (síncrono, simple) con una capa de repos, o TypeORM con sqlite. Preferir
better-sqlite3 + migraciones SQL propias (más liviano y predecible). Una DB-handle por app (cache).

## 5. streamhub-core — módulos NestJS
Cada módulo en `src/modules/<x>/` (controller + service + dto). NO tocar `app.module.ts`/`shared` salvo el scaffolder.
- **apps**: CRUD apps, genera dirs/config/samples. Endpoints `/api/v1/apps` (GET/POST), `/api/v1/apps/:name` (GET/DELETE/PATCH).
- **livekit**: wrapper del SDK (`RoomServiceClient`, `IngressClient`, `EgressClient`, `AccessToken`, `WebhookReceiver`). Crea rooms, mint tokens, ingress RTMP/WHIP, egress. Recibe webhooks en `/api/v1/webhooks/livekit` y actualiza `streams`/`vods`.
- **recording**: orquesta grabación. Inicia egress room-composite (o participant) → archivo local en `apps/<app>/recordings/` → al `egress_complete`, encola job: subir a S3 de la app → borrar local → insertar VOD en `vods.db` con metatags + generar snapshot. Cola simple in-process (p-queue) o BullMQ+redis (preferir BullMQ con el redis existente para que escale).
- **s3**: abstracción S3 multi-provider (AWS/Wasabi/MinIO) con `@aws-sdk/client-s3` (endpoint + forcePathStyle configurable). Métodos: upload(file), presignGet(key), delete(key). Config viene de la app.
- **auth**: API tokens (Bearer) + whitelist de IPs. Guard global; rutas marcadas públicas (player, healthz) se excluyen. Tokens scope global o por-app. Generación/listado/revoke via `/api/v1/tokens`.
- **health**: `/api/v1/health` (no auth) y `/api/v1/stats` (auth): CPU/mem/disk, uptime, versión, livekit reachable, # streams activos, # rooms, # apps, egress/ingress status. Estilo AntMedia `/rest/v2/broadcasts/...`.
- **streams**: listar streams activos (rooms/participants de LiveKit + tabla `streams`), detalle, stop. Snapshots on-demand (ffmpeg sobre el room composite o último frame).
- **transcoding**: config de video adaptativo. Live = simulcast nativo de LiveKit + ingress `enableTranscoding` (multi-layer). Por-app: niveles (ej. 720p/480p/240p). (VOD HLS multi-rendition: stub/jobs ffmpeg, marcar como v2 si no entra.)
- **logs**: logger estructurado (pino) → consola + archivo `logs/` + tabla `server_logs`. Endpoint `/api/v1/logs` (auth, filtros por app/level/fecha). Niveles, rotación.
- **callbacks**: por-app webhook URL saliente: en eventos (stream_started/ended, vod_ready, recording_failed) hace POST firmado al callback de la app.

## 6. API (REST, JSON, prefijo `/api/v1`)
Auth: `Authorization: Bearer <token>` (excepto `/health`, player y assets públicos). Whitelist IP opcional por token.
Documentación: **`@nestjs/swagger`** → OpenAPI en `/api/v1/docs` (Swagger UI) + JSON en `/api/v1/openapi.json`.
Endpoints núcleo (estilo AntMedia, pero propios):
- Global: `GET /health`, `GET /stats`, `GET/POST /apps`, `GET/DELETE/PATCH /apps/:name`, `GET/POST /tokens`, `DELETE /tokens/:id`, `GET /logs`.
- Por app (prefijo `/apps/:app/...`): `POST /tokens` (join token + URLs), `GET /streams`, `GET /streams/:id`, `DELETE /streams/:id` (stop), `POST /ingress` (rtmp/whip/url), `GET/DELETE /ingress/:id`, `POST /recording/start`, `POST /recording/:id/stop`, `GET /vods`, `GET /vods/:id` (con presigned), `DELETE /vods/:id`, `POST /snapshots`, `GET /config`, `PATCH /config`.
- Webhooks LiveKit (interno): `POST /webhooks/livekit`.
Respuestas consistentes `{data,error}`. Errores con código http correcto. Crear apps **vía API** es first-class.

## 7. config.yaml por app (ejemplo)
```yaml
name: live
display_name: Live
room_prefix: live
recording:
  enabled: true
  mode: room-composite        # room-composite | participant
  layout: grid
  local_dir: recordings
  delete_local_after_upload: true
s3:
  provider: wasabi            # aws | wasabi | minio
  bucket: ale-backup
  region: us-east-1
  endpoint: https://s3.us-east-1.wasabisys.com   # vacío para AWS
  force_path_style: false     # true para minio
  prefix: streamhub/live
  access_key_env: APP_LIVE_S3_KEY   # las credenciales NO van en el yaml; van por env/secret store
  secret_key_env: APP_LIVE_S3_SECRET
webrtc:
  adaptive: true
  layers: [ {name: high, height: 720}, {name: med, height: 480}, {name: low, height: 240} ]
rtmp:
  enabled: true
  transcode: true
callbacks:
  url: ""                     # POST en eventos
  secret: ""
```
Secretos S3: NO en el yaml en claro. Guardar refs (`*_env`) y los valores reales en `data/secrets.json` (chmod 600) o en el `.env` de core. La UI los setea vía API; core los persiste cifrados/fuera del yaml versionable.

## 8. Recording flow (crítico)
1. `POST /apps/:app/recording/start` → core llama egress (room-composite|participant) con salida a archivo local `apps/:app/recordings/<stream>-<ts>.mp4`. Inserta VOD `status=recording`.
2. webhook `egress_updated`/`egress_ended` → core marca `status=uploading`, encola job.
3. job: `s3.upload(localFile, key=prefix/<file>)` al S3 de la app → genera `public_url` (presigned o público) → `delete local` (si `delete_local_after_upload`) → genera snapshot (ffmpeg primer/mid frame) y lo sube → `status=ready`, guarda metatags (room, app, duración, resolución, codec) en `vods.db`. → dispara callback `vod_ready`.
4. Si falla upload: `status=failed`, NO borra local, log error, callback.

## 9. streamhub-ui (Laravel 11 + Livewire)
Consume `https://streamhub.example.com/api/v1` con un token global (server-side, en `.env`). Páginas:
- **Dashboard**: salud server (cards CPU/mem/disk/uptime), streams activos, # apps, # VODs, gráfico simple.
- **Apps**: listado, crear app (form), ver/editar config, borrar.
- **App detail**: tabs Config (editar yaml fields), Streams activos, VODs (tabla con player + presigned + metatags + borrar), Ingress (crear RTMP/RTSP-relay/WHIP, mostrar URL+key copiables), Tokens, Logs, Sample pages (links a publish/play/embed).
- **Player**: componente reproductor (usa LiveKit JS client para live, y `<video>`/hls para VOD). URL pública copiable + snippet `<iframe>` embebible.
- **Logs**: viewer global con filtros.
- **Branding**: logo StreamHub (ver §11), paleta propia.
Auth de la UI: login simple (1 usuario admin desde `.env`) o Basic Auth a nivel nginx — elegir login Livewire simple.

## 10. Player + sample pages
Por cada app, generar en `samples/`:
- `publish.html`: publica cámara/micro vía WebRTC (LiveKit JS) a un room de la app (pide token a la API).
- `play.html`: reproduce un room/stream live.
- `embed.html` + snippet iframe: player embebible con la URL pública.
La UI muestra la **URL pública copiable** (ej. `https://streamhub.example.com/play/<app>/<room>`) y el iframe.

## 11. Logo / branding
Logo "StreamHub" inspirado en la home de www.example.com (mismo espíritu/paleta). Generar un SVG
propio (streamhub/horizonte minimalista), NO copiar assets ajenos. Colores y tipografía propias.

## 12. Deploy (en el server)
- streamhub-core: `npm ci --omit=dev`, build `npm run build`, systemd `streamhub-core.service` (node dist/main.js), bind 127.0.0.1:3020, env en `/opt/streamhub-core/.env` (LiveKit keys, redis, JWT secret, default S3 si aplica).
- streamhub-ui: `composer install`, `php artisan ...`, php-fpm; nginx site `streamhub.example.com`.
- nginx: location `/api/` → 127.0.0.1:3020; location `/` → Laravel public (php-fpm). Cert por **certbot** (plain-server, ya hay nginx+certbot). Reusar/expandir el cert.
- **Cron renovación certs**: asegurar `certbot.timer` activo + cron de respaldo `0 3 * * * certbot renew --quiet && systemctl reload nginx`.
- Migraciones SQLite al boot del core (crea data/streamhub.db + apps por defecto `live`).

## 13. Env / secretos (server, NO al repo)
streamhub-core `.env`: `PORT=3020`, `LIVEKIT_URL=ws://127.0.0.1:7880`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`,
`PUBLIC_WS_URL=wss://media.example.com`, `RTMP_PUBLIC_HOST=media.example.com`, `REDIS_URL=redis://localhost:6379`,
`STREAMHUB_JWT_SECRET`, `DATA_DIR=/opt/streamhub`. Credenciales S3 por app en `data/secrets.json` (chmod 600).
streamhub-ui `.env`: `STREAMHUB_API_URL`, `STREAMHUB_API_TOKEN`, `APP_KEY`, admin user/pass.

## 14. Testing checklist (post-deploy)
- Crear app `demo` vía API. Verificar dirs/config/samples/db.
- RTMP: push ffmpeg → ingress de la app → stream activo en `/streams` → grabar → VOD a Wasabi → local borrado → VOD `ready` con presigned reproducible.
- RTSP: relay → RTMP → idem.
- WebRTC: token de la app → publish/subscribe (lk load-test) 0% loss; sample publish/play.
- S3: confirmar objeto en `ale-backup/streamhub/...` y borrado local.
- Health/stats/logs endpoints responden con datos reales.
- API docs (Swagger) accesible.

## 16. Features adicionales (wave 2 — opcionales por app, flags en config.yaml)
Todo lo siguiente es **opcional y configurable por app** (`features:` en config.yaml). Defaults sensatos.
- **RTMP keys con key + password + player adaptativo**: cada ingress RTMP devuelve `stream_key` + un
  `stream_password` opcional (auth extra: solo se acepta el push si coincide; via `/apps/:app/ingress`).
  El player asociado usa **video adaptativo** (simulcast en vivo; para VOD, renditions HLS si están).
  La UI muestra: URL RTMP (`rtmp://media.example.com:1935/live/<key>`), key, password, y el player+embed.
- **Contador de viewers**: por room/stream, contar suscriptores (no publishers, excluir hidden/QC). Exponer en
  `GET /apps/:app/streams/:id` (`viewers`) y en webhooks/eventos; el player lo muestra en vivo (poll o data channel).
- **Chat (WS) con emojis + reacciones animadas + callbacks**: usar los **data channels de LiveKit** (DataPacket,
  topics: `chat`, `reaction`). Mensajes de chat, emojis, y **reacciones animadas** (ej. corazones/likes que flotan).
  Eventos disparan **callbacks** salientes de la app (`chat_message`, `reaction`). Opcional (`features.chat: true`).
  El player/sample pages incluyen el widget de chat + barra de reacciones cuando está activo.
- **Participantes ocultos de control de calidad (QC)**: en meetings WebRTC, poder unir participantes **hidden**
  (token grant `hidden: true`): suscriben todo pero son **invisibles** para el resto (no aparecen, no cuentan como
  viewer). Sirven para monitoreo/QC y para el grabador. Endpoint para mintar token QC (`/apps/:app/tokens` con
  `hidden: true, recorder/qc: true`).
- **Meetings WebRTC P2P baja latencia**: para llamadas estilo AntMedia EE, priorizar baja latencia (SFU,
  sin transcode innecesario, simulcast). Sample `meeting.html` (grilla multi-participante + chat + reacciones).

### config.yaml — bloque features (ejemplo)
```yaml
features:
  rtmp_password: true        # exige password ademas del stream key
  viewer_counter: true
  chat: true                 # data channels: chat + emojis
  reactions: true            # reacciones animadas
  hidden_qc: true            # permite participantes ocultos QC
  adaptive_player: true
```

## 17. Tests obligatorios extra (en el deploy/test)
- **Reunión 2 participantes + grabación compuesta H264 (headless Chrome)**: levantar **2 participantes reales
  por headless Chrome** (usando las sample pages `publish.html`/`meeting.html` o `lk` con 2 video-publishers) en un
  room de una app, iniciar **egress room-composite**, y verificar que el MP4 resultante es **H.264** (ffprobe:
  `Video: h264`) y muestra a ambos. Subir a S3 y validar VOD `ready`.
- Validar contador de viewers (un subscriber extra → `viewers=1`), chat/reacción (enviar un DataPacket y verlo),
  y un participante **hidden QC** (no aparece en la lista visible ni suma viewer, pero recibe media).

## 15. Convenciones
- TS estricto, ESLint. Estructura NestJS estándar. DTOs validados (class-validator).
- Sin secretos hardcodeados ni commiteados. `.env.example` en cada app.
- Logs estructurados. Errores nunca crashean el proceso.
- Código y comentarios en español/inglés consistentes con el repo.
