# Changelog — StreamHub Encoder

Versiones del encoder (`encoderd` + engine GStreamer), independientes de la del core de StreamHub.
Versión Debian: `0.0.1~beta` se ordena antes de una futura `0.0.1`.

## 0.0.1~beta — 2026-10-30

Primera beta pública. **No apta para producción todavía**: sirve para probar el encoder en un laboratorio o en una
cadena de prueba y reportar problemas.

### Se distribuye

- **Solo el paquete Debian** `streamhub-encoder_0.0.1~beta_amd64.deb` (amd64) + `SHA256SUMS`. Trae únicamente el
  binario `encoderd` (Go estático, sin cgo), la unit de systemd, `/etc/default/streamhub-encoder`, el sysctl de
  buffers UDP y la documentación; GStreamer, x264, x265 y FFmpeg salen de los paquetes de la distro (ver
  [docs/LICENSING.md](docs/LICENSING.md)).
- **No se publica imagen Docker** en esta beta: llevaría x264/x265 (GPL) dentro de la imagen. `deploy/Dockerfile`
  sigue sirviendo para construirla localmente.

### Requisitos

- Ubuntu 26.04, Ubuntu 24.04+ o Debian 13, amd64. Necesita `gstreamer1.0-fallbackswitch` (Ubuntu ≥ 25.04 /
  Debian 13; en 24.04 hay que compilar `fallbackswitch` de gst-plugins-rs).
- Opcional: GPU NVIDIA con su driver (NVENC). Opcional y **sin validar con hardware real**: Blackmagic DeckLink con
  Desktop Video (SDI/HDMI).
- Instalación: `sudo apt install ./streamhub-encoder_0.0.1~beta_amd64.deb`; UI en `https://<host>:8090/`
  (certificado autofirmado; clave inicial de `admin` en `/var/lib/streamhub-encoder/initial-admin-password`).

### Incluye (probado en el banco, ver [docs/TEST-REPORT.md](docs/TEST-REPORT.md))

- Entradas: patrón de prueba con tono, archivo en loop sin cortes, SRT (caller/listener), UDP/RTP-TS (multicast),
  RTMP, RTSP; failover primaria → backup → slate.
- Encode H.264 / HEVC con x264, x265 y NVENC; CBR/VBR, GOP, B-frames, baja latencia; HEVC Main10 y HDR HLG/PQ;
  AAC-LC 1/2/5.1/7.1 y pistas de audio con idioma.
- Salidas simultáneas por canal, editables en caliente: SRT (con AES), RTMP/RTMPS (Enhanced RTMP para HEVC), UDP/RTP
  MPEG-TS (multicast), WHIP, HLS push, grabación TS y grabación rotativa.
- Operación: UI web embebida, API REST con OpenAPI (`/api/v1/docs`), métricas Prometheus, presets de encode y de
  destino, backup/restore de la config, supervisor con watchdog.
- Monitoreo de confianza (miniaturas, EBU R128, picos) con alarmas a webhooks y traps SNMP; HTTPS por defecto,
  usuarios con roles, tokens y auditoría.
- SCTE-35 por API (viaja en el TS por SRT/UDP/RTP), timecode en SEI (x264), RIST Simple Profile.
- StreamHub: modo "funciona hoy" (token `sk_` de la app, RTMP/WHIP) o salida RTMP/SRT a cualquier servidor.

### Seguridad

- Los secretos ya no salen por la API, la UI, los logs/comandos expuestos, las alarmas ni los webhooks: passphrases
  SRT (salidas y `passphrase=` de entradas SRT), contraseñas en URLs, stream keys RTMP, tokens WHIP y de StreamHub,
  secretos de webhooks y comunidades/claves SNMP se leen como `***`; un PUT/PATCH con `***` conserva el valor guardado
  mientras el destino no cambie. `GET /config/backup` exporta `***` y el restore en otro equipo pide reingresarlos (422).

### En beta

- Emparejamiento nativo con StreamHub por código: necesita el core **3.4.0**, que todavía no está publicado.
- 2160p30 con NVENC (en el límite del tiempo real; 2160p60 con un issue abierto), escalera ABR con CMAF, RIST con
  bonding.
- La salida HEVC por Enhanced RTMP puede reiniciarse una vez al arrancar (se recupera en ~1 s); HEVC por SRT leído
  desde MediaMTX.
- QSV y VA-API: implementados, sin validar en hardware.

### No está todavía

- Captura SDI/HDMI aceptada con una DeckLink real (implementada, falta la aceptación de
  [docs/HARDWARE-ACCEPTANCE.md](docs/HARDWARE-ACCEPTANCE.md)).
- Soak de 24 h cerrado. Hasta ahora: 8 h 47 min (`soak24`, 5 canales, uno a StreamHub en producción, sin reinicios
  de engine ni pérdida de memoria) + 2 × 60 min.
- Passthrough de CEA-608/708, SCTE-35 y AC-3 desde la entrada; normalización de loudness (solo medición); Dolby E,
  DVB-ASI, Pro-MPEG FEC, NDI, ST 2110, NMOS; HE-AAC (fdk-aac no se distribuye).
