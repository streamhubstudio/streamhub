# Instalación manual (bare-metal): LiveKit + StreamHub (un solo dominio)

Runbook para levantar una instancia nueva desde cero **sin Docker para el core**: el **media
server LiveKit** (SFU + Ingress RTMP/WHIP + Egress/grabación) y **StreamHub** (la capa de gestión
estilo AntMedia: el **core Go** — un binario estático, `streamhub-core` — que sirve también la SPA
React, el SDK y el HLS), todo detrás de **un único dominio**.

> **Atajos:** si no necesitás el detalle a mano, usá el instalador de una línea
> ([operations/INSTALL-NODE](https://streamhub.studio/docs/operations/INSTALL-NODE), forma
> Docker Compose + Caddy). Este archivo es la forma **systemd + nginx + certbot**; la referencia
> canónica en inglés es [`DEPLOY.md §B`](https://streamhub.studio/docs/operations/DEPLOY#b-systemd--nginx--certbot-plain-server)
> y el build paso a paso está en
> [`MANUAL-BUILD-INSTALL.md`](https://streamhub.studio/docs/operations/MANUAL-BUILD-INSTALL). Detalle de la API en
> `https://streamhub.studio/docs/`; spec del producto en `https://streamhub.studio/docs/SPEC`.

## 0. Arquitectura (un dominio)

```
                 streamhub.<tu-dominio>  (nginx + TLS, 1 cert)
   ┌──────────────────────────────────────────────────────────────────────┐
   │  location /rtc   → 127.0.0.1:7880   LiveKit signaling (wss, WebRTC)    │
   │  location /      → 127.0.0.1:3020   streamhub-core (Go): API + SPA     │
   └──────────────────────────────────────────────────────────────────────┘
        media WebRTC (UDP 7882) y RTMP (1935) van DIRECTO a la IP del server
   ┌──────────────────────────────────────────────────────────────────────┐
   │ livekit-server (systemd)   7880 ws/api · 7881 tcp · 7882/udp media     │
   │ redis (systemd)            coordina ingress/egress de LiveKit          │
   │ livekit/ingress (docker)   1935 RTMP · 8080 WHIP                       │
   │ livekit/egress  (docker)   grabación room-composite → archivo local    │
   │ streamhub-core (systemd)   127.0.0.1:3020  API + SPA + /sdk + /hls     │
   │                            + login JWT + jobs in-process + SQLite + S3 │
   └──────────────────────────────────────────────────────────────────────┘
```

Todo el media transport (UDP/RTMP) va por IP; el dominio sólo cubre la página, la API y el
signaling (wss). Por eso con **un** registro DNS A `streamhub... → IP` alcanza para una instancia.

> Los jobs del core (subidas a S3, transcodes, Streamflow, cron de métricas) corren **in-process**
> en el binario Go; Redis sólo lo usa LiveKit. Ver internal design notes para lo que eso
> cambia respecto del core 2.x (Node/BullMQ).

## 1. Prerrequisitos

- Ubuntu 24.04/26.04 o Debian 12 (bookworm) / 13 (trixie), x86_64, root o usuario con sudo (ej. `ploi`). IP pública.
- 1 registro DNS: `A  streamhub.<tu-dominio>  →  <IP>`  (**DNS-only**, sin proxy Cloudflare:
  el media WebRTC es UDP y no pasa por proxies HTTP).
- Puertos a abrir en el firewall: **80, 443, 7880/tcp, 7881/tcp, 7882/udp, 1935/tcp, 3478/udp**.
  (En Ploi: network-rules con `type=tcp|udp`. Manual: `ufw allow <puerto>/<proto>`.)

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

## 4. StreamHub core (Go) — bundle nativo

El core es **un binario estático** (sin Node, sin npm, sin compilar nada en el server). El artefacto
de deploy es el **bundle nativo**: `streamhub-core-<ver>-linux-amd64.tar.gz` con el binario, la SPA
(`web/`), el SDK del browser, las apps desacopladas compuestas (`plugins-vendor/`) y `VERSION`.

**Del lado del build** (una máquina con `go` 1.26+ y node/npm — Node sólo para buildear la SPA y el
SDK; ver [`MANUAL-BUILD-INSTALL.md §3a`](https://streamhub.studio/docs/operations/MANUAL-BUILD-INSTALL)):

```bash
# opcional: componer las Studio Apps desacopladas (necesita STREAMHUB_APPS_TOKEN)
(cd streamhub-core-go && go run ./cmd/streamhub apps pull)
deploy/make-core-bundle.sh            # → dist/streamhub-core-<ver>-linux-amd64.tar.gz
scp dist/streamhub-core-*-linux-amd64.tar.gz deploy/deploy-core.sh deploy/backup.sh <user>@<host>:/tmp/
```

**En el server:**

```bash
sudo apt-get install -y ffmpeg python3 python3-venv   # herramientas de media + workers Python de las apps
mkdir -p /home/$USER/streamhub/{data,apps,logs}       # DATA_DIR
mkdir -p /home/$USER/streamhub-core                   # APP_DIR (binario + web/ + .env)
```

`.env` en `APP_DIR` (todas las variables comentadas en `.env.example`; referencia completa en
[operations/ENV](https://streamhub.studio/docs/operations/ENV)):

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
STREAMHUB_API_TOKEN=sk_<random>                # token global de la API (se siembra abajo)
DATA_DIR=/home/<user>/streamhub
ADMIN_USER=admin              # login de la UI
ADMIN_PASS=<pass-fuerte>      # POST /api/v1/auth/login devuelve un JWT
```

Unit systemd: `deploy/streamhub-core.service` → `/etc/systemd/system/` (ajustá `User`, `APP_DIR`;
`ExecStart=<APP_DIR>/streamhub-core`, `EnvironmentFile=<APP_DIR>/.env`, `UMask=0002` porque core y
egress comparten `DATA_DIR`). Después instalá el bundle con **`deploy/deploy-core.sh`** — el mismo
script sirve para la primera instalación y para cada upgrade:

```bash
sudo systemctl daemon-reload
sudo APP_DIR=/home/$USER/streamhub-core SERVICE_NAME=streamhub-core \
  /tmp/deploy-core.sh /tmp/streamhub-core-<ver>-linux-amd64.tar.gz
```

Exige que `APP_DIR/.env` exista (nunca inventa secretos), hace backup, instala binario + `web/` +
`plugins-vendor/`, publica el SDK en `<DATA_DIR>/sdk`, arma el venv de los workers Python, escribe
el drop-in systemd y reinicia esperando `/api/v1/health`. Detalle de cada paso, `WORKER_DEPS` y
rollback: [`DEPLOY.md §B.7`](https://streamhub.studio/docs/operations/DEPLOY#b7-redeploys--deploydeploy-coresh-secure-no-hardcoded-secrets).

Health: `curl http://127.0.0.1:3020/api/v1/health`. Las migraciones SQLite corren solas al boot
(idempotentes, con backup `VACUUM INTO`).

**Bootstrap del primer token** (el guard exige token hasta para crear tokens → se siembra con el
propio binario; idempotente):

```bash
cd /home/$USER/streamhub-core
grep '^STREAMHUB_API_TOKEN=' .env | cut -d= -f2 | \
  DATA_DIR=/home/$USER/streamhub ./streamhub-core seed-token - bootstrap
```

Ese `sk_` es el Bearer de la API. Para entrar a la UI alcanza con `ADMIN_USER`/`ADMIN_PASS`.

> **Alternativa Docker:** todo lo de §2–§5 (LiveKit, ingress, egress, redis, core, TLS con Caddy) en
> un `docker compose up -d --build` — ver [`MANUAL-BUILD-INSTALL.md`](https://streamhub.studio/docs/operations/MANUAL-BUILD-INSTALL)
> y [`DEPLOY.md §A`](https://streamhub.studio/docs/operations/DEPLOY#a-docker-compose--caddy-recommended).

## 5. StreamHub UI (React) y SDK — vienen en el bundle

No hay segundo servicio ni PHP: la **SPA React** (Vite + Tailwind v4) viaja en el bundle como
`web/` junto al binario y el core la sirve como estáticos (`WEB_DIR` la sobreescribe).

- El core sirve `web/index.html` para cualquier ruta que **no** sea `/api`, `/hls`, `/sdk`,
  `/samples` ni `/metrics` (fallback SPA → React Router maneja el routing del cliente).
- **Login:** el form React hace `POST /api/v1/auth/login { user, password }` (valida `ADMIN_USER`/
  `ADMIN_PASS` del `.env`) y recibe un **JWT**. El guard del core acepta ese JWT *o* un api_token `sk_`.
- **Redeploy de la UI:** es un redeploy del core (nuevo bundle + `deploy-core.sh`).

El **streamhub-adaptor** (shim estilo `WebRTCAdaptor` de AntMedia sobre `livekit-client`) se sirve
en `/sdk/streamhub-adaptor.global.js` desde `SDK_DIR` (default `<DATA_DIR>/sdk`); `deploy-core.sh`
lo publica ahí en cada deploy. Si falta, `/sdk/...` da 404 y los samples caen a `livekit-client`
directo. Verificá: `curl -I http://127.0.0.1:3020/sdk/streamhub-adaptor.global.js` → 200.

**Regenerar samples de las apps existentes:** los templates de samples se renderizan al **crear**
una app. Tras un deploy que cambie los templates, regenerá los de cada app ya existente:

```bash
curl -X POST http://127.0.0.1:3020/api/v1/apps/live/samples/regenerate \
  -H "Authorization: Bearer $TOKEN"
```

## 6. nginx — un solo dominio + TLS

vhost: `deploy/nginx-streamhub.conf` — `/rtc`→7880 (signaling LiveKit), **todo lo demás**→
`127.0.0.1:3020` (el core Go sirve API + SPA + HLS + SDK), y `/metrics` denegado desde afuera.
Habilitar + cert:

```bash
sudo cp deploy/nginx-streamhub.conf /etc/nginx/sites-available/streamhub.<dominio>
sudo ln -s /etc/nginx/sites-available/streamhub.<dominio> /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d streamhub.<dominio> --redirect -m <email> --agree-tos -n
```

> **plain-server / SSL:** en un Ploi **plain-server** NO hay sites/SSL gestionados por Ploi, así que
> se usa **nginx + certbot** propios. certbot deja su `certbot.timer` para renovar. Verificá:
> `systemctl list-timers | grep certbot`. En un server con sitios gestionados por Ploi, dejá que
> Ploi maneje nginx/SSL y sólo apuntá el proxy a `127.0.0.1:3020` + `/rtc`.

## 7. Configurar una app (S3 + grabación)

El core siembra la app por defecto `live`. Cada app vive en
`/home/<user>/streamhub/apps/<name>/{config.yaml, app.db, recordings/, snapshots/, samples/}`.

**S3 por app** (AWS/Wasabi/MinIO). Las credenciales **no** van al yaml: van a
`data/secrets.json` (chmod 600) referenciadas desde el `config.yaml` de la app. Se setean por API
(`PUT /api/v1/apps/<app>/s3`, permiso `s3:write`) o desde la pestaña Config del dashboard; ver
`https://streamhub.studio/docs/api-app` y `https://streamhub.studio/docs/config-reference`.

**Flujo de grabación:** `POST /api/v1/apps/<app>/recording/start {roomName}` → egress room-composite
→ MP4 local en `apps/<app>/recordings/` → webhook `egress_ended` → sube a S3 → borra local → VOD
`ready` en `app.db` + snapshot. (Verificado: 2 participantes → MP4 **H.264 720p** + JPG a S3, local borrado.)

> **Webhook de LiveKit:** LiveKit postea con content-type `application/webhook+json`; el core
> verifica la firma sobre el body crudo para ambos content-types (`streamhub-core-go/internal/livekit/webhooks.go`)
> y rechaza los webhooks si `LIVEKIT_API_SECRET` está vacío.

## 8. Verificación

```bash
curl https://streamhub.<dominio>/api/v1/health                       # {"status":"ok",...}
curl -H "Authorization: Bearer <TOKEN>" https://streamhub.<dominio>/api/v1/stats
lk load-test --url wss://streamhub.<dominio> --room t --video-publishers 1 --subscribers 2 --duration 12s
# UI: https://streamhub.<dominio>  (login admin / ADMIN_PASS) · Swagger: /api/v1/docs
```

Runbook de operación (logs, restart, rollback): [operations/RUNBOOK](https://streamhub.studio/docs/operations/RUNBOOK).

## 9. Checklist instancia nueva (1 dominio)

1. DNS `A streamhub.<dominio> → IP` (DNS-only).
2. Firewall: 80,443,7880,7881,7882/udp,1935,3478/udp.
3. LiveKit (redis + server + keys + ingress + egress con el mount de `DATA_DIR`).
4. Bundle del core (`deploy/make-core-bundle.sh`) + `.env` (ADMIN_USER/PASS, JWT secret, API token)
   + unit systemd + `deploy/deploy-core.sh` + `seed-token`.
5. nginx 1 dominio + certbot (`/rtc`→LiveKit, `/`→core).
6. Config S3 por app (`PUT /apps/<app>/s3` o dashboard).
7. Verificar health/login/UI/WebRTC/grabación.
