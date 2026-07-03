# bench/latency — harness de latencia glass-to-glass (G1)

Mide la latencia **end-to-end real** (glass-to-glass) de StreamHub con el método
**reloj quemado**: el publisher dibuja `Date.now()` codificado en **32 bloques
binarios de píxeles** (28 bits de timestamp + 4 de checksum XOR — robusto a la
compresión, sin OCR) en un canvas a 30fps y lo publica; el subscriber decodifica
cada frame recibido (`requestVideoFrameCallback`) y computa
`latencia = Date.now() − timestamp decodificado`. Publisher y subscriber corren
en la **misma máquina** → mismo reloj, cero problemas de sincronización; la red
hasta el server es internet real.

## Uso

```bash
npm i puppeteer-core            # runner headless (usa el Chrome instalado)

# tokens (Bearer sk_ del server):
curl -s -X POST -H "Authorization: Bearer sk_..." -H "Content-Type: application/json" \
  https://<dominio>/api/v1/apps/<app>/tokens -d '{"room":"bench","identity":"pub","canPublish":true}'
# (ídem canPublish:false para el de suscripción)

# WebRTC puro (publisher + subscriber en la misma página):
node run-latency.js "file://$PWD/latency-page.html?ws=wss://<dominio>&pubtoken=<T1>&subtoken=<T2>&secs=30"

# variantes: &simulcast=0  &codec=h264|vp9|av1  &fps=  &res=
# solo publicar (para medir HLS/otro subscriber aparte):  &mode=pub&secs=150
# subscriber HLS (contra un egress HLS ya arrancado):
node run-latency.js "file://$PWD/latency-page.html?mode=hls&hlsurl=https://<dominio>/hls/<app>/<room>/index.m3u8&secs=30"
```

Salida: JSON con `samples, p50, p90, p95, min, max, mean, badDecodes`.

## Resultados medidos (2026-07-02, 8c/8GB VPS, RTT cliente↔server 158ms)

| Path | Config | p50 | p95 | Notas |
|---|---|---|---|---|
| **WebRTC puro** | defaults (simulcast on, VP8) | **193 ms** | 204 ms | 601 muestras, 0 bad decodes; reproducible (2ª corrida p50=193) |
| WebRTC puro | sin simulcast | 294 ms | 332 ms | ⚠️ peor — simulcast ON ayuda (el subscriber toma la capa rápida) |
| WebRTC puro | H264 | 213 ms | 223 ms | VP8 gana ~20ms en este pipeline |

Como publisher y subscriber corren en la misma máquina, la media recorre la red
**dos veces** (subida al SFU + bajada): 193ms − 158ms de RTT ⇒ el **pipeline
completo (captura+encode+SFU+jitter adaptativo+decode+render) agrega solo
~35ms** — prácticamente el piso físico. En topología real,
`G2G ≈ 35ms + one-way(publisher→server) + one-way(server→viewer)`; con ambos en
la región del server (~20ms one-way) da **~75ms glass-to-glass**.
**El objetivo G1 (≤0.5s, paridad AntMedia EE) se cumple con margen ×2.5 aun
intercontinental.** La palanca #1 para bajar más es acercar el server al cliente
(edge nodes — ver cluster), no tunear LiveKit: el jitter buffer adaptativo y el
congestion control default ya operan cerca del óptimo en red buena. El tuning
(buffers UDP 16MB, playout delay bajo, aislar egress) protege el **p95/p99 bajo
carga**, no el p50 en vacío.

(HLS y RTMP: ver `streamhub-docs/features/hls-live.md` y las mediciones del
informe G1 — órdenes de magnitud mayores por naturaleza del protocolo.)
