# Checklist de aceptación con hardware de captura (SDI / HDMI)

El banco de pruebas (Ryzen 5900XT + RTX 3090, Ubuntu 26.04) **no tiene tarjeta SDI ni capturadora HDMI**. Las rutas
DeckLink y V4L2 están cubiertas por tests unitarios (goldens del pipeline exacto: `internal/pipeline/testdata/golden/
engine-decklink-*.txt`, `engine-v4l2-*.txt`) y por el mismo `fallbackswitch`+slate que sí se ejecuta en e2e con la
entrada de test. **Nada de esto reemplaza esta checklist**: hay que correrla en el primer equipo con tarjeta antes de
declarar SDI/HDMI aptos para producción.

Registrar cada punto con fecha, equipo, modelo de tarjeta, versión de driver y resultado en `docs/TEST-REPORT.md`.

## 0. Preparación

- [ ] Linux nativo (no VM sin passthrough PCIe). Kernel LTS fijado.
- [ ] Blackmagic Desktop Video instalado (`dpkg -l desktopvideo`), `BlackmagicFirmwareUpdater status` al día.
- [ ] `ls /dev/blackmagic/` lista los dispositivos; `gst-inspect-1.0 decklinkvideosrc` existe.
- [ ] Para HDMI USB/UVC o Magewell: `v4l2-ctl --list-devices` y `v4l2-ctl -d /dev/videoN --list-formats-ext`.
- [ ] `encoderd` instalado (`.deb`), usuario `encoder` en los grupos `video audio render`.
- [ ] `GET /api/v1/system/capabilities` muestra la tarjeta en `devices.decklink` / `devices.v4l2`.

## 1. DeckLink SDI

Canal base:
```json
{"id":"sdi1","enabled":true,"input":{"type":"decklink","device":0,"connection":"sdi","mode":"auto","audioInputChannels":8},
 "video":{"codec":"h265","encoder":"auto","width":1920,"height":1080,"fps":"25","bitrateKbps":4000},
 "audio":{"channels":2,"map":[0,1]},"overlay":{"timecode":true},
 "outputs":[{"id":"rec","type":"file","enabled":true,"url":"/var/lib/streamhub-encoder/sdi1-{ts}.ts"}]}
```

- [ ] **1080i50** desde un generador/cámara: el canal queda `live`; `ffprobe` del TS: HEVC 1920x1080 progresivo 25 fps
      (desentrelazado). Repetir con `mode:"1080i50"` explícito.
- [ ] **1080i50 entrelazado nativo**: perfil `h264-1080i50-8m-entrelazado` → `ffprobe` `field_order=tt` (o `bb`).
- [ ] **1080p25/29.97/30/50/59.94, 720p50/59.94** con `mode:"auto"`: el canal sigue la señal sin reinicio manual
      (si la tarjeta cambia de formato, el engine se reinicia una vez: registrar el tiempo).
- [ ] **SD 625i25 (PAL) y 525i29.97 (NTSC)** con `mode:"pal"`/`"ntsc"`: escala a la resolución configurada.
- [ ] **Audio 8 canales embebidos**: tono distinto en cada par; `map:[2,3]` → la salida lleva el par 2 (verificar con
      `ffmpeg -i … -af astats`). `channels:6` y `channels:8` → `ffprobe channels=6/8`.
- [ ] **Pérdida de señal**: desconectar el BNC → antes de `timeoutMs` (2 s) la salida muestra el slate "SIN SEÑAL / NO
      SIGNAL" y silencio, **sin cortar** la salida (`tsanalyze`: 0 CC errors, frames continuos). Reconectar → vuelve la
      imagen sola. Medir ambos tiempos.
- [ ] **Sincronía A/V** con patrón flash+beep (p. ej. un generador o un clip de sync en un reproductor SDI): desfase
      medido en el receptor ≤ 1 frame. 30 min sin deriva.
- [ ] **Latencia** con el timecode quemado frente a un monitor con reloj: modo baja latencia < 200 ms de encoder
      (comparar con los números de e2e en `TEST-REPORT.md`).
- [ ] **Dos canales en la misma tarjeta** (Duo 2 / Quad 2: `device:0` y `device:1`) en paralelo sin drops.
- [ ] **Soak 24 h** 1080i50 → HEVC 4 Mbps → SRT (criterio F1 del plan): 0 frames descartados, `encoder_engine_restarts_total`
      = 0, `encoder_pcr_drift_ms` acotado, RSS estable.

## 2. HDMI (DeckLink Mini Recorder / UltraStudio)

- [ ] `connection:"hdmi"`: 1080p30/1080p60/720p60 desde una notebook; audio estéreo HDMI.
- [ ] Desconectar HDMI → slate; reconectar → imagen.
- [ ] HDCP: una fuente con HDCP **no** debe capturarse (comportamiento esperado de la tarjeta; documentar).

## 3. V4L2 / UVC (capturadoras HDMI-USB, Magewell)

```json
{"id":"usb1","enabled":true,"input":{"type":"v4l2","devicePath":"/dev/video0","format":"mjpeg","audioDevice":"hw:2,0"},
 "video":{"codec":"h264","encoder":"auto","width":1920,"height":1080,"fps":"30","bitrateKbps":6000}}
```

- [ ] `format:"raw"` (YUY2) y `format:"mjpeg"` según lo que liste `v4l2-ctl --list-formats-ext`; 1080p30 sin drops.
- [ ] Audio por `audioDevice` (ALSA de la capturadora, `arecord -l`), y sin `audioDevice` → silencio.
- [ ] **Desenchufar el USB**: hoy `v4l2src` falla → el supervisor reintenta con backoff (1 s → 30 s) hasta que vuelve el
      dispositivo; **la salida se corta mientras no hay dispositivo** (limitación conocida, ver README). Verificar que
      al reconectar vuelve sola y registrar el tiempo.
- [ ] Rutas estables: usar `/dev/v4l/by-id/…` en lugar de `/dev/videoN`.

## 4. Encoders por hardware en el equipo final

- [ ] NVENC (L4 / RTX): `nvh264enc`/`nvh265enc` en `capabilities.encoders`; densidad con la tabla del TEST-REPORT.
- [ ] Intel QSV (Arc A380/A310, iGPU): `qsvh264enc`/`qsvh265enc` presentes; un canal 1080p de cada codec; ffprobe OK.
      **Estos backends no se ejecutaron en el banco (no hay GPU Intel/AMD)**: solo tienen golden tests.
- [ ] VA-API (Intel/AMD): `vah264enc`/`vah265enc`; ídem.
