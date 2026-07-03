# Latencia — mediciones reales y guía de tuning (G1)

**Resultado ejecutivo: StreamHub ya cumple el objetivo G1 (WebRTC ≤0.5s, paridad
AntMedia EE) con margen ×2.5, medido empíricamente contra producción.** El
pipeline WebRTC agrega **~35ms** por encima de la red; el resto es RTT físico.

Método: **reloj quemado en píxeles** — harness reproducible en
[`bench/latency/`](../../bench/latency/README.md) (28 bits de `Date.now()` + checksum
codificados en bloques, decodificados frame a frame en el subscriber;
publisher y subscriber en la misma máquina ⇒ mismo reloj, red real).

## Mediciones (2026-07-02 · 8c/8GB VPS · cliente con RTT 158ms · 30s c/u)

| # | Path / configuración | p50 | p95 | muestras |
|---|---|---|---|---|
| 1 | **WebRTC puro — defaults (simulcast ON, VP8)** | **193 ms** | 204 ms | 601 |
| 2 | WebRTC puro — repetición (estabilidad) | 193 ms | 203 ms | 499 |
| 3 | WebRTC puro — **sin simulcast** | 294 ms | 332 ms | 705 |
| 4 | WebRTC puro — H264 | 213 ms | 223 ms | 501 |
| 5 | WebRTC puro — **bajo carga** (egress HLS Chrome activo + viewer /play) | 212 ms | 232 ms | 515 |
| 6 | WebRTC puro — post-tuning L1 (buffers UDP 16MB) | 193 ms | 241 ms* | 313 |
| 7 | **HLS-live** (room-composite SegmentedFileOutput) | **15.2 s** | 15.2 s | 795 |
| 8 | RTMP-ingress (OBS/ffmpeg → transcode) | ~2 s | — | medición funcional previa |

\* ruido post-restart de LiveKit (ICE re-warm); el p50 no cambió — esperado: los buffers protegen bajo carga, no el vacío.

**Lecturas clave:**
- El pipeline (captura+encode+SFU+jitter adaptativo+decode+render) cuesta
  **193−158 = ~35ms** (la media recorre la red 2 veces al medir en una máquina).
  En topología real: `G2G ≈ 35ms + one-way(pub→server) + one-way(server→viewer)`
  → con clientes en región (~20ms one-way) ≈ **75ms glass-to-glass**.
- **Simulcast ON es MEJOR para latencia** (+100ms sin simulcast): el subscriber
  arranca por la capa rápida. No desactivarlo "para optimizar".
- VP8 (default) le gana ~20ms a H264 en este pipeline de navegador.
- Un **egress Chrome activo cuesta solo +19ms p50** en 8 cores ociosos — el
  compositing convive bien con el SFU mientras haya CPU (ver L2 para el techo).
- La **palanca #1 para bajar de ~190ms es acercar el server al cliente** (edge
  nodes / cluster — `install.sh --join`), no tunear LiveKit: el jitter buffer
  adaptativo y el congestion control default (TWCC/NACK/PLI) ya operan cerca del
  óptimo con red buena.

## Config del server (auditada en prod, LiveKit 1.13.2 nativo)

Lo que ya está bien y NO hay que tocar: UDP mux único (7882) con
`use_external_ip: true` (media directo a la IP pública, **no pasa por nginx** —
nginx solo proxya la señalización `/rtc`), congestion control default,
`redis` compartido para afinidad.

### Palancas aplicadas / recomendadas

| # | Palanca | Estado | Efecto |
|---|---|---|---|
| L1 | **Buffers UDP kernel 4MB→16MB** (`net.core.rmem_max/wmem_max=16777216`) | ✅ aplicado en your-server (`/etc/sysctl.d/99-streamhub-webrtc.conf`) y **en install.sh** para todo nodo nuevo | evita drops/NACK bajo carga múltiple; protege p95/p99 |
| L2 | **Aislar egress (Chrome)**: hoy corre sin límite de CPU/RAM en el mismo host | pendiente (G2) | un Chrome sin límite puede comerse los 7.7GB / robar ciclos al SFU; poner `mem_limit`+`cpus` o mover al nodo GPU |
| L3 | **playout delay bajo** — no es config del server yaml; se setea por track/room desde el SDK | pendiente (preset "low-latency" en G4) | fuerza el jitter buffer a mínimo; útil en redes con jitter, riesgo de frames congelados |
| L4 | Codecs: dejar VP8 default; no habilitar AV1 para casos low-latency con clientes débiles | documentado | AV1/VP9 suben encode/decode en hardware débil |
| L5 | **TURN deshabilitado**: clientes con UDP bloqueado caen a ICE-TCP (7881) con latencia mucho peor o no conectan | pendiente (decisión) | habilitar TURN/UDP mejora cobertura ~5-15% de redes restrictivas sin afectar el p50 del resto |
| L6 | Doble hop señalización wss→nginx→7880 | no tocar | solo afecta el handshake inicial, no la media |

### HLS y RTMP — qué es alcanzable

- **HLS actual: ~15s** (room-composite → segmentos .ts). Para bajar: segmentos de
  2s + `liveSyncDuration` corto en el player (~6-8s), y el salto real es
  **LL-HLS/CMAF** (~2-3s) — está en la matriz G3 (gap AntMedia).
- **RTMP: ~2s** — inherente al ingest RTMP + transcode del ingress. Para
  baja latencia de publicación usar **WHIP** (WebRTC ingest, puerto 8080) que va
  por el path de ~35ms, o publicar desde el navegador (widget Transmitir).

### Reproducir las mediciones

Ver [`bench/latency/README.md`](../../bench/latency/README.md). Regla de oro del
brief: **medir antes y después de cada cambio** — el harness tarda 40s por corrida.
