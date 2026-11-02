# StreamHub Encoder — informe de pruebas

| | |
|---|---|
| Fecha | 2026-10-29 (soak largo `soak24`: 2026-10-30/31) |
| Rama / commit | `feat/encoder`, e2e completo (`full2`) sobre `c8ba1796`; regresión `reg1`, prueba real `sh9` y `soak3` sobre `812e427d`/`f422c14c`; soak largo `soak24` sobre `90fb22b5` (densidad y VMAF sobre el commit indicado en cada sección) |
| Banco (`BENCH_HOST`) | .50 (`pc50-ai`): VM Proxmox con **28 vCPU de un AMD Ryzen 9 5900XT** (16C/32T), 94 GB RAM, **NVIDIA RTX 3090 24 GB** (passthrough, driver 615.71.09), Ubuntu 26.04, kernel 7.0, Docker 29.9 con runtime `nvidia` |
| Motor (`ENGINE_VERSION`) | GStreamer 1.28.2 (Ubuntu 26.04), x264 0.165, x265 4.1, gst-plugins-rs fallbackswitch 0.14.3, FFmpeg 8.0.1; `encoderd` 0.1.0-dev (Go 1.26) |
| StreamHub real | core construido desde `feat/3.4.0` (incluye `internal/devices`), LiveKit 1.13.11, ingress 1.5.0, egress 1.15.0, MediaMTX 1.19.2 |
| Hardware de captura | **ninguno**: no hay DeckLink ni capturadora HDMI en el banco. SDI/HDMI/V4L2 quedan cubiertos por goldens + `HARDWARE-ACCEPTANCE.md` |

Todo se corre en contenedores en el .50; nada en la Mac. GPU compartida con otro agente (ComfyUI): los tests de NVENC son
cortos y de pocas sesiones.

## Cifras para la landing

| Placeholder | Valor | De dónde sale |
|---|---|---|
| `LATENCY_LOW_MS` | **200 ms** | captura → presentación por UDP, x264 zerolatency 720p30 (OCR del timecode quemado, ±1 cuadro) |
| `GLASS_TO_GLASS_MS` | **333 ms** | lo mismo por **SRT** con latencia 120 ms (x264/x265 baja latencia; NVENC H.264: 300 ms) |
| `LATENCY_QUALITY_MS` | **1200 ms** | x265 modo calidad (B-pyramid + lookahead) por SRT 120 ms; x264 `medium` calidad: 2533 ms |
| `CH_X265_1080I` | **2** | densidad, x265 `medium` 1080 (carga 1080i50) en tiempo real |
| `CH_X265_FAST_1080I` | **3** | densidad, x265 `faster` |
| `CH_X264_1080I` | **8** (12 satura la CPU) | densidad, x264 `veryfast` 6 Mbps |
| `CH_NVENC_1080I` | **12** (encoder NVENC al 94 %, sin límite de sesiones) | densidad, NVENC HEVC 4 Mbps (RTX 3090) |
| `VMAF_X265_4M` | **99.8** (`medium`; `faster` 99.7) | VMAF (libvmaf) HEVC 4 Mbps, clip real 1080p24 — clip fácil, ver §5 |
| `VMAF_NVENC_4M` | **99.8** (p4) | ídem NVENC HEVC p4 |
| `SOAK_HOURS` | **8.8 h** (`soak24`: 5 canales / 9 salidas, una de ellas a StreamHub en producción; 0 errores CC, 0 reinicios de engine, RSS plano) | §6.1; cortado a las 8 h 47 min de las 24 h planeadas |
| `AV_DRIFT_FRAMES` | **0.02 cuadros en 8.8 h** (0.01 en `soak3`, 0.04 en `soak1`, de 1 h cada uno) | deriva A/V medida en la grabación del soak (§6) |
| `RECOVERY_S` | **1.5 s** | `kill -9` del engine → TS de nuevo en el bus (1517 ms) |
| `PAIRING_TIME_S` | **16 s** | del claim del código en StreamHub a ingress `publishing`, sin tipear URL ni key |
| `ENGINE_VERSION` | GStreamer 1.28.2 + x265 4.1 / x264 0.165 | |
| `BENCH_HOST` | Ryzen 9 5900XT (28 vCPU) + RTX 3090 | |

## Cómo re-correr

```bash
# en el host Linux con Docker (el .50), desde streamhub-encoder/
test/unit.sh                                                     # unit + race
REAL_MEDIA=~/ai/at20v.mp4 test/e2e/run.sh formats outputs hotswap failover crash latency netem pro
REAL_MEDIA=~/ai/at20v.mp4 test/e2e/run.sh density
SOAK_MIN=60 REAL_MEDIA=~/ai/at20v.mp4 test/e2e/run.sh soak
# + 5.º canal contra un StreamHub real (key de un ingress RTMP; no la commitees)
SOAK_MIN=1440 SOAK_PROD_RTMP=rtmp://<host>:1935/live/<key> REAL_MEDIA=~/ai/at20v.mp4 test/e2e/run.sh soak
test/e2e/vmaf.sh ~/ai/at20v.mp4 4000
REPO=<checkout de feat/3.4.0> test/real/streamhub-real.sh up && \
  REPO=… test/real/streamhub-real.sh today && REPO=… test/real/streamhub-real.sh pairing && REPO=… test/real/streamhub-real.sh down
```

## 1. Unit (Go, sin red ni GStreamer)

`go test -race ./...` en `golang:1.26`: **13 paquetes OK** — config (defaults, validación por campo, store atómico,
redacción), pipeline (**43 goldens** de engine y salidas por backend/entrada/salida + inyección), supervisor (backoff,
reset, SIGINT→SIGKILL, restart inmediato), tsbus (PAT/PMT/PES/PCR sintéticos, CC, deriva PCR, fan-out con salida muerta),
channel (salidas en caliente, cambio de engine sin tocar salidas, watchdog, resolución StreamHub con reintento, alarmas,
monitor de miniaturas/PCM), streamhub (cliente REST, pairing + WS completo contra servidor falso, 4401/401/404), whip
(negociación), api (auth, CRUD, merge-patch, presets, redacción, backup, rutas pro), auth (26 tests: roles, sesiones,
CSRF, rate-limit, tokens, auditoría, TLS), notify (webhooks con firma/reintentos, traps v2c y v3 authPriv), loudness
(vectores EBU 3341: −23.0 / −33.0 LUFS, gating relativo, LRA 10 LU), scte35 (vectores publicados, CRC, PMT con
adaptation-field). `gofmt` y `go vet` limpios.

## 2. Sintético e2e (`test/e2e/run.sh`, corrida `full2`): 73 PASS / 5 FAIL

Durante `full2` el host no estaba ocioso: otro agente corría ComfyUI (≈ 1–2 núcleos y 13–18 GB de VRAM) y el stack
StreamHub real tenía 2 canales del encoder publicando (≈ 2 núcleos + el transcode del ingress). Las pruebas de capacidad
(§4) se repitieron con el stack real detenido.

### 2.1 Formatos (entrada de test "ball" y clip real; ffprobe del TS; bitrate ±15 %, fps ±2 %, 0 errores CC)

| Caso | Resultado | Medido |
|---|---|---|
| x264 1080p30 6 Mbps | PASS | 30 fps, 6348 kbps, CPU del engine 94 % (≈1 núcleo) |
| x264 1080p60 9 Mbps | PASS | 60 fps, 9446 kbps, 182 % |
| x264 720p50 4 Mbps | PASS | 50 fps, 4313 kbps, 63 % |
| x264 **1080i50 entrelazado (PAFF)** | PASS | `field_order=tt`, 25 cuadros/50 campos, 8369 kbps |
| x264 1080i50 → desentrelazado p25 | PASS | progresivo, 133 % |
| x264 720p29.97 B-frames | PASS | 3292 kbps |
| x265 1080p25 4 Mbps `faster` | PASS | 4317 kbps, 144 % |
| x265 720p50 baja latencia | PASS | 3301 kbps, 108 % |
| NVENC H.264 1080p60 | PASS | 60 fps, CPU 128 % (conversión en CPU) |
| NVENC HEVC 1080p25 | PASS | 25 fps, 57 % CPU |
| NVENC HEVC/H.264 **2160p30** | PASS (en el límite) | 29.5–29.8 fps en el bus; en `reg1` 28.5–28.8 → FAIL (§2.8) |
| NVENC H.264 1080p30 contenido difícil (snow) | PASS | 6620 kbps (llega al objetivo) |
| NVENC HEVC + **TS CBR con nulos** 5 Mbps | PASS | 5000.3 kbps (±0.01 %) |
| Clip real 1080p24 → x264 1080p30 | PASS | 29.9 fps, 6296 kbps |
| Clip real → NVENC HEVC 1080p25 | PASS | 24.8 fps (loop del archivo: corte en cada vuelta; corregido en `f56ecac2`, 25.0 fps en §2.8) |

NVENC no rellena (no hay *filler data* en `nvh26xenc`): con imagen simple sale por debajo del objetivo (972 kbps de 4000);
para TS de tasa constante usar `mux.muxRateKbps` (probado).

### 2.2 Salidas (un encode, 10 salidas a la vez, verificadas en receptores reales)

| Salida | Receptor | Resultado |
|---|---|---|
| SRT caller + streamid | MediaMTX 1.19 | PASS (H.264 + AAC) |
| SRT listener + passphrase | ffmpeg/libsrt | PASS; passphrase incorrecta **rechazada** |
| RTMP | MediaMTX y **nginx-rtmp** | PASS / PASS |
| WHIP | MediaMTX (leído por RTSP) | PASS (H.264 + **Opus**) |
| UDP multicast / unicast / RTP-TS multicast | ffprobe | PASS ×3 |
| HLS push (HTTP PUT) | servidor PUT | PASS (32 segmentos) |
| Archivo TS | tsanalyze | PASS (0 CC) |
| HEVC por Enhanced RTMP | MediaMTX | PASS |
| HEVC HLS fMP4 (hvc1) | servidor PUT | PASS |
| HEVC por SRT a MediaMTX, leído por SRT | ffmpeg | **FAIL**: el receptor ffmpeg no detecta el video al leer HEVC desde MediaMTX por SRT. La misma ruta HEVC/SRT hacia el MediaMTX de StreamHub → HLS fMP4 sí pasa en la prueba real (§3.2); es un problema del lado lectura, no del encoder, pero queda sin cerrar |
| Las 10 salidas `running`, 0 reinicios del engine | — | PASS |

### 2.3 Salidas en caliente, failover, crash

| Prueba | Resultado | Medido |
|---|---|---|
| Agregar RTMP y WHIP, quitar UDP, editar RTMP mientras se graba el SRT | PASS | 69.4 s grabados, 2083 cuadros, **0 CC**, 0 saltos de PCR, 0 reinicios de engine/SRT |
| Failover primaria (SRT) → backup (UDP) → primaria → negro/silencio | PASS | colores `K B R B R B K`; salida continua: **0 CC**, 2021 cuadros en 74 s, engine sin reiniciar. La conmutación pasa por ~1 s de negro (fallbacksrc arranca el backup al fallar el primario) |
| `kill -9` del engine | PASS | TS de nuevo en **1517 ms**; las salidas no se reinician |
| `kill -9` de una salida | PASS | se reinicia sola; engine y otras salidas intactos |
| Engine colgado (`SIGSTOP`) | PASS | watchdog: TS de nuevo a los 7.8 s (umbral 6 s) |
| Reinicio de `encoderd` (docker restart) | PASS | canal vivo de nuevo a los **3.1 s** (estado persistido); sin procesos huérfanos |

### 2.4 Latencia (timecode RTC quemado en la fuente vs. timecode RTC del receptor, OCR, 45 muestras, ±1 cuadro)

| Encode → transporte | Mediana | p95 |
|---|---|---|
| x264 zerolatency 720p30 → UDP | **200 ms** | 200 ms |
| x264 zerolatency → SRT 120 ms | **333 ms** | 333 ms |
| x265 zerolatency → SRT 120 ms | 333 ms | 333 ms |
| NVENC H.264 baja latencia → SRT 120 ms | **300 ms** | 300 ms |
| NVENC HEVC baja latencia → SRT 120 ms | 300 ms | 300 ms |
| x264 zerolatency → SRT 500 ms | 700 ms | 700 ms |
| x265 calidad (B=3, lookahead) → SRT 120 ms | 1200 ms | 1200 ms |
| x264 `medium` calidad (B=3, lookahead) → SRT 120 ms | 2533 ms | 2533 ms |

Incluye captura, encode, mux, red, buffer del receptor y decodificación (el receptor estampa al presentar).

### 2.5 SRT con pérdida (tc netem en ambos sentidos, +20 ms ±5 ms)

| Pérdida / latencia SRT | SRT | UDP-TS (control, mismo enlace) |
|---|---|---|
| 5 % / 1000 ms (60 s) | **1800/1800 cuadros, 0 CC, 0 errores de decodificación, 0 reconexiones** | 1046 cuadros, 1291 errores de decodificación |
| 10 % / 1000 ms (60 s) | **1800/1800, 0, 0, 0** | 1395 cuadros, 1679 errores |
| 10 % / 400 ms (45 s) | **1350/1350, 0, 0, 0** | 610 cuadros, 746 errores |

### 2.6 Funciones profesionales (`suite pro`)

| Prueba | Resultado | Medido |
|---|---|---|
| x265 **Main10 HLG** 1080p25 | PASS | `yuv420p10le`, transfer `arib-std-b67`, primarias BT.2020 |
| x265 **Main 4:2:2 10** | PASS | `yuv422p10le`, perfil Rext |
| x265 **PQ / HDR10** | PASS | `smpte2084`, BT.2020, SEI **Mastering display** + **Content light level** |
| x265 **2160p30** (`ultrafast`) | PASS | 27.1 fps en el bus: **no llega a tiempo real** en este banco → 4K software no es viable aquí |
| NVENC **Main10 PQ 1080p60** | PASS | 59.9 fps, mastering + CLL |
| NVENC **Main10 2160p30** | PASS | 30 fps |
| NVENC HEVC **2160p60** 8-bit | **FAIL** | el SPS sale con 3840×**2176** (sin ventana de conformidad); 2160p30 8-bit y 10-bit salen bien. Issue abierto de nvh265enc a 60 fps |
| NVENC H.264 1080p60 | PASS | 59.9 fps |
| **Escalera ABR** 1080/720/480 en un TS + RTMP de la rung 720p + HLS master | ver nota | el TS lleva las 3 renditions y la salida RTMP con `rendition:1` entrega 1280×720 (PASS); el **HLS master con CMAF** salió vacío (sin `STREAM-INF`) → CMAF+escalera queda **beta**; con segmentos TS el master lista las variantes (verificado a mano, re-corrida en §2.7) |
| 3 pistas de audio (spa AAC 2.0, eng AAC 2.0, qaa **AC-3 5.1**) | PASS | idiomas ISO 639 en el PMT |
| Medidor **EBU R128** | PASS | seno −20 dBFS estéreo → **−20.0 LUFS** integrado |
| **SCTE-35** por API (splice_insert programado 30 s, inmediato, time_signal 0x34) | PASS | los 3 cues leídos del TS recibido por **SRT** (PID 500, CUEI) |
| RIST con bonding 2 enlaces + 3 % pérdida | **FAIL** | 767 cuadros, 49 errores CC, 8 errores de decodificación: el ARQ no recuperó todo (bonding probado contra el mismo receptor; ver §2.7) |
| Grabación rotativa (anillo 3 × 4 s) | PASS | quedan 3 segmentos |
| **Timecode en SEI** (H.264 pic_timing) | PASS | ffprobe: `SMPTE 12-1 timecode` en cada cuadro |
| **CEA-608** de una entrada UDP a la salida | **FAIL** | los subtítulos no llegan a la salida (probablemente el decodificador elegido —nvh264dec con GPU— no exporta los captions): **no soportado todavía** |
| Alarmas negro + congelado | PASS | ambas activas en ≤ 5 s |
| Alarma → **webhook** firmado | PASS | evento recibido (raise + clear) |
| Alarma → **trap SNMP v2c** | PASS | 4 traps en snmptrapd (2 alarmas × raise/clear) |
| Miniatura de confianza | PASS | `image/jpeg` 320×180 |
| **HTTPS** + login admin (cambio de clave forzado) + token visor (GET 200 / POST 403) + auditoría | PASS | |

### 2.7 Re-corrida de los casos ajustados (corrida `pro3`)

| Prueba | Resultado | Medido |
|---|---|---|
| Escalera ABR con segmentos **TS**: TS con 1080/720/480, **HLS master con 3 variantes**, RTMP de la rung 720p | PASS | las 3 salidas `running` |
| **RIST** Simple Profile (sin bonding), 3 % de pérdida, buffer 2 s | PASS | 767 cuadros, 0 errores de decodificación (1 CC al inicio) |
| Grabación rotativa | PASS | |

Quedan como **beta**: escalera ABR con **CMAF** (master vacío con ffmpeg 8), **RIST bonding** (falló con los dos enlaces
apuntando al mismo receptor; sin un segundo camino real no está validado).

### 2.8 Regresión tras el feeder de archivo y el fix de WHIP (corrida `reg1`: formats + outputs + failover, 32 PASS / 3 FAIL)

| Prueba | Resultado | Medido |
|---|---|---|
| Clip real en loop → x264 1080p30 / NVENC HEVC 1080p25 | PASS | **30.0 / 25.0 fps** (antes 29.9 / 24.8 por el corte de cada vuelta) |
| Todas las salidas de §2.2 y el failover de §2.3 | PASS | failover: 2020 cuadros en 72.7 s, 0 CC, 0 reinicios |
| HEVC por SRT → MediaMTX → lector SRT | FAIL | el mismo de `full2` (abierto) |
| NVENC HEVC/H.264 **2160p30** con el patrón de test 4K | **FAIL** | 28.8 / 28.5 fps en el bus (en `full2` 29.5 / 29.8). El engine usa ~300 % de CPU: generar el patrón 4K y convertir/escalar en CPU queda en el límite del tiempo real; NVENC no es el cuello. **2160p pasa a beta** hasta mover la conversión a la GPU (`cudaupload`/`cudaconvertscale`) |

Nota: con el feeder, el engine de un archivo en loop es `sh → (ffmpeg, gst-launch)` y la CPU/RSS del engine se leía de la
shell (0 % en `reg1`); `f422c14c` suma el árbol de procesos.

## 3. Real: StreamHub (stack `enc-sh`, core de `feat/3.4.0`, MediaMTX con SRT y HEVC passthrough)

Ajustes del entorno de prueba (no del producto): LiveKit con `node_ip: 127.0.0.1` porque el banco está detrás de NAT sin
hairpin y el ingress/egress no alcanzan la IP pública detectada por STUN; ingress con 8 CPUs; Versity S3 Gateway en
127.0.0.1 como S3 de la app, con `STREAMHUB_ALLOW_PRIVATE_S3_ENDPOINT=1` para pasar el guard SSRF del core.

### 3.1 Modo "funciona hoy" (token `sk_` de app → ingress por REST) — corrida `sh9`: 13/13 PASS

| Prueba | Resultado |
|---|---|
| App + token `sk_` con scope de app por la API | PASS |
| Salida StreamHub RTMP 1080p (test, B-frames): ingress `publishing` 1920×1080, stream `active` en `GET /apps/enc/streams` | PASS |
| Salida StreamHub WHIP con **clip real en loop**, NVENC H.264 baja latencia: ingress `publishing` 1280×720, stream `active` | PASS |
| WebRTC: el participante de cada ingress publica `output.video` y `output.audio` en la room (2 tracks) | PASS (RTMP y WHIP) |
| **HLS** del core (`/hls/enc/enc-cam-rtmp/index.m3u8`) por ffprobe | PASS (H.264 720p30 + AAC) |
| **Grabación**: egress room-composite → MP4 subido al S3 de la app → VOD `ready` | PASS (MP4 de 14.8 MB + miniatura en el bucket; el VOD se reproduce por ffprobe) |
| Quitar la salida borra el ingress en StreamHub (`deleteOnRemove`) | PASS (tras corregir un bug hallado acá: el runtime no conocía el ingressId resuelto y el ingress quedaba huérfano) |

Hallazgos de esta prueba, todos corregidos y re-probados en `sh9`:

| Hallazgo | Causa | Corrección |
|---|---|---|
| Clip en loop → ingress de LiveKit en `buffering`; en el soak, caídas de fps y deriva PCR en el canal de archivo | `fallbacksrc restart-on-eos` mete **+2.1 s en los PTS en cada vuelta** del loop (medido: 13 saltos de +2.08…+2.12 s en 190 s con un clip de 13.8 s) | `f56ecac2`: el archivo en loop lo alimenta `ffmpeg -re -stream_loop -1 … -c copy -f matroska` por stdin. Medido después: 0 saltos, `videoSeconds` = `streamSeconds` (365.4 vs 365.5 s), 0 discontinuidades PCR |
| La primera sesión WHIP se caía a los 30–36 s en cada arranque con entrada de archivo | el TS del engine anuncia el audio un instante después del video; gst-launch enlaza los pads de `tsdemux` una sola vez y el helper WHIP se quedaba sin RTP | `bf31d29b` + `812e427d`: `whip-push` detecta el aviso y renegocia en ~1 s (verificado: aviso a las 22:56:28.36, sesión nueva conectada a las 22:56:30.48) |
| Con la GPU ocupada al arrancar `encoderd`, `nvcodec` no registra NVENC y el canal quedaba en error | probe de capacidades único al arrancar | `cfa2ff7e`: re-sondeo cada minuto mientras haya canales esperando un encoder HW |
| Grabación: VOD `failed` | el core (fix de seguridad 3.3.3) rechaza endpoints S3 privados/loopback; además MinIO ya no se puede bajar sin login | entorno de prueba: `STREAMHUB_ALLOW_PRIVATE_S3_ENDPOINT=1` y Versity S3 Gateway como S3. No es un bug del encoder |

### 3.2 Modo nativo (pairing por código contra el core real)

| Prueba | Resultado | Medido |
|---|---|---|
| El encoder muestra el código (`POST /devices/pair/start`) | PASS | `KEHZ-YM2G` |
| Claim por API del operador (`POST /apps/enc/devices/claim`) | PASS | |
| WebSocket del dispositivo conectado (`Authorization: Device dk_…`) | PASS | 5 s después del claim |
| Vincular canal → room RTMP: `config` → salida gestionada → ingress `publishing` | PASS | **16 s desde el claim** sin tipear URL ni key |
| Vincular canal HEVC por **SRT** (streamid `publish:enc/ptk_…`) → MediaMTX → **HLS fMP4 HEVC** | PASS | 20 s desde el link |
| Telemetría: el core ve `online=true`, canales `live` con fps/bitrate | PASS | |
| Comando `restart` desde el core | PASS | `ok:true` |
| Revocar el dispositivo → 4401 → encoder `revoked`, salida gestionada removida | PASS | |

### 3.3 Observaciones

- El modo nativo (§3.2) se corrió antes de las correcciones de `f56ecac2`/`bf31d29b`/`812e427d`, que no tocan el
  device plane (los canales de esa prueba usan entrada de test, no archivo).
- Un ingress WHIP de LiveKit que recibe una sesión nueva mientras la anterior no terminó de cerrarse puede quedar
  con sesiones "zombie" que siguen reportando stats con 0 paquetes; en una corrida contra un stack reusado eso dejó el
  ingress en `buffering`. Con un stack limpio no se reprodujo. Es del lado de LiveKit ingress.

## 4. Densidad (corrida `density8`)

Método: N canales 1920×1080 a 25 cuadros/s (= la carga de píxeles de 1080i50) que transcodifican el clip real
`at20v.mp4` (1080p24 H.264 6 Mbps, generado por IA) en loop desde un archivo largo; decodificación forzada a CPU
(`GST_PLUGIN_FEATURE_RANK=nvh264dec:NONE`) para que la GPU compartida no ensucie los números de software. Un paso pasa
si **todos** los canales sostienen ≥ 96 % de 25 fps (cuadros contados en 40 s, tras 45 s de calentamiento) sin
reinicios. Stack StreamHub real detenido; ComfyUI de otro agente seguía activo (≈ 1 núcleo, VRAM 13–18 GB).

| Backend (1080@25) | Canales en tiempo real | Primer paso que falla | CPU del host al máximo que pasa |
|---|---|---|---|
| x265 `medium` 4 Mbps | **2** | 3 (23.7 fps) | 15 % |
| x265 `faster` 4 Mbps | **3** | 4 (23.5 fps) | 24 % |
| x264 `veryfast` 6 Mbps | **8** | 12 (23.8 fps, CPU 94 %: saturada) | 43 % |
| NVENC HEVC 4 Mbps (RTX 3090) | **12** (no se probó más) | — | 24 % CPU, encoder NVENC 94 %, GPU 100 % |

Lectura honesta:
- **x264** es el único caso limitado por CPU (12 canales la satura); el techo real está entre 8 y 12.
- **x265** falla con la CPU ociosa (15–35 %): el límite no es cómputo sino paralelismo del pipeline (hilos de x265 y
  etapas de un hilo: conversión, mux). Hay margen de tuning (`pools`/`frame-threads` de x265, más hilos de conversión)
  que no se hizo en esta tanda.
- El clip es **fácil** (VMAF 99.8 a 4 Mbps, §5): contenido broadcast real (deporte, ruido) cuesta más CPU en
  x264/x265; NVENC es de función fija y depende poco del contenido.
- **NVENC**: 12 sesiones simultáneas en una GeForce con driver 615 sin tope de sesiones; con el encoder al 94 % el techo
  está cerca de 12–13 canales 1080p25 HEVC.
- Corridas anteriores (`density2`…`density7`) se descartaron: archivo corto con corte de loop dentro de la ventana,
  contención con el stack real y con ComfyUI usando NVDEC, y el "catch-up" de una entrada de archivo; quedan en
  `test/e2e/results/` del .50.

## 5. VMAF (libvmaf, `test/e2e/vmaf.sh`, clip real 1080p24, CBR, mismos ajustes que emite el encoder)

| Encode | 4 Mbps: VMAF medio / p5 | 1.5 Mbps: VMAF medio / p5 |
|---|---|---|
| x265 `medium` | **99.76** / 100.0 | **98.49** / 90.4 |
| x265 `faster` | 99.68 / 99.3 | 97.83 / 89.1 |
| NVENC HEVC p4 | **99.84** / 100.0 | 98.36 / 87.5 |
| NVENC HEVC p7 + two-pass | 99.86 / 100.0 | 98.54 / 88.0 |
| x264 `veryfast` (referencia H.264) | 99.28 / 94.6 | 84.01 / 63.0 |

A 4 Mbps el clip es transparente para todos (no discrimina); a 1.5 Mbps HEVC (x265 y NVENC) supera a H.264 por ~14
puntos y x265 `medium` ≈ NVENC p7. Falta repetir con contenido broadcast exigente (no hay en el banco).
Nota de método: los dos lados se decodifican a Y4M antes de puntuar (comparar mkv vs mp4 directo desalineaba cuadros por
timestamps y daba ~35 — descartado).

## 6. Soak

### 6.1 Corrida `soak24` (8 h 47 min, 2026-10-30 19:41 → 2026-10-31 04:29 UTC, `90fb22b5` + `SOAK_PROD_RTMP`): 6 PASS / 1 FAIL externo

Igual que `soak3`, más un **5.º canal (s5) que publica por RTMP al StreamHub de producción** (`app.streamhub.studio`,
app `camtest`, ingress `camtest-soak`) por internet. Planeada de 24 h y cortada a pedido a las 8 h 47 min. El corte
fue ordenado: se pausó el muestreo, se guardó el estado final, se borraron los canales, se evaluó con el mismo
`soak_evaluate` y el runner bajó la infra. 1040 muestras por canal, una cada 30 s.

| Canal | Salidas | fps (min / medio) | CC | Reinicios engine / salidas / stalls | RSS engine (5–15 min → últimos 10 min) | CPU media | fds |
|---|---|---|---|---|---|---|---|
| s1: **clip real en loop** → x264 1080p30 6 Mbps | SRT → MediaMTX, RTMP → nginx | 29.7 / **30.00** | 0 | 0 / 0 / 0 | 1536 → 1539 MB (0 MB/h) | 0.98 núcleos | 65 → 65 |
| s2: NVENC HEVC 1080p25 4 Mbps | SRT listener, UDP multicast | 24.8 / 25.00 | 0 | 0 / 0 / 0 | 342 → 342 MB | 0.61 | 57 → 57 |
| s3: x264 720p30 baja latencia | WHIP → MediaMTX, HLS push | 29.8 / 30.00 | 0 | 0 / 0 / 0 | 122 → 122 MB | 0.40 | 16 → 16 |
| s4: x265 720p25 | E-RTMP HEVC → MediaMTX, grabación TS | 24.7 / 24.99 | 0 | 0 / 0 / 0 | 294 → 294 MB | 0.51 | 16 → 16 |
| s5: clip real → x264 720p30 2 Mbps | **RTMP → StreamHub prod** (internet) | 29.7 / 30.01 | 0 | 0 / **1** / 0 | 794 → 795 MB | 0.56 | 65 → 65 |
| `encoderd` | | | | | 25.8 → 27.5 MB | | 58 → 58 |

- **Deriva A/V: 0.02 cuadros en 8.8 h**. Se midió sobre la grabación de s4: 11.2 GB, 791 728 cuadros de video
  (31 669 s), y el contenido AAC es igual al span de PTS (31 669.163 s), así que no hay huecos de audio. Las medias por
  ventana del offset van de 132.6 a 133.3 ms.
- **Memoria y descriptores planos**: la pendiente de RSS da 0 MB/h en los 5 engines durante casi 9 h. Las fds no se
  movieron. El RSS de `encoderd` pasó de 25.8 a 27.5 MB.
- **Deriva PCR** dentro de −2.8…43.1 ms en todos los canales. En los dos que leen el archivo en loop (s1, s5) el fps
  mínimo por ventana fue 29.7, sin caídas en las vueltas del loop.
- La entrada de s2 (NVENC) quedó `live` de entrada. La GPU es compartida con otro agente.
- **FAIL s5, por causa externa**: la salida a producción se reinició **una vez**, a las 02:32:07 UTC (6 h 51 min). El
  log del ingress de LiveKit en el server dice `relay stream ended with error … connection reset by peer` y
  `handler killed` para ese ingress, 30 s después de un `high cpu load 0.996`. El ingress de prod transcodifica los dos
  ingresses de `camtest` y su propia métrica de carga estuvo al tope: 457 avisos `high cpu load` en esas 9 h. El
  contenedor usaba ~0.9 núcleos de 8 al revisarlo. El supervisor del encoder relanzó la salida en **1.0 s** (exit 02:32:07.98, start 02:32:08.98), el
  ingress volvió a `publishing` y el canal no perdió fps (30.0 en la muestra siguiente). Es el comportamiento
  esperado ante una caída del server. El evaluador lo marca FAIL porque exige 0 reinicios de salida.
- **Hallazgo abierto (observabilidad)**: ese reinicio **no quedó en el log de `encoderd`**: 32 líneas en 8.8 h,
  ninguna a las 02:32. Solo aparece en el estado (`process.restarts`, `lastExit: exit status 1`). Hay que loguear
  como WARN cada salida que muere y se relanza (canal, salida, código, último stderr) y exponer un contador en
  `/metrics`.
- Del lado de prod, el ingress `camtest-cam1` (la cámara de prueba, no el encoder) se reconecta cada ~25 min durante
  toda la corrida. Es independiente de este soak y queda anotado para revisarlo en el server.

### 6.2 Corrida `soak3` (60 min, imagen con `f56ecac2` feeder, `812e427d` WHIP, `f422c14c` stats del árbol de procesos): 5 PASS / 1 FAIL

| Canal | Salidas | fps (min / medio) | CC | Reinicios engine / salidas / stalls | RSS engine (5–15 min → últimos 10 min) | fds |
|---|---|---|---|---|---|---|
| s1: **clip real en loop** → x264 1080p30 | SRT → MediaMTX, RTMP → nginx | **29.8 / 30.00** | 0 | 0 / 0 / 0 | 1559 → 1568 MB (+10 MB/h) | 65 → 65 |
| s2: NVENC HEVC 1080p25 | SRT listener, UDP multicast | 24.8 / 24.99 | 0 | 0 / 0 / 0 | 339 → 339 MB | 57 → 57 |
| s3: x264 720p30 baja latencia | WHIP → MediaMTX, HLS push | 29.8 / 29.99 | 0 | 0 / 0 / 0 | 121 → 121 MB | 16 → 16 |
| s4: x265 720p25 | E-RTMP HEVC → MediaMTX, grabación TS | 24.8 / 25.00 | 0 | 0 / **1** / 0 | 284 → 284 MB | 16 → 16 |
| `encoderd` | | | | | 25.1 → 25.9 MB | 50 → 50 |

- **Deriva A/V: 0.01 cuadros en 60.6 min** (medias por ventana del offset entre 132.3 y 132.5 ms; 173 k cuadros AAC
  = span de PTS exacto).
- Con el feeder, el canal de archivo ya no tiene caídas de fps (mínimo 29.8 contra 19.1 en `soak1`), su deriva PCR
  queda en −1.4…42.6 ms (antes −514 ms) y **su RSS queda plano** (+10 MB/h; en `soak1` eran +174 MB/h). El crecimiento
  venía de los reinicios de `fallbacksrc` en cada vuelta del loop.
- s2 (NVENC) arrancó `live` de entrada.
- **FAIL s4**: la salida Enhanced RTMP (ffmpeg → MediaMTX) se reinició **una vez, 7 s después de arrancar**: MediaMTX
  cerró la conexión (`Connection reset by peer`) porque ffmpeg empezó a mandar antes de los primeros parameter sets HEVC.
  El supervisor la levantó en 1 s y no hubo más reinicios en 60 min. En `soak1` no pasó: es una carrera de arranque.
  **Abierto**: que la salida FLV/HEVC espere al primer keyframe con VPS/SPS/PPS antes de conectar.

### 6.3 Corrida `soak1` (60 min, imagen anterior a `cfa2ff7e`)

4 canales mixtos y 8 salidas con lectores vivos todo el tiempo, muestreo cada 30 s (`soak.csv`, 119 muestras por canal):

| Canal | Configuración | Salidas | fps (min / medio) | CC | Reinicios engine / salidas / stalls | RSS engine (5–15 min → últimos 10 min) | fds |
|---|---|---|---|---|---|---|---|
| s1 | **clip real** en loop (`fallbacksrc`) → x264 1080p30 6 Mbps | SRT → MediaMTX, RTMP → nginx | 19.1 / **29.29** | 0 | 0 / 0 / 0 | 2510 → 2629 MB (**+174 MB/h**) | 56 → 56 |
| s2 | test → **NVENC** HEVC 1080p25 4 Mbps + timecode/reloj | SRT listener, UDP multicast | 24.8 / 25.01 | 0 | 0 / 0 / 0 | 338 → 338 MB | 57 → 57 |
| s3 | test → x264 720p30 baja latencia | WHIP → MediaMTX, HLS push | 29.8 / 30.00 | 0 | 0 / 0 / 0 | 121 → 121 MB | 16 → 16 |
| s4 | test → x265 720p25 | Enhanced RTMP (HEVC) → MediaMTX, grabación TS | 24.8 / 24.98 | 0 | 0 / 0 / 0 | 300 → 300 MB | 16 → 16 |
| `encoderd` | | | | | | 24.9 → 26.2 MB | 48 → 50 |

- **Deriva A/V (`AV_DRIFT_FRAMES`): 0.04 cuadros en 61.7 min** sobre la grabación de s4 (3702.5 s, 92 561 cuadros de
  video, 173 556 cuadros AAC = 3702.528 s, exactamente el span de PTS del audio). Método: offset PTS audio−video en
  cada posición del TS, media por 24 ventanas; las medias van de 132.4 a 134.1 ms.
- **0 errores CC, 0 reinicios, 0 stalls** en los 4 canales; deriva PCR dentro de ±45 ms salvo s1 (ver abajo).
- **s2 (NVENC) arrancó tarde**: la GPU estaba ocupada por otro agente cuando arrancó `encoderd` y `nvcodec` no registró
  NVENC. Entró a `live` a los 425 s tras un SIGHUP + stop/start manual. Es el hallazgo que corrige `cfa2ff7e`
  (re-sondeo automático). El evaluador nuevo exige `live` en ≤ 120 s, así que s2 sale **FAIL** en esta corrida. Desde
  que entró, 25 fps estables y RSS plano.
- **s1, entrada de archivo en loop**: el fps por ventana de 30 s cae a ~19–22 en cada vuelta del loop y sube a 35–40 en
  la ventana siguiente (catch-up de `fallbacksrc`). La media es 29.29 de 30 y la deriva PCR llega a −514 ms en esas
  vueltas. Es un artefacto de la entrada de archivo, que en producción es una entrada de prueba; las entradas en vivo
  (s2–s4) no lo muestran.
- **s1 RSS**: ~2.5 GB, crece **~170 MB/h** después del calentamiento (+4.7 % entre la ventana base y el final; pasa
  el umbral de 15 %). En 60 min no se puede saber si se estabiliza: los otros 3 engines están planos, así que apunta a
  la cadena `fallbacksrc` + decodificación del archivo en loop. **Resuelto en `soak3`** con el feeder (+10 MB/h).
- Nota de método: el primer evaluador del soak daba FAIL en todo porque comparaba como números campos CSV entre comillas
  y medía la "deriva" como diferencia de spans al final del archivo, donde el grabador corta a mitad del interleave. Se
  corrigió en `c574335c` y `soak1` se re-evaluó con `soak_evaluate` sobre el mismo `soak.csv` y la misma grabación.

## 7. Lo que NO se probó en este banco

- **SDI / HDMI (DeckLink) y V4L2 reales:** no hay tarjetas. Pipelines cubiertos por goldens; checklist en
  `HARDWARE-ACCEPTANCE.md`.
- **QSV / VA-API:** no hay GPU Intel/AMD. Solo goldens.
- **YouTube / Twitch / Wowza / Ant Media / AWS reales:** los presets se validan contra nuestro pipeline y las salidas
  equivalentes (RTMP/RTMPS, SRT, WHIP) contra MediaMTX y nginx-rtmp; no se publicó nada a servicios externos.
- **RTMPS** contra un servidor TLS real (el elemento lo soporta; MediaMTX del banco sin certificado).
- **SNMP v3** solo en unit (contra el listener de gosnmp); en e2e se probó v2c con snmptrapd.
