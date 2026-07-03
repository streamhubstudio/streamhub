# Instalación end-to-end: LiveKit + StreamHub (un solo dominio)

Runbook para levantar una instancia nueva desde cero: el **media server LiveKit**
(SFU + Ingress RTMP/RTSP + Egress/grabación) y **StreamHub** (la capa de gestión estilo
AntMedia: core NestJS que sirve también la SPA React), todo detrás de **un único dominio**.

> Referencia: un VPS Ubuntu 24.04/26.04 con IP pública, deploy **plain-server**
> (systemd + nginx + certbot), un único dominio (p. ej. `streamhub.example.com`).
> Detalle de la API en `streamhub-docs/`; spec del producto en `streamhub-docs/SPEC.md`.

## 0. Arquitectura (un dominio)

```
                 streamhub.example.com  (nginx + TLS, 1 cert)
   ┌──────────────────────────────────────────────────────────────────────┐
   │  location /rtc   → 127.0.0.1:7880   LiveKit signaling (wss, WebRTC)    │
   │  location /      → 127.0.0.1:3020   streamhub-core (NestJS): API + SPA   │
   └──────────────────────────────────────────────────────────────────────┘
        media WebRTC (UDP 7882) y RTMP (1935) van DIRECTO a la IP del server
   ┌──────────────────────────────────────────────────────────────────────┐
   │ livekit-server (systemd)   7880 ws/api · 7881 tcp · 7882/udp media     │
   │ redis (systemd)            coordina ingress/egress + colas BullMQ      │
   │ livekit/ingress (docker)   1935 RTMP · 8080 WHIP                       │
   │ livekit/egress  (docker)   grabación room-composite → archivo local    │
   │ streamhub-core   (systemd)   127.0.0.1:3020  API + sirve la SPA React    │
   │                            + login JWT + jobs + SQLite + S3            │
   └──────────────────────────────────────────────────────────────────────┘
```

Todo el media transport (UDP/RTMP) va por IP; el dominio sólo cubre la página, la API y el
signaling (wss). Por eso con **un** registro DNS A `streamhub... → IP` alcanza para una instancia.

## 1. Prerrequisitos

- Ubuntu 24.04/26.04, root o usuario con sudo (ej. `ubuntu`). IP pública.
- 1 registro DNS: `A  streamhub.<tu-dominio>  →  <IP>`  (**DNS-only**, sin proxy Cloudflare:
  el media WebRTC es UDP y no pasa por proxies HTTP).
- Puertos a abrir en el firewall: **80, 443, 7880/tcp, 7881/tcp, 7882/udp, 1935/tcp, 3478/udp**.
  (Con `ufw`: `ufw allow <puerto>/<proto>`.)

## 2. LiveKit (redis + server + cli)

```bash
sudo apt-get update
sudo apt-get install -y redis-server ffmpeg curl jq
sudo systemctl enable --now redis-server
curl -sSL https://get.livekit.io      | sudo bash    # livekit-server
curl -sSL https://get.livekit.io/cli  | sudo bash    # lk CLI
livekit-server generate-keys                          # -> API_KEY / API_SECRET (guardalos)
```

`/etc/livekit/livekit.yaml` (chmod 600). **Puerto UDP único** (7882) para firewall simple,
`use_external_ip` autodetecta la IP pública, y el webhook apunta a StreamHub:

```yaml
port: 7880
bind_addresses: [""]
rtc:
  tcp_port: 7881
  udp_port: 7882
  use_external_ip: true
redis:
  address: localhost:6379
keys:
  <API_KEY>: <API_SECRET>
webhook:
  api_key: <API_KEY>
  urls:
    - http://127.0.0.1:3020/api/v1/webhooks/livekit   # StreamHub recibe los eventos
turn:
  enabled: false
logging:
  level: info
```

systemd (`deploy/livekit.service` → `/etc/systemd/system/livekit.service`), luego
`sudo systemctl enable --now livekit`. Verificá: `curl -s http://localhost:7880` → `OK`.

> **Gotcha:** si el instalador deja `livekit.service` **masked** (symlink a /dev/null), corré
> `systemctl unmask livekit`, escribí el unit como **archivo real** (no con `tee` pipeado a
> `sudo -S`, que pisa el stdin) y `daemon-reload`.

## 3. Docker + Ingress + Egress

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER     # relogin
mkdir -p ~/livekit/recordings
```

`~/livekit/ingress.yaml` y `~/livekit/egress.yaml` = `deploy/ingress.yaml` / `deploy/egress.yaml`
con tus `<API_KEY>/<API_SECRET>`. Correr:

```bash
docker run -d --name ingress --restart unless-stopped --network host \
  -e INGRESS_CONFIG_BODY="$(cat ~/livekit/ingress.yaml)" livekit/ingress:latest

# IMPORTANTE: el egress monta el data dir de StreamHub en el MISMO path (host=container)
# para que el MP4 que escribe quede donde StreamHub lo busca para subir a S3.
docker run -d --name egress --restart unless-stopped --network host --shm-size=1g \
  -e EGRESS_CONFIG_BODY="$(cat ~/livekit/egress.yaml)" \
  -v ~/livekit/recordings:/out \
  -v /home/$USER/streamhub:/home/$USER/streamhub \
  livekit/egress:latest
```

> **RTSP:** LiveKit Ingress **no hace pull RTSP nativo** (`invalid url scheme rtsp`). Se ingesta
> por **relay**: `ffmpeg -rtsp_transport tcp -i rtsp://... -f flv rtmp://<dominio>:1935/live/<key>`.

## 4. StreamHub core (Node / NestJS)

```bash
sudo apt-get install -y build-essential python3   # better-sqlite3 compila nativo
# Node 20 (NodeSource) si no está:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash && sudo apt-get install -y nodejs

mkdir -p /home/$USER/streamhub/{data,apps,logs}
cd /home/$USER && cp -r <repo>/streamhub-core ./streamhub-core && cd streamhub-core
npm ci && npm run build
```

`.env` (ver `streamhub-core/.env.example`):

```
PORT=3020
HOST=127.0.0.1
LIVEKIT_URL=ws://127.0.0.1:7880
LIVEKIT_API_KEY=<API_KEY>
LIVEKIT_API_SECRET=<API_SECRET>
PUBLIC_WS_URL=wss://streamhub.<tu-dominio>     # el player usa esta wss (mismo dominio)
RTMP_PUBLIC_HOST=streamhub.<tu-dominio>
REDIS_URL=redis://localhost:6379
STREAMHUB_JWT_SECRET=<random>
DATA_DIR=/home/<user>/streamhub
ADMIN_USER=admin              # login de la UI
ADMIN_PASS=<pass-fuerte>      # POST /api/v1/auth/login devuelve un JWT
NODE_ENV=production
```

systemd (`deploy/streamhub-core.service`, usa `EnvironmentFile` porque el core lee `process.env`):
`sudo systemctl enable --now streamhub-core`. Health: `curl http://127.0.0.1:3020/api/v1/health`.
El core **sirve la SPA React** (ServeStaticModule) desde `streamhub-core/web/` — ver §5.

**Bootstrap del primer token** (el guard exige token hasta para crear tokens → hay que sembrar
uno directo en la DB; el core la crea en el primer boot):

```bash
TOKEN="sk_$(openssl rand -base64 32 | tr -dc A-Za-z0-9 | head -c 43)"
HASH=$(printf '%s' "$TOKEN" | sha256sum | awk '{print $1}')
node -e "const D=require('/home/$USER/streamhub-core/node_modules/better-sqlite3');\
const db=new D('/home/$USER/streamhub/data/streamhub.db');\
db.prepare(\"INSERT INTO api_tokens(name,token_hash,scope,app_id) VALUES('bootstrap','$HASH','global',NULL)\").run();"
echo "TOKEN GLOBAL: $TOKEN"   # guardalo: es el Bearer de la API y el de la UI
```

## 5. StreamHub UI (React) — la sirve el core, NO hay segundo servicio

La UI es una **SPA React** (Vite + Tailwind v4) que el `streamhub-core` (NestJS) sirve como estáticos.
Se buildea y se copia dentro del core (`streamhub-core/web/`). Sin PHP, sin php-fpm.

```bash
# build de la SPA
cd /home/$USER && cp -r <repo>/streamhub-web ./streamhub-web && cd streamhub-web
npm ci && npm run build          # -> streamhub-web/dist/

# copiar el build adentro del core (lo que sirve ServeStaticModule)
rm -rf /home/$USER/streamhub-core/web
mkdir -p /home/$USER/streamhub-core/web
cp -R /home/$USER/streamhub-web/dist/* /home/$USER/streamhub-core/web/
sudo systemctl restart streamhub-core
```

- El core sirve `web/index.html` para cualquier ruta que **no** empiece con `/api` ni `/rtc`
  (fallback SPA → React Router maneja el routing del cliente).
- **Login:** el form React hace `POST /api/v1/auth/login { user, password }` (valida `ADMIN_USER`/
  `ADMIN_PASS` del `.env`) y recibe un **JWT** (guardado en localStorage). El guard del core acepta
  ese JWT *o* un api_token `sk_`. No hace falta token bootstrap para entrar a la UI.
- **Redeploy de la UI:** solo repetí el build + copia + `systemctl restart streamhub-core`.

## 5b. streamhub-adaptor (SDK) — servido en `/sdk` (wave-4 §3)

Los samples WebRTC publish/play cargan el **streamhub-adaptor** (shim estilo `WebRTCAdaptor`
de AntMedia sobre `livekit-client`) desde `/sdk/streamhub-adaptor.global.js`. El core sirve ese
directorio con un mount estático dedicado (`mountSdkStatic` en `main.ts`), excluido del fallback
SPA igual que `/api`, `/hls` y `/samples`. El dir es `SDK_DIR` y **por defecto es
`<DATA_DIR>/sdk`** (con el layout de §7, `DATA_DIR=/home/$USER/streamhub` → `/home/$USER/streamhub/sdk`).
Si el archivo no existe, `/sdk/...` da 404 y los samples caen a `livekit-client` directo.

```bash
# build del IIFE auto-contenido del adaptor
cd /home/$USER && cp -r <repo>/streamhub-adaptor ./streamhub-adaptor && cd streamhub-adaptor
npm ci && npm run build          # -> streamhub-adaptor/dist/streamhub-adaptor.global.js

# copiar el IIFE al dir que sirve /sdk (SDK_DIR, default <DATA_DIR>/sdk)
mkdir -p /home/$USER/streamhub/sdk
cp /home/$USER/streamhub-adaptor/dist/streamhub-adaptor.global.js /home/$USER/streamhub/sdk/
# verificar: curl -I http://127.0.0.1:3020/sdk/streamhub-adaptor.global.js  -> 200
```

> **Importante:** este copiado del adaptor a `/sdk` es un paso de deploy **aparte** del de la SPA
> (§5). Sin él, el endpoint `/sdk/streamhub-adaptor.global.js` devuelve 404 (no rompe el server, pero
> los samples WebRTC usan el fallback). No requiere reiniciar el core (mount estático de un dir).

**Regenerar samples de las apps existentes:** los templates de samples (wave-4 §3) se renderizan al
**crear** una app. Tras un deploy que cambie los templates, regenerá los de cada app ya existente:

```bash
# por cada app (ej. live): re-renderiza apps/<app>/samples/ desde los templates nuevos
curl -X POST http://127.0.0.1:3020/api/v1/apps/live/samples/regenerate \
  -H "Authorization: Bearer $TOKEN"
```

## 6. nginx — un solo dominio + TLS

vhost (ver `deploy/nginx-streamhub.conf`): **dos locations** — `/rtc`→7880 (signaling LiveKit) y
**todo lo demás**→`127.0.0.1:3020` (NestJS sirve API + SPA). Habilitar + cert:

```bash
sudo ln -s /etc/nginx/sites-available/streamhub.<dominio> /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d streamhub.<dominio> --redirect -m <email> --agree-tos -n
```

```nginx
location /rtc { proxy_pass http://127.0.0.1:7880; proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";
  proxy_set_header Host $host; proxy_read_timeout 86400s; }
location /    { proxy_pass http://127.0.0.1:3020; proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";
  proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme; proxy_read_timeout 86400s; }
```

> **plain-server / SSL:** en un deploy **plain-server** la TLS la manejan **nginx + certbot**
> propios. certbot deja su `certbot.timer` para renovar. Verificá: `systemctl list-timers | grep certbot`.
>
> Como nginx ahora sólo **proxea** a Node (no sirve archivos del `/home`), desaparece el gotcha de
> permisos `0750`/`File not found` que aplicaba con php-fpm.

## 7. Configurar una app (S3 + grabación)

El core siembra la app por defecto `live`. Cada app vive en
`/home/<user>/streamhub/apps/<name>/{config.yaml, vods.db, recordings/, snapshots/, samples/}`.

**S3 por app** (AWS/Wasabi/MinIO). Las credenciales **no** van al yaml: van a
`data/secrets.json` (chmod 600) referenciadas por `APP_<NAME>_S3_KEY/SECRET`.

```bash
# config.yaml: setear bucket (provider/endpoint/region ya vienen por default)
# secrets.json (refs que apunta el yaml):
echo '{"APP_LIVE_S3_KEY":"<key>","APP_LIVE_S3_SECRET":"<secret>"}' \
  > /home/$USER/streamhub/data/secrets.json && chmod 600 /home/$USER/streamhub/data/secrets.json
sudo systemctl restart streamhub-core
```

> Hoy **no hay endpoint API** para setear el bloque S3/secrets de una app (se edita a mano). Es un
> pendiente conocido (wave-3). El resto del ciclo de la app sí es por API (crear app, tokens, ingress,
> recording, vods…); ver `streamhub-docs/api-app.md`.

**Flujo de grabación:** `POST /api/v1/apps/<app>/recording/start {roomName}` → egress room-composite
→ MP4 local en `apps/<app>/recordings/` → webhook `egress_ended` → sube a S3 → borra local → VOD
`ready` en `vods.db` + snapshot. (Verificado: 2 participantes → MP4 **H.264 720p** + JPG a S3, local borrado.)

> **Gotcha webhook:** LiveKit postea con content-type `application/webhook+json`; si el body parser no
> lo captura, `req.rawBody` queda vacío y la firma se rechaza (401). El core lo resuelve con
> `app.useBodyParser('json', { type: ['application/json','application/webhook+json'] })` en `main.ts`.

## 8. Verificación

```bash
curl https://streamhub.<dominio>/api/v1/health                       # {"status":"ok",...}
curl -H "Authorization: Bearer <TOKEN>" https://streamhub.<dominio>/api/v1/stats
lk load-test --url wss://streamhub.<dominio> --room t --video-publishers 1 --subscribers 2 --duration 12s
# UI: https://streamhub.<dominio>  (login admin / ADMIN_PASS) · Swagger: /api/v1/docs
```

## 9. Checklist instancia nueva (1 dominio)

1. DNS `A streamhub.<dominio> → IP` (DNS-only).
2. Firewall: 80,443,7880,7881,7882/udp,1935,3478/udp.
3. LiveKit (redis + server + keys + ingress + egress con el mount de streamhub).
4. StreamHub core (build + .env con ADMIN_USER/PASS + systemd + token bootstrap).
5. Build de la SPA React (`streamhub-web`) y copiarla a `streamhub-core/web/` (sin PHP).
6. nginx 1 dominio + certbot (`/rtc`→LiveKit, `/`→core).
7. Config S3 por app + restart core.
8. Verificar health/login/UI/WebRTC/grabación.
