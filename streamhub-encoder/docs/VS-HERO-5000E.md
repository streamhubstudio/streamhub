# StreamHub Encoder vs. Media Excel HERO 5000E (Heynen)

Comparación punto por punto con el **datasheet del HERO HEVC Encoder 5000E** (Heynen, PDF del 2014-08-26; lo que el
datasheet no dice figura como "no especificado"). Para StreamHub Encoder la columna **Estado** dice si el ítem está
**probado** (pasa un test automático: unit o e2e en `docs/TEST-REPORT.md`), **implementado** (código y goldens, sin
hardware para probarlo en el banco) o **no** lo tiene. Los números salen de `TEST-REPORT.md`.

## Resumen

| | HERO 5000E | StreamHub Encoder |
|---|---|---|
| Plataforma | appliance 1U cerrado (x86, software propietario) | software Linux en cualquier x86 (o contenedor), GStreamer + Go |
| Codecs de video | solo HEVC 4:2:0 8-bit | **H.264 y HEVC**, Main10 y 4:2:2 10-bit (x265), HDR HLG/PQ |
| Formatos | hasta 1080i / 1080p30 / 720p60 | **2160p30 beta** (NVENC 8/10-bit en el límite del tiempo real: 28.5–30 fps según la corrida, conversión en CPU; x265 no llega), 1080p50/60, 1080i (x264 PAFF o desentrelazado). 2160p60 NVENC 8-bit tiene un issue abierto (altura 2176 en el SPS) |
| Encoders | uno (propio) | x265, x264, **NVENC** (probado en RTX 3090), QSV y VA-API (implementados) |
| Transporte | MPEG-TS sobre UDP / ASI | UDP/RTP-TS, **SRT** (AES-128/256), **RIST** (bonding), **RTMP/RTMPS**, **WHIP**, **HLS/CMAF push**, grabación |
| Salidas simultáneas | no especificado | N por canal, **en caliente** sin cortar el encode ni las otras |
| ABR | no | **escalera ABR** (N renditions con GOP alineado) + HLS master playlist (TS probado; CMAF beta) |
| Gestión | web embebida, SNMP, LCD | **API REST + OpenAPI**, UI web con **usuarios/roles + HTTPS + auditoría**, **Prometheus**, **SNMP traps v2c/v3**, webhooks, **StreamHub** como consola central |
| Latencia | no especificada | **medida**: ver tabla de latencia |
| Precio/licencia | hardware cerrado | software; x264/x265 GPL, HEVC/AAC con patentes (ver LICENSING.md) |

## Entradas

| Datasheet 5000E | StreamHub Encoder | Estado |
|---|---|---|
| SD-SDI SMPTE 259M, HD-SDI 292M (10-bit) | DeckLink (`decklinkvideosrc`), auto-detección de formato, 3G/6G/12G según la tarjeta | implementado (sin tarjeta en el banco; checklist en HARDWARE-ACCEPTANCE.md) |
| HDMI | DeckLink HDMI, capturadoras UVC / Magewell (V4L2) | implementado |
| Video analógico (componentes, S-Video, compuesto) | no (conversor externo analógico→SDI) | **no — el 5000E gana** |
| MPEG-2/H.264 sobre TS/IP | UDP/RTP-TS (multicast), **SRT** listener/caller, RTMP, RTSP, archivo en loop | **probado** (UDP, SRT, archivo) |
| Sync input (black-burst/tri-level) | no (el reloj lo da la captura; genlock de la tarjeta) | no |
| 8 canales de audio embebido SDI | **hasta 16** con mapeo por pista | implementado (mapeo probado en goldens; 16 canales requieren la tarjeta) |
| 2 ch AES/EBU, 4 ch analógicos | interfaz ALSA externa | parcial (ALSA para V4L2) |
| Audio MPEG-1/AAC/AC-3 en TS/IP | se decodifica y recodifica (AAC/AC-3/MP2) | probado (AAC); passthrough sin recodificar: no |
| — | **Failover de entrada** primaria → backup → negro/silencio, sin cortar la salida | **probado** (salida continua, 0 errores CC) |
| — | Slate "SIN SEÑAL" para SDI/HDMI/V4L2 | implementado (misma lógica probada con la entrada de test) |

## Procesamiento

| Datasheet 5000E | StreamHub Encoder | Estado |
|---|---|---|
| HEVC "HM11 compliant" | x265 4.x / NVENC (bitstreams verificados con FFmpeg) | **probado** |
| — | **H.264** (x264, NVENC) | **probado** |
| GOP configurable, jerárquico | GOP, B-frames, B-pyramid, GOP alineado entre renditions | **probado** |
| CBR / VBR / VBR con tope | CBR con relleno HRD (x264/x265), VBR con tope, TS CBR con nulos (`muxRateKbps`) | **probado** (±10 %; TS CBR ±3 %) |
| Perceptual rate control, scene change | AQ / psy-rd / scenecut de x264/x265 | implementado (defaults de los encoders) |
| De-interlacing adaptativo | `deinterlace` (greedyh), o encode entrelazado PAFF (x264) | **probado** (1080i50 → p25 y 1080i50 tt) |
| Deblocking, NR, nitidez, color | no expuesto (planificado) | no |
| Recorte, escalado anti-aliasing | escalado con borde (letterbox) automático | probado |
| Logo con alpha | **logo PNG con alfa** + texto + reloj + **timecode quemado** | implementado (logo), **probado** (timecode/reloj/texto) |
| Down-mix, resampling | down/up-mix por matriz, 48 kHz | probado |
| Medición de niveles | **EBU R128 / ATSC A/85** (M, S, I, LRA) + pico por canal en UI y métricas | **probado** |
| Normalización dinámica | no (requiere gst-plugins-rs audiofx o control del engine) | **no** (próxima fase) |
| — | **HDR**: HLG y PQ/HDR10 con mastering display + MaxCLL | **probado** |
| — | **10-bit Main10** (x265, NVENC) y **4:2:2 10-bit** (x265) | **probado** |

## Salidas

| Datasheet 5000E | StreamHub Encoder | Estado |
|---|---|---|
| HEVC SD 0.1–6 Mbps / HD 0.5–20 Mbps | 0.1–80 Mbps, hasta 2160p30 (2160p60 NVENC: issue abierto) | **beta** (4K30 NVENC 8/10-bit: 28.5–30 fps según la corrida) |
| 576i/480i, "PiP o resoluciones menores" | cualquier resolución menor; SD por escalado | probado (escala) |
| Dolby E / AC-3 passthrough | AC-3 **encode**; passthrough y Dolby E: no | **no — el 5000E gana** (si se usa Dolby E) |
| AAC-LC / HE-AAC | AAC-LC, AC-3, MP2 (HE-AAC no: licencia fdk) | **probado** (AAC, AC-3) |
| MPEG-TS UDP unicast/multicast | **probado**, TTL, interfaz, RTP (RFC 2250) | **probado** |
| SPTS sobre DVB-ASI | no (placa DekTec, a demanda) | **no — el 5000E gana** |
| PMT/PAT configurables | PIDs de video/audio configurables, PIDs fijos por pista/rendition | probado |
| Pro-MPEG FEC | no (usar SRT/RIST, que recuperan pérdida) | no |
| **SCTE-35 insertion** | **por API** (splice_insert inmediato/programado, time_signal con segmentation, splice_null) | **probado** (cues leídos del TS recibido por SRT) |
| Salida dual GigE | misma señal a N destinos, **SRT a primario + backup**, **RIST bonding** | **probado** |
| — | **SRT** (AES-128/256, caller/listener, streamid) | **probado** (5 % y 10 % de pérdida sin errores) |
| — | **RIST** Simple Profile (ARQ) + bonding | **probado** (ARQ con 3 % de pérdida); bonding implementado, **beta** |
| — | RTMP/RTMPS, Enhanced RTMP (HEVC), WHIP, HLS/CMAF push, grabación rotativa | **probado** |
| — | Closed captions 608/708 passthrough | **no funciona todavía** (e2e: los captions de una entrada IP no llegan a la salida) |
| — | Timecode en SEI pic_timing (H.264) | **probado** |

## Gestión, monitoreo y seguridad

| Datasheet 5000E | StreamHub Encoder | Estado |
|---|---|---|
| Web embebida | UI web con login, roles admin/operador/visor, **HTTPS**, miniaturas en vivo, medidores, alarmas | **probado** |
| Panel LCD 2×16 | no (UI web / StreamHub) | **no — el 5000E gana** en el frente del rack |
| Import/export de config | `GET/PUT /config/backup` | **probado** |
| SNMP MIB-II + traps | **traps v2c/v3** (MIB propia `STREAMHUB-ENCODER-MIB`); MIB-II la da `snmpd` del sistema | **probado** (traps) |
| Alarmas audiovisuales | pérdida de entrada, **negro, congelado, silencio**, caída de bitrate, engine caído, salida caída, loudness fuera de rango; webhooks firmados + SNMP + Prometheus | **probado** |
| Actualización remota | paquete `.deb` / imagen Docker | probado (.deb instalado y removido en Ubuntu 26.04) |
| — | **API REST** con OpenAPI, tokens con rol, auditoría | **probado** |
| — | **Gestión central StreamHub**: emparejamiento por código, destinos y comandos remotos | **probado** contra un core real |
| — | Reinicio automático del engine (crash, cuelgue), config persistente | **probado** (recuperación en ~1.5 s) |
| — | Estado de sincronismo NTP/PTP | implementado |
| HDD redundante, fuente doble, 4 GigE bonding | dependen del servidor elegido (RAID1, PSU redundante, bonding Linux) | según hardware |

## Dónde el 5000E todavía gana

1. **DVB-ASI** de salida (no tenemos placa ASI; DekTec a demanda).
2. **Entradas analógicas** (componentes, S-Video, compuesto) sin conversor externo.
3. **Dolby E / AC-3 passthrough** bit-exacto desde SDI o TS.
4. **Panel frontal LCD** con teclado y presets.
5. **Pro-MPEG FEC** sobre UDP (nosotros recuperamos pérdida con SRT/RIST, que es mejor por internet, pero un IRD que solo
   entiende FEC no lo aprovecha).
6. **Appliance cerrado listo de fábrica** (chasis, certificaciones FCC/CE): StreamHub Encoder es software; el appliance
   depende del servidor que se elija.
7. **Validación en campo con tarjetas SDI reales**: el 5000E la tiene de fábrica; nosotros tenemos la checklist de
   aceptación pendiente de correr con una DeckLink.
