# Guía del operador — StreamHub Encoder

Para quien instala y opera el encoder en el día a día. Referencia de la API: `README.md` y `/api/v1/docs` en el equipo.

## 1. Primer arranque

1. Instalar el `.deb` (o el contenedor) — ver README.
2. `sudo encoderd token` → token de la API. Abrir `http://<ip>:8090/` y pegarlo.
3. **Capacidades** (botón arriba a la derecha): confirmar que aparecen los encoders esperados (`x264`, `x265`, y si hay
   GPU `nvenc`/`qsv`/`vaapi`), la tarjeta DeckLink en `devices.decklink` y/o las capturadoras en `devices.v4l2`.
   Si se instaló un driver o plugin después de arrancar: `sudo systemctl reload encoderd` (SIGHUP: vuelve a sondear y
   reconcilia los canales).
4. Crear el canal (botón **+ Canal**, JSON) o por API. Empezar con `input.type: "test"` para validar las salidas
   antes de conectar la señal real.

## 2. Elegir el perfil de encode

| Caso | Perfil | Notas |
|---|---|---|
| Reemplazo del HERO 5000E, contribución punto a punto, bajo bitrate | `hevc-1080p25-4m-calidad` | x265 consume mucha CPU (ver densidad en TEST-REPORT); con GPU usa NVENC |
| Contribución HEVC con baja latencia | `hevc-1080p25-4m-baja-latencia` | sin B-frames ni lookahead |
| Hacia StreamHub (WebRTC/HLS), YouTube, Twitch, CDNs | `h264-1080p30-6m` | H.264 es lo que todos aceptan |
| WHIP (LiveKit/StreamHub, MediaMTX, Ant Media) | `h264-webrtc-1080p30-4m` | WHIP exige H.264 sin B-frames (lo valida la API) |
| IRD / headend que espera 1080i | `h264-1080i50-8m-entrelazado` | requiere fuente entrelazada (DeckLink 1080i) |
| 4K | `hevc-2160p30-15m`, `h264-2160p30-20m` | solo con encoder por hardware |

`POST /api/v1/channels/<id>/profile {"profile":"…"}` o el selector de la UI. Cambiar el encode **reinicia el engine**
(~1–2 s de corte en las salidas, que siguen conectadas). Cambiar salidas **no** corta nada.

**CBR:** x264/x265 hacen CBR real (relleno HRD). NVENC no rellena: el bitrate configurado es un techo y con imagen
simple sale menos. Si el destino necesita un TS de tasa constante (IRD, satélite, ASI), fijar `mux.muxRateKbps`
(TS con paquetes nulos) ≥ video + audio + 15 %.

## 3. Salidas

- Preferir **presets de destino** (`+ Salida` en la UI): completan URL, modo SRT, latencia y streamid, y avisan si el
  codec no es compatible (p. ej. nginx-rtmp no acepta HEVC).
- **SRT por internet:** `latencyMs` ≈ 4 × RTT (mínimo 120 ms en LAN; 500–2000 ms por internet). Con pérdida alta subir
  la latencia (ver la tabla de netem en TEST-REPORT). Passphrase 10–79 caracteres.
- **SRT listener:** el encoder espera en `srt://:<puerto>`; el decoder llama. Abrir el puerto UDP en el firewall.
- **UDP multicast:** `ttl` acorde a la red; `iface` para elegir la NIC de salida; PIDs fijos (`mux.videoPid/audioPid`).
- **RTMPS:** URL `rtmps://…`. **HEVC por RTMP** usa Enhanced RTMP: lo aceptan YouTube y MediaMTX; no nginx-rtmp ni el
  ingress de LiveKit (StreamHub plano WebRTC).
- **HLS push:** URL del playlist (`…/index.m3u8`); los segmentos se suben con PUT al mismo directorio.
- **StreamHub:** ver §5.

Cada salida muestra `running` / `backoff` (reconectando, con el error) en la UI y en `encoder_output_up` de métricas.
Un destino caído reintenta con backoff 1 s → 30 s sin afectar a los demás.

## 4. Redundancia

- **Entrada:** `backup` (otra entrada IP) para entradas IP; si fallan ambas, negro + silencio. Las entradas SDI/HDMI/V4L2
  pasan al slate "SIN SEÑAL / NO SIGNAL" cuando la tarjeta deja de entregar cuadros (`timeoutMs`, default 2 s) y vuelven
  solas.
- **Salida:** misma señal a dos destinos (dos salidas SRT a primario y backup) o UDP por dos NICs (`iface`).
- **Equipo 1+1:** dos encoders publicando a las keys primaria y backup de la misma room de StreamHub (feature `backup`
  del ingress RTMP).

## 5. StreamHub

**Modo nativo (recomendado cuando el core lo tiene):** panel *StreamHub nativo* → URL de StreamHub → **Emparejar** →
aparece un código `XXXX-XXXX` (vence en 10 min) → en el dashboard: app → Encoders → *Reclamar* con ese código →
vincular cada canal a una room (RTMP para WebRTC/HLS con transcode, SRT para HEVC passthrough). El encoder recibe los
destinos solo; nadie tipea keys. Desde el dashboard se ven estado/fps/bitrate y se puede iniciar/detener/reiniciar o
aplicar un perfil. Si en el dashboard se revoca el equipo, el encoder borra la credencial y quita esas salidas.

**Modo "funciona hoy":** salida tipo `streamhub` con `baseUrl`, `app`, un token `sk_` **con scope de la app** y
`protocol: rtmp|whip`. El encoder crea el ingress y lo reusa entre reinicios. Usar H.264 progresivo.

## 6. Monitoreo

- `/metrics` (Prometheus). Alertas sugeridas:
  - `encoder_channel_up == 0` con `encoder_channel_enabled == 1` durante 30 s → canal caído;
  - `increase(encoder_engine_restarts_total[10m]) > 0` → el engine se reinició (ver logs);
  - `increase(encoder_engine_stalls_total[10m]) > 0` → el engine se colgó y el watchdog lo reemplazó (driver/captura);
  - `encoder_fps < 0.98 * <fps esperado>` → el equipo no llega en tiempo real (CPU/GPU saturada);
  - `encoder_output_up == 0` → destino caído / reconectando;
  - `increase(encoder_ts_cc_errors_total[5m]) > 0` → el TS interno perdió paquetes (buffers del kernel, CPU).
- Logs: `journalctl -u encoderd` (JSON) y por proceso en la UI (**Logs**) o `GET /channels/<id>/logs?proc=…`.
- Dry-run: botón **Pipeline** muestra los comandos exactos de GStreamer/ffmpeg — útil para soporte.

## 6b. Funciones profesionales

- **Usuarios:** entrar como `admin` (clave inicial en `/var/lib/streamhub-encoder/initial-admin-password`, se cambia al
  primer login). Crear operadores y visores con `POST /api/v1/users {"name","password","role"}`; tokens para
  automatización con rol con `POST /api/v1/tokens {"name","role"}` (el valor se muestra una sola vez). Auditoría en
  `GET /api/v1/audit`.
- **HDR / 10-bit:** `video.bitDepth: 10` (+ `chroma: "422"` solo x265), `video.hdr: "hlg"|"pq"`; para PQ se puede dar
  `masterDisplay` (sintaxis x265) y `maxCll`. La fuente debe ser HDR para que tenga sentido: el encoder señaliza y
  convierte formato, no hace tone-mapping.
- **Escalera ABR:** `video.renditions: [{width,height,bitrateKbps}]`. Una salida HLS con `hls.ladder: true` publica
  todas las variantes con master playlist (TS; CMAF en beta); una salida RTMP/SRT/UDP con `rendition: N` envía solo esa.
  Las salidas TS sin `rendition` llevan la escalera completa (útil para un packager).
- **Audio multipista:** `audio.lang` y `audio.tracks: [{lang, channels, map, codec, bitrateKbps}]`; con DeckLink, `map`
  elige los canales embebidos (0..15) de cada pista.
- **SCTE-35:** habilitar `scte35: {"enabled": true}` en el canal (no reinicia) y disparar con el botón **SCTE-35** de la
  UI o `POST /api/v1/channels/<id>/scte35`. Los cues viajan en el TS (SRT/UDP/RTP/archivo); RTMP/WHIP/HLS no los llevan.
- **Alarmas:** se configuran por canal en `alarms` (tiempos, umbral de silencio, % de caída de bitrate, objetivo de
  loudness −23/−24 LUFS) y los destinos en `PUT /api/v1/notify` (webhooks con firma `X-Encoder-Signature` y traps SNMP;
  MIB en `docs/STREAMHUB-ENCODER-MIB.txt`). `POST /api/v1/notify/test` manda un evento de prueba.
- **RIST:** salida `rist://host:puerto-par` con `rist.bonding` para enviar por varios enlaces a la vez.
- **Grabación rotativa:** salida `record` con directorio, `segmentSeconds` y `maxSegments` (anillo).

## 7. Backup y restauración

`GET /api/v1/config/backup > encoder-backup.json` y `PUT /api/v1/config/backup` con ese archivo en el equipo nuevo.
El backup **no lleva secretos** (passphrases, stream keys, tokens, claves de webhooks/SNMP van como `***`): en el mismo
equipo el restore conserva los guardados; en un equipo nuevo el `PUT` responde `422` con cada campo a completar
("re-enter") y hay que reemplazar esos `***` por los valores reales en el JSON. El archivo local es
`/var/lib/streamhub-encoder/encoderd.json` (0600) con una copia `.bak` de la versión anterior.

## 8. Problemas comunes

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| canal en `error` con "element … is not available" | encoder/plugin ausente (p. ej. NVENC sin driver) | Capacidades; instalar driver/plugin; `systemctl reload encoderd` |
| canal en `reconnecting` en loop | la entrada no abre (URI mal, puerto ocupado, sin señal en V4L2) | Logs del engine |
| salida en `backoff` | destino rechaza (key, passphrase, codec) o caído | Logs de la salida; preset con warnings |
| fps por debajo del objetivo | CPU saturada (x265 / 4K) | bajar preset, usar HW, menos canales (tabla de densidad) |
| WHIP no conecta | NAT/firewall UDP hacia el SFU | el SFU debe ser alcanzable por UDP; probar desde el mismo segmento |
