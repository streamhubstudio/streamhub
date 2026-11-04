# Capacidad y recursos (G2) — mediciones reales + techo por nodo

**Resumen ejecutivo:** en el nodo de producción (media01, 8 vCPU / 8 GB, **sin GPU**)
el **cuello de botella es la RAM del egress room-composite (Chrome headless)**: **cada
grabación cuesta ~1.27 GB** medido. Con eso, un nodo de 8 GB aguanta **~4-5 grabaciones
room-composite concurrentes**. La palanca #1 es usar **track-egress (ffmpeg, sin
navegador)** para el caso común (1 publisher → MP4): baja el costo a ~250 MB y **quintuplica**
la concurrencia. Las cámaras **ws-mjpeg** (CCTV) son baratísimas en RAM — el límite ahí es la
**red**, no el CPU/RAM.

> Método: mediciones **acotadas sobre producción sin saturarla** (1 stream + 1 egress, medir,
> parar) y extrapolación. Marcado **[medido]** vs **[extrapolado]**.

## 1. Baseline y costo por unidad (medido 2026-07-02)

| Componente | RAM | CPU | Nota |
|---|---|---|---|
| Host idle (sin tráfico) | **936 MB usado** / 6.8 GB disp | load ~0.04 | 8 GB total + 8 GB swap (0 usado) |
| egress idle (Chrome tibio) | **819 MB** | 0.7% | contenedor egress con pool Chrome, sin grabar |
| ingress idle | 270 MB | 0.05% | |
| livekit-server (nativo) | ~77 MB | ~0.1% | binario systemd, no contenedor |
| core (NestJS 2.x) | ~111 MB | ~0.2% | medido sobre el core Node; el core Go 3.x es un binario estático, re-medir |
| **1 grabación room-composite (Chrome)** | **1.274 GiB** [medido] | **~0.9 core (87%)** | 13 procesos Chrome, 177 PIDs; +455 MB sobre el idle del contenedor |
| 1 publisher WebRTC + N subs | ~decenas de MB en livekit | bajo | el SFU es liviano; el techo de viewers es NIC (ver §4) |
| 1 cámara **ws-mjpeg** (ESP32) | **~pocos MB** [extrapolado del diseño] | ~0 | último frame en memoria + conexión WS ~50 KB; el costo es ancho de banda |

Recuperación: al parar la grabación el egress vuelve a 820 MB en segundos. Prod no se afectó.

## 2. Techo de grabaciones concurrentes (el número que importa)

Presupuesto de RAM: 8 GB − ~1.5 GB (sistema + core + livekit + redis + ingress idle) ≈ **6.5 GB
para egress**.

| Modo egress | RAM/grabación | Concurrencia en 8 GB | Cuándo |
|---|---|---|---|
| **Room-composite (Chrome)** — actual | **~1.27 GB** [medido] | **~4-5** [extrapolado] | composición multi-participante / layout / overlays |
| **Track-composite (ffmpeg)** | ~250-400 MB [extrapolado, docs LiveKit] | **~15-20** | 1 audio + 1 video → MP4 (el caso común) |
| **Track egress (ffmpeg)** | ~150-250 MB [extrapolado] | **~25+** | un solo track crudo |

⚠️ **Nota Fase 0:** el `docker-compose.yml` pone `mem_limit: 2g` al contenedor egress — con
room-composite a 1.27 GB eso cae a **~1 grabación concurrente**. Para un nodo de grabación
subí `EGRESS_MEM_LIMIT` (o movés a track-egress). En media01 (plain-server, `docker run` sin
límite) no aplica ese cap hoy.

## 3. Palanca #1 — track-egress (ffmpeg) en vez de Chrome

LiveKit ofrece varios egress: **Room Composite** (Chrome headless, compone un layout HTML —
lo que medimos, ~1.27 GB) vs **Track / Track-Composite** (ffmpeg puro, **sin navegador**).
Para el caso dominante de StreamHub — **una cámara/publisher → un MP4** — no hace falta
componer nada: **track-composite ffmpeg** produce el mismo MP4 a **~1/5 de la RAM y sin los 13
procesos Chrome**. Recomendación:

- **Grabación simple (1 publisher)** → track-composite ffmpeg. **5× más grabaciones/nodo.**
- **Composición (varios participantes, PiP, overlays, marca)** → room-composite Chrome (se
  justifica el costo).
- Implementación: es un cambio de `recording.service` (elegir el tipo de egress según nº de
  publishers del room / flag por app). **Alto impacto, esfuerzo M** — ataca directo el blocker
  de recursos de la evaluación (`PRODUCT-EVALUATION.md`).

## 4. Techo de viewers y de cámaras

- **WebRTC (interactivo)**: el SFU reenvía; el techo es **NIC (~1 Gbps) → ~300-400 viewers/nodo**
  a ~2.5 Mbps (coincide con `DISTRIBUTION-CDN-P2P.md`). Para masivo: HLS + CDN/P2P, no WebRTC.
- **HLS servido por el nodo**: cacheable; con CDN pull-zone (Bunny) un origin de 8 GB alimenta
  eventos de 10k-100k (ver el doc de distribución).
- **Cámaras ws-mjpeg (CCTV)**: RAM ~despreciable → el límite es **red**. QVGA 8 fps ≈ 0.5 Mbps
  → **cientos de cámaras** por nodo de 1 Gbps (315 Mbps para 615 cám QVGA — entra); VGA 15 fps
  (~2-3 Mbps) satura la NIC mucho antes. Para flotas grandes: QVGA + varios nodos.

## 5. Offload al nodo GPU (RTX 3090 · ~90 GB RAM)

Qué conviene mover al nodo GPU (se une al cluster con `install.sh --join`, comparte el redis
del origin):

| Carga | En 8c/8GB (media01) | En RTX 3090 | Ganancia |
|---|---|---|---|
| **Transcode ladder** (RTMP ingest, VOD adaptativo) | CPU x264, caro | **NVENC** paralelo (docenas de encodes) | libera el CPU del origin; ladder "gratis" |
| **Egress/grabación** | Chrome 1.27 GB c/u | GPU-accel + 90 GB RAM | decenas de grabaciones concurrentes |
| **YOLO** (plugin) | CPU, lento | CUDA | tiempo real multi-cámara |

Con el transcode y el egress en el 3090, media01 queda para el **plano de control + SFU +
ws-mjpeg** (donde ya es eficiente).

## 6. Traducción a números de negocio (defaults de quota / pricing por nodo)

Por caja de **8 vCPU / 8 GB sin GPU** (medido/extrapolado):

| Perfil de nodo | Capacidad realista |
|---|---|
| **CCTV (ws-mjpeg)** | **cientos de cámaras** QVGA (límite red, no RAM) — el caso barato |
| **Grabación (room-composite Chrome, hoy)** | **~4-5 grabaciones concurrentes** |
| **Grabación (track-egress ffmpeg, propuesto)** | **~15-20 grabaciones concurrentes** |
| **En vivo interactivo (WebRTC)** | ~300-400 viewers (o pocas salas grandes) |
| **Evento masivo** | 1 origin + CDN/P2P → 10k-100k (no en el nodo) |

**Default de quota sugerido** por app en un nodo compartido de 8 GB: `max_concurrent_streams`
~10, `max_concurrent_recordings` ~3 (Chrome) / ~10 (ffmpeg). **Pricing por nodo:** un VPS
8c/8GB (~$40-60/mo) sirve un cliente CCTV chico-mediano o ~5 grabaciones simultáneas — margen
sano sobre AntMedia EE ($109/mo/instancia) con nuestra infra bundled.

## 7. Roadmap de optimización (priorizado)

1. **[Alto/M] Track-egress ffmpeg para grabación simple** — 5× concurrencia, ataca el blocker.
2. **[Alto/S] Subir `EGRESS_MEM_LIMIT`** en nodos de grabación (o dejar sin cap y monitorear).
3. **[Alto/L] Offload transcode+egress al nodo GPU** (NVENC) vía cluster join.
4. **[Medio/M] Autoscaling de egress** — no mantener el pool Chrome tibio (819 MB idle) si el
   nodo no graba; o pasar a ffmpeg que no tiene ese costo base.
5. **[Medio] Observabilidad** (deploy/observability/ ya listo) para ver el techo en vivo y
   alertar antes de saturar (RAM >85%, ver `OBSERVABILITY-ROADMAP.md`).

*Mediciones tomadas en producción sin saturar (1 stream + 1 egress, medir, parar). Reproducibles
con el harness de `streamhub-core-go/test/bench/latency/` + `POST /apps/:app/streams/:id/record/start`.*
