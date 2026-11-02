# StreamHub Encoder

Encoder de video en vivo por software para Linux, pensado para reemplazar un **Heynen / Media Excel HERO HEVC Encoder
5000E** y para alimentar **StreamHub** o cualquier otro media server (Wowza, Ant Media, nginx-rtmp, MediaMTX, YouTube,
Twitch, AWS MediaLive/MediaConnect, IRD/headends por UDP multicast).

- **Entradas:** SDI/HDMI (Blackmagic DeckLink), HDMI-USB/UVC y Magewell (V4L2), SRT (caller/listener), UDP/RTP-TS
  (incl. multicast), RTMP, RTSP, archivo (en loop sin cortes: `ffmpeg -stream_loop` alimenta el engine por stdin, con
  timestamps continuos) y patrón de prueba con tono. **Failover** primaria → backup → slate.
- **Encode:** H.264 y HEVC con x264, x265, **NVENC** (validado en RTX 3090), QSV y VA-API (seleccionables cuando están);
  CBR / VBR con tope, GOP, B-frames, baja latencia, 1080i (PAFF en x264) o desentrelazado, hasta 4K con HW.
  Audio AAC-LC 1/2/5.1/7.1 con mapeo de los 8/16 canales embebidos de SDI; Opus automático para WHIP.
- **Salidas simultáneas por canal, en caliente:** SRT (caller/listener/rendezvous, passphrase, streamid), RTMP/RTMPS
  (Enhanced RTMP para HEVC), UDP/RTP MPEG-TS (multicast, TTL, interfaz), WHIP, HLS push (HTTP PUT), grabación TS.
  Agregar, quitar o editar una salida **no corta** el encode ni las otras salidas.
- **Operación:** API REST (`/api/v1`, OpenAPI en `/api/v1/docs`), UI web embebida, métricas Prometheus (`/metrics`),
  presets de encode y de destino, config persistente con backup/restore, supervisor con reinicio automático y watchdog.
- **StreamHub:** modo "funciona hoy" (token `sk_` de la app → el encoder crea el ingress y publica) y modo **nativo**
  (código de emparejamiento + WebSocket saliente; ver [docs/PAIRING.md](docs/PAIRING.md)).
- **Profesional (más allá del 5000E):** HEVC **Main10** y **4:2:2 10-bit**, **HDR HLG / PQ-HDR10** (mastering display +
  MaxCLL), **2160p30** en beta (NVENC; 2160p60 con un issue abierto), **escalera ABR** (N renditions con GOP alineado, HLS master), **pistas de audio**
  con idioma (AAC/AC-3/MP2, hasta 16 canales SDI mapeables), **SCTE-35 por API**, **RIST** con bonding, **timecode en
  SEI**, logo con alfa, **grabación rotativa**, **monitoreo de confianza** (miniaturas, EBU R128, picos) con **alarmas**
  (pérdida de entrada, negro, congelado, silencio, bitrate, loudness, engine/salida caída) a **webhooks y traps SNMP
  v2c/v3**, **HTTPS + usuarios con roles + tokens + auditoría**, estado NTP/PTP. Comparación: [docs/VS-HERO-5000E.md](docs/VS-HERO-5000E.md).

Resultados de las pruebas sintéticas y reales: **[docs/TEST-REPORT.md](docs/TEST-REPORT.md)**.
**Beta / no soportado todavía:** 2160p (NVENC 4K30 en el límite del tiempo real con la conversión en CPU; 4K60 con
issue abierto), HEVC por SRT leído desde MediaMTX, escalera ABR con CMAF, RIST bonding, passthrough de CEA-608/708 (no funciona), SCTE-35 y
AC-3 passthrough desde la entrada, normalización de loudness (solo medición), Dolby E, ASI, NDI, ST 2110, NMOS, QSV/VA-API
sin validar en hardware. Pendiente para producción: soak de 24 h (hasta ahora 8.8 h limpias, ver
[docs/TEST-REPORT.md](docs/TEST-REPORT.md) §6) y aceptación con una DeckLink
real; la salida HEVC por Enhanced RTMP puede reiniciarse una vez al arrancar (se recupera en 1 s).
Guía del operador: [docs/OPERATOR-GUIDE.md](docs/OPERATOR-GUIDE.md). Licencias y patentes: [docs/LICENSING.md](docs/LICENSING.md).
Aceptación con hardware SDI/HDMI: [docs/HARDWARE-ACCEPTANCE.md](docs/HARDWARE-ACCEPTANCE.md).

## Arquitectura

```
                       encoderd (Go, estático, sin cgo) — REST · UI · /metrics · presets · config · StreamHub
                          │ supervisa procesos (backoff, watchdog, logs)
  entrada ──▶ ENGINE (gst-launch-1.0, 1 por canal) ──UDP loopback──▶ BUS TS (encoderd: fan-out + análisis)
  SDI/HDMI/IP/archivo   fallbacksrc/fallbackswitch → desentrelazado →     │  bitrate · fps · CC · deriva PCR
  /test                 escala → timecode → x264/x265/NVENC → mpegtsmux   ├──▶ salida SRT     (gst srtsink)
                                                                          ├──▶ salida RTMP    (gst rtmp2sink)
                                                                          ├──▶ salida UDP/RTP (gst udpsink)
                                                                          ├──▶ salida WHIP    (encoderd whip-push: gst → RTP → pion)
                                                                          ├──▶ salida HLS     (ffmpeg -method PUT)
                                                                          └──▶ salida archivo (gst filesink)
```

Cada salida es un proceso aparte que lee su copia del TS: una salida que se cae (destino caído, red) se reconecta sola
sin afectar a las demás, y agregar/quitar salidas no toca el encoder. Por qué `gst-launch-1.0` y no `go-gst`: ver
`planning/SOFTWARE-ENCODER-PLAN.md` §11.

## Instalación

### Paquete Debian (Ubuntu 24.04+/26.04, Debian 13)

```bash
deploy/build-deb.sh 0.0.1~beta            # en cualquier host con Docker → dist/streamhub-encoder_0.0.1~beta_amd64.deb
sudo apt install ./dist/streamhub-encoder_0.0.1~beta_amd64.deb
sudo encoderd token                       # token de automatización (rol admin) para la API
sudo cat /var/lib/streamhub-encoder/initial-admin-password   # clave inicial de "admin"
xdg-open https://<host>:8090/             # UI: login admin, cambio de clave obligatorio (cert autofirmado)
```

El paquete instala `/usr/bin/encoderd`, la unit `encoderd.service` (usuario `encoder`, grupos `video audio render`),
`/etc/default/streamhub-encoder` y `/etc/sysctl.d/99-streamhub-encoder.conf` (buffers UDP). Necesita
`gstreamer1.0-fallbackswitch` (Ubuntu ≥ 25.04 / Debian 13; en Ubuntu 24.04 compilar gst-plugins-rs `fallbackswitch`).
NVENC: driver NVIDIA instalado. DeckLink: Blackmagic Desktop Video (lo instala el usuario).

### Docker

```bash
docker build -f deploy/Dockerfile -t streamhub-encoder:0.0.1-beta .          # contexto: streamhub-encoder/
# --runtime nvidia --gpus all → NVENC (opcional); --device … → captura (opcional)
docker run -d --name encoder --restart unless-stopped --network host \
  -v encoder-data:/var/lib/streamhub-encoder -e ENCODERD_API_TOKEN=<token> \
  --runtime nvidia --gpus all \
  --device /dev/blackmagic --device /dev/video0 \
  streamhub-encoder:0.0.1-beta
```

`--network host` es lo recomendado (multicast, SRT listener, puertos dinámicos). Para entradas solo IP también funciona
en bridge publicando los puertos de los listeners.

### Variables de entorno

| Variable | Default | Qué hace |
|---|---|---|
| `ENCODERD_LISTEN` | `:8090` | API + UI + `/metrics` |
| `ENCODERD_DATA_DIR` | `/var/lib/streamhub-encoder` | `encoderd.json` (config, 0600, con `.bak`) y `api-token` |
| `ENCODERD_API_TOKEN` | generado (`ek_…`) | token "legacy" con rol admin (automatización); los usuarios y tokens con rol se gestionan en `/api/v1/users` y `/api/v1/tokens` |
| `ENCODERD_TLS` | `auto` | `auto` = HTTPS con certificado autofirmado (`<data>/tls/`) o el de `ENCODERD_TLS_CERT`/`ENCODERD_TLS_KEY`; `off` = HTTP |
| `ENCODERD_TLS_HOSTS` | — | nombres/IPs extra para el certificado autofirmado |
| `ENCODERD_TRUSTED_PROXIES` | — | IPs/CIDR cuyo `X-Forwarded-For` se usa en la auditoría |
| `ENCODERD_PORT_RANGE` | `41000-41999` | puertos UDP loopback del bus (1 por canal + 1 por salida) |
| `ENCODERD_METRICS_PUBLIC` | `true` | `/metrics` sin token |
| `ENCODERD_ALLOW_REBOOT` | `false` | permite el comando `reboot` desde StreamHub |
| `ENCODERD_GST_LAUNCH` / `_GST_INSPECT` / `ENCODERD_FFMPEG` | del PATH | binarios |
| `ENCODERD_LOG_LEVEL` | `info` | `debug` |

`SIGHUP` vuelve a sondear las capacidades del host (p. ej. tras instalar el driver NVIDIA) y reconcilia los canales.

## Uso rápido (API)

```bash
T=$(sudo encoderd token); A=(-H "Authorization: Bearer $T" -H 'Content-Type: application/json')
# canal: barras + tono, HEVC 1080p25 4 Mbps, timecode quemado
curl -s "${A[@]}" -X POST localhost:8090/api/v1/channels -d '{
  "id":"ch1","enabled":true,"input":{"type":"test"},"overlay":{"timecode":true},
  "video":{"codec":"h265","width":1920,"height":1080,"fps":"25","bitrateKbps":4000}}'
# salida SRT a MediaMTX por preset (en caliente)
curl -s "${A[@]}" -X POST localhost:8090/api/v1/channels/ch1/outputs -d '{"preset":"mediamtx-srt","params":{"host":"10.0.0.5","path":"cam1"}}'
# salida a StreamHub (crea el ingress con el token de la app)
curl -s "${A[@]}" -X POST localhost:8090/api/v1/channels/ch1/outputs -d '{"id":"sh","type":"streamhub","enabled":true,
  "streamhub":{"baseUrl":"https://streamhub.example.com","app":"live","token":"sk_…","protocol":"rtmp"}}'
curl -s "${A[@]}" localhost:8090/api/v1/channels/ch1/status | jq '{state, stats, outputs:[.outputs[]|{id,state,error}]}'
curl -s "${A[@]}" localhost:8090/api/v1/channels/ch1/pipeline | jq .     # comandos exactos que corre
```

### Endpoints

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/v1/health` | liveness (sin token) |
| GET | `/api/v1/system`, `/api/v1/system/capabilities` | host, versión; encoders/elementos/dispositivos/GPUs disponibles |
| GET, POST | `/api/v1/channels` | listar (config + estado) / crear |
| GET, PUT, PATCH, DELETE | `/api/v1/channels/{id}` | leer / reemplazar / merge-patch (RFC 7386) / borrar. Cambios solo de salidas se aplican en caliente |
| POST | `/api/v1/channels/{id}/start`, `/stop`, `/restart` | estado deseado (persistido) / reinicio del engine |
| GET | `/api/v1/channels/{id}/status` | estado, análisis del TS (fps, bitrate, CC, deriva PCR), procesos (RSS/CPU/fds), salidas |
| GET | `/api/v1/channels/{id}/logs?proc=engine\|<salida>` | últimas líneas del proceso |
| GET | `/api/v1/channels/{id}/pipeline` | dry-run: comandos exactos de engine y salidas |
| POST | `/api/v1/channels/{id}/profile` | aplicar un perfil de encode `{"profile":"hevc-1080p25-4m-calidad"}` |
| POST | `/api/v1/channels/{id}/outputs` | agregar salida (JSON literal o `{"preset","params","id"}`); devuelve `warnings` de compatibilidad |
| PUT, DELETE | `/api/v1/channels/{id}/outputs/{oid}` | reemplazar / quitar una salida (solo esa se toca) |
| POST | `/api/v1/channels/{id}/outputs/{oid}/restart` | reconectar una salida |
| GET | `/api/v1/presets` | perfiles de encode y destinos (Wowza, Ant Media, nginx-rtmp, MediaMTX, YouTube, Twitch, Facebook, AWS, Haivision, SRT/UDP/RTP genéricos, IRD, HLS, StreamHub) |
| GET, PUT | `/api/v1/config/backup` | exportar / importar toda la config (los secretos van como `***`: ver abajo) |
| GET | `/api/v1/streamhub` | estado del emparejamiento nativo |
| POST | `/api/v1/streamhub/pair`, `/api/v1/streamhub/unpair` | emparejar (`{"baseUrl"}` → código) / desemparejar |
| GET | `/metrics` | Prometheus |
| POST | `/api/v1/channels/{id}/scte35` | cue SCTE-35 `{kind: splice_insert\|time_signal\|splice_null, eventId?, outOfNetwork, immediate, preRollMs, durationMs, segmentationTypeId}` (operador; requiere `scte35.enabled`) |
| GET | `/api/v1/channels/{id}/thumbnail.jpg` | miniatura de confianza (2 fps, 320×180) |
| POST | `/api/v1/channels/{id}/loudness/reset` | reinicia la medición integrada R128 (operador) |
| GET, POST | `/api/v1/alarms`, `/api/v1/alarms/{id}/ack` | alarmas activas + historial; ack (operador) |
| GET, PUT, POST | `/api/v1/notify`, `/api/v1/notify/test` | destinos de alarmas: webhooks firmados HMAC y traps SNMP v2c/v3 (admin) |
| GET | `/api/v1/system/time` | sincronismo del reloj (adjtimex: NTP/PTP) |
| POST | `/api/v1/auth/login`, `/logout`, `/password`; GET `/api/v1/auth/me` | sesión de la UI (cookie; header `X-Requested-With: encoder-ui` en mutaciones) |
| GET, POST, PATCH, DELETE | `/api/v1/users[/{name}]`, `/api/v1/tokens[/{id}]`, GET `/api/v1/audit` | usuarios (admin/operator/viewer), tokens con rol, auditoría (admin) |

Roles: **viewer** lee todo menos usuarios/tokens/auditoría/backup/notify; **operator** además inicia/detiene/reinicia
canales, reconecta salidas, inserta SCTE-35 y hace ack de alarmas; **admin** todo lo demás. En el primer arranque se crea
`admin` con una clave aleatoria en `<data>/initial-admin-password` (hay que cambiarla al entrar).

Errores de validación → `422` con `errors[].location` = campo (`video.bitrateKbps`, `outputs[1].srt.passphrase`, …).
**Secretos (solo escritura):** passphrases SRT (salidas y `passphrase=` en la URI de entradas SRT), contraseñas en URLs
(`rtmp://user:pass@…`, `https://user:pass@…`), stream keys de URLs RTMP/RTMPS (último segmento), parámetros
`token`/`key`/`passphrase`/… de las URLs, bearer de WHIP, token `sk_` y stream key resuelta de StreamHub, credencial
del dispositivo, `secret` de webhooks y comunidad/`authPass`/`privPass` SNMP se devuelven como `***` en la API, la UI,
`/pipeline`, el estado y los logs de procesos, las alarmas, los webhooks y el backup. Un PUT/PATCH que manda `***`
conserva el valor guardado **solo si el destino no cambió** (mismo id de salida y misma URL/host); si cambia el destino
o no hay valor guardado, el `***` se rechaza con `422` ("re-enter"). `GET /config/backup` exporta `***`: restaurarlo en
el mismo equipo conserva los secretos; en otro equipo hay que completarlos en el JSON antes del `PUT`.

### Modelo de canal (resumen)

```jsonc
{
  "id": "ch1", "name": "SDI 1", "enabled": true,
  "input":  {"type": "decklink|v4l2|srt|udp|rtmp|rtsp|file|test", "uri": "...", "timeoutMs": 2000, ...},
  "backup": {"type": "udp", "uri": "udp://239.1.1.1:5000"},          // failover (entradas URI)
  "video":  {"codec": "h264|h265", "encoder": "auto|x264|x265|nvenc|qsv|vaapi", "width": 1920, "height": 1080,
             "fps": "25|29.97|30|50|59.94|60|...", "interlaced": false, "deinterlace": true,
             "bitrateKbps": 4000, "rateControl": "cbr|vbr", "maxBitrateKbps": 6000, "gop": 50, "bframes": 2,
             "profile": "high|main|baseline", "preset": "veryfast|p4|...", "lowLatency": false, "gpu": 0},
  "audio":  {"channels": 2, "bitrateKbps": 128, "map": [0, 1], "gainDb": 0, "disabled": false},
  "overlay":{"timecode": true, "clock": false, "text": "CAM 1"},
  "mux":    {"videoPid": 256, "audioPid": 257, "pcrIntervalMs": 20, "muxRateKbps": 0},
  "outputs":[{"id": "srt1", "type": "srt|rtmp|udp|rtp|whip|hls|file|streamhub", "enabled": true, "url": "...",
              "srt": {"mode": "caller", "latencyMs": 200, "passphrase": "...", "streamId": "..."}, ...}]
}
```

## Desarrollo y pruebas

**No se compila ni corre en macOS**: todo va en contenedores en un host Linux (el .50).

```bash
test/unit.sh                       # gofmt + vet + go test -race ./... (golang:1.26, sin red ni GStreamer)
test/unit.sh -update               # regenera los goldens de pipelines tras un cambio intencional
test/e2e/run.sh                    # e2e sintético: formats outputs hotswap failover crash latency netem
REAL_MEDIA=~/clip.mp4 test/e2e/run.sh formats density      # densidad con un clip real
SOAK_MIN=60 test/e2e/run.sh soak   # soak
ONLY='nvenc' test/e2e/run.sh formats latency                # subconjunto de casos
test/real/streamhub-real.sh up && test/real/streamhub-real.sh today && test/real/streamhub-real.sh down
```

Resultados en `test/e2e/results/<run>/summary.tsv` y `test/real/results/<run>/`.
