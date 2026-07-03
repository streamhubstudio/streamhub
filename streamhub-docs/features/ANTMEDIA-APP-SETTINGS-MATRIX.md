# Matriz de paridad — AntMedia AppSettings (por aplicación) vs StreamHub `config.yaml`

> **Objetivo.** Relevar TODAS las opciones de configuración *por aplicación* que ofrece
> Ant Media Server (CE + EE) y contrastarlas con el `config.yaml` per-app de StreamHub,
> para decidir qué knobs vale la pena agregar.
>
> **Fuente AntMedia.** `src/main/java/io/antmedia/AppSettings.java` del repo
> [ant-media/Ant-Media-Server](https://github.com/ant-media/Ant-Media-Server) (rama
> `master`). Se relevaron **178 anotaciones `@Value`** (≈170 settings per-app únicos). Los
> nombres son **exactos** tal cual viajan en `red5-web.properties` / el panel de AntMedia.
> El default entre paréntesis es el del código.
>
> **Fuente StreamHub.** [`config-reference.md`](../config-reference.md) (el `config.yaml`
> per-app: `recording`, `s3`, `webrtc`, `rtmp`, `callbacks`, `features`) y
> [`operations/ENV.md`](../operations/ENV.md) (variables globales de proceso).
>
> **Diferencia de arquitectura (leer primero).** AntMedia es un **media server monolítico**:
> ingesta *un* stream y lo mux­ea/transcodifica él mismo a HLS/DASH/MP4/WebRTC, aplicando el
> ladder ABR *server-side por stream*. StreamHub es un **SFU (LiveKit)**: el WebRTC de baja
> latencia usa **simulcast del cliente** (el servidor no transcodifica el WebRTC a un ladder
> de bitrates), el HLS/recording sale por **egress** (Chrome headless → LiveKit egress) y el
> ingest externo entra por el **ingress service** de LiveKit. Esto define qué settings de
> AntMedia son **portables** (config → core), cuáles requieren **trabajo en LiveKit
> egress/ingress**, y cuáles son **N/A por arquitectura** (el WebRTC transcodificado
> server-side, LL-HLS/DASH nativo, o los tuning de red WebRTC que en LiveKit son globales de
> proceso, no per-app).
>
> **Leyenda de estado StreamHub:** ✅ sí · 🟡 parcial · ❌ no. **Esfuerzo:** S (plumbing de
> config en el core) · M (requiere pasar params a egress/ingress de LiveKit + core) · L
> (trabajo de media no provisto por LiveKit / semi-arquitectónico).

---

## 1. ABR / Adaptive bitrate ladder

En AntMedia el ladder se define con **un** setting central (`encoderSettingsString`) más
flags de codec y el algoritmo ABR de conmutación WebRTC. En StreamHub el ladder vive en
`webrtc.layers` (solo `height`, sin bitrate) y se materializa como **simulcast** (WebRTC) o
como **layers del ingress transcodificado** (RTMP/URL).

| Setting AntMedia (exacto) | Qué hace | StreamHub hoy | Valor usuarios | Esf. |
|---|---|---|---|---|
| `encoderSettingsString` (`""`) | Ladder ABR como CSV/JSON: `height,videoBitrate,audioBitrate` por rendición (ej. `480,300000,96000,360,200000,64000`). Vacío = modo SFU (sin transcode). | 🟡 `webrtc.layers:[{name,height}]` — **solo altura**, sin bitrate ni audioBitrate. | Alto — control fino de calidad/costo por rendición | M |
| `forceDecoding` (`false`) | Fuerza decodificación aunque no haya ABR. | ❌ | Bajo | M |
| `forceAspectRatioInTranscoding` (`false`) | Ajusta la altura para respetar exactamente el aspect ratio de origen. | ❌ (LiveKit deriva width del aspect) | Bajo-medio | M |
| `encoderSelectionPreference` (`gpu_and_cpu`) | `gpu_and_cpu` \| `only_gpu` para elegir encoder. | 🟡 `transcoding.hwaccel` (`auto`/`gpu`/`cpu`) por app. | Medio | S |
| `encoderName` (`""`) | Fuerza encoder (`h264_nvenc`/`openh264`/`libx264`). | ❌ (implícito en hwaccel) | Bajo | M |
| `hwScalingEnabled` (`false`) | Scaling del frame en GPU cuando hay ABR (build especial). | ❌ | Bajo | L |
| `hwDecoderEnabled` (`true`) | Decodificación HW (`h264_cuvid`). Apagar si hay stuttering PTS en ciertas GPU. | 🟡 dentro de `hwaccel` | Bajo | S |
| `gopSize` (`0`) | Keyframe interval (en frames) del encoder. | ❌ | Medio (impacta latencia/seek) | M |
| `webRTCFrameRate` (`30`) | FPS del video publicado a players WebRTC. | ❌ | Medio | M |
| `encoderThreadCount` / `encoderThreadType` (`0`/`0`) | Threads y modo (auto/frame/slice) del encoder. | ❌ | Bajo | M |
| `vp8EncoderThreadCount` (`1`) | Threads del encoder VP8. | ❌ | Bajo | M |
| `h264Enabled` / `h265Enabled` / `vp8Enabled` / `av1Enabled` (`true`/`false`/`false`/`false`) | Habilita codecs de encoding por app. | ❌ (LiveKit negocia codecs globalmente) | Bajo-medio | L (N/A per-app) |
| `addOriginalMuxerIntoHLSPlaylist` (`true`) | Agrega la calidad original al playlist HLS si hay ABR. | ❌ | Bajo | M |
| `useOriginalWebRTCEnabled` (`false`) | Sirve también la calidad original (además del ladder) en WebRTC. | ❌ (simulcast ya expone todas las capas) | Bajo | — (N/A) |

**Algoritmo ABR de conmutación WebRTC** (todos server-side, EE): `statsBasedABRAlgorithmEnabled`
(`true`), `abrDownScalePacketLostRatio` (`1`), `abrUpScalePacketLostRatio` (`0.1`),
`abrUpScaleRTTMs` (`150`), `abrUpScaleJitterMs` (`30`), y el bloque *Excessive Bandwidth*
(`excessiveBandwidthAlgorithmEnabled` `false`, `excessiveBandwidthValue` `300000`,
`excessiveBandwidthCallThreshold` `3`, `excessiveBandwithTryCountBeforeSwitchback` `4`,
`packetLossDiffThresholdForSwitchback` `10`, `rttMeasurementDiffThresholdForSwitchback` `20`).
→ **N/A**: en LiveKit la selección de capa la hace el propio SFU con su congestion control
(no expuesto como knobs per-app).

---

## 2. Latencia (HLS/DASH segmenting, LL-HLS, WebRTC)

| Setting AntMedia (exacto) | Qué hace | StreamHub hoy | Valor usuarios | Esf. |
|---|---|---|---|---|
| `hlsTime` (`2`) | Duración de segmento HLS (s). El principal knob de latencia HLS. | ❌ fijo por egress LiveKit | **Alto** — trade-off latencia/robustez | M |
| `hlsListSize` (`15`) | Nº de segmentos en el `.m3u8` (0 = todos). Ventana del playlist. | ❌ fijo | Alto | M |
| `hlsflags` (`delete_segments+program_date_time`) | Flags FFmpeg del muxer HLS (`+program_date_time`, `+append_list`, `+round_durations`…). | ❌ | Medio | M |
| `hlsPlayListType` (`""`) | `EXT-X-PLAYLIST-TYPE`: `event` \| `vod`. | ❌ | Medio | M |
| `hlsSegmentType` (`mpegts`) | `mpegts` \| `fmp4` (fmp4 = HEVC/CMAF). | ❌ (egress = TS) | Medio | M |
| `hlsEnableLowLatency` (`false`) | LL-HLS (vía muxer DASH). | ❌ | Alto (pero…) | L (N/A — egress no produce LL-HLS) |
| `hlsEnabledViaDash` (`false`) | HLS a través del muxer DASH (CMAF). | ❌ | Medio | L (N/A) |
| `dashSegDuration` (`6`) | Duración de segmento DASH (s). | ❌ (no hay DASH) | Medio | L (N/A) |
| `dashFragmentDuration` (`0.5`) | Duración de fragmento (moof+mdat) DASH. | ❌ | — | L (N/A) |
| `dashTargetLatency` (`3.5`) | Latencia objetivo del LL-DASH. | ❌ | — | L (N/A) |
| `dashWindowSize` / `dashExtraWindowSize` (`5`/`5`) | Ventana del manifest y segmentos fuera de manifest. | ❌ | — | L (N/A) |
| `dashEnableLowLatency` (`true`) | LL-DASH (chunked CMAF). | ❌ | Alto (latencia ~3s por CDN) | L (N/A — no hay pipeline DASH) |
| `dashHttpStreaming` (`true`) | Envía chunks por HTTP (chunked) en vez de a disco. | ❌ | — | L (N/A) |
| `useTimelineDashMuxing` (`false`) | Usa `<SegmentTimeline>` en DASH. | ❌ | — | L (N/A) |
| `webRTCKeyframeTime` (`2000`) | Cada cuánto (ms) pide keyframe el SFU. | ❌ (LiveKit interno) | Bajo | L (N/A per-app) |
| `originEdgeConnectionIdleTimeout` (`2`) | Idle máx. (s) entre origin y edge (cluster). | ❌ (LiveKit maneja el mesh) | Bajo | — (N/A) |

> **Latencia WebRTC**: StreamHub ya alcanza ≤0.5 s por el path WebRTC nativo de LiveKit (ver
> [`operations/LATENCY-TUNING.md`](../operations/LATENCY-TUNING.md)); ahí la palanca no es un
> setting de app sino el propio SFU. Los knobs de esta sección aplican al **path HLS de
> escala** (hoy 6–15 s), donde `hlsTime`/`hlsListSize` sí serían accionables si el egress los
> expone.

---

## 3. Timeouts

| Setting AntMedia (exacto) | Qué hace | StreamHub hoy | Valor usuarios | Esf. |
|---|---|---|---|---|
| `webRTCClientStartTimeoutMs` (`10000`) | Si un cliente WebRTC (pub/play) no arranca en este tiempo, se cierra. También ventana de reconexión. | ❌ (LiveKit interno) | Bajo | L (N/A per-app) |
| `iceGatheringTimeoutMs` (`2000`) | Timeout del ICE gathering (útil en WHIP). | ❌ (LiveKit) | Bajo | L (N/A) |
| `rtspTimeoutDurationMs` (`5000`) | Timeout al tirar de cámaras/RTSP. | 🟡 relacionado con ingress `url` (LiveKit ingress tiene el suyo, no configurable) | Medio | M |
| `rtmpIngestBufferTimeMs` (`0`) | Buffer (ms) del ingest RTMP para compensar cortes. | ❌ | Bajo | L (N/A — ingress LiveKit) |
| `streamFetcherBufferTime` (`0`) | Buffer (ms) del stream source (pull) para reordenar paquetes. | ❌ | Bajo | M |
| `srtReceiveLatencyInMs` (`150`) | Latencia de recepción SRT. | ❌ (LiveKit no ingesta SRT nativo) | Bajo | L (N/A) |
| `restartStreamFetcherPeriod` (`0`) | Reinicia stream fetchers cada N s. | ❌ | Bajo | M |
| `endpointHealthCheckPeriodMs` (`2000`) | Chequeo de salud de endpoints de re-publish (RTMP push). | 🟡 estado por endpoint vía webhooks de egress (no polling fijo) — ver [restream.md](restream.md) | Medio | — |
| `endpointRepublishLimit` (`3`) | Reintentos antes de dar un endpoint por muerto (`-1` = infinito). | ✅ retry con backoff, límite 3 (fijo) — ver [restream.md](restream.md) | Medio | — |
| `maxAnalyzeDurationMS` (`1500`) | Máx. tiempo de análisis para detectar audio/video en RTMP/SRT/sources. | ❌ | Bajo | M |

---

## 4. Cache (HLS headers, S3/VOD, CDN)

| Setting AntMedia (exacto) | Qué hace | StreamHub hoy | Valor usuarios | Esf. |
|---|---|---|---|---|
| `s3CacheControl` (`no-store, no-cache, must-revalidate, max-age=0`) | Header `Cache-Control` que se pone a los objetos subidos a S3 (HLS/MP4). | 🟡 StreamHub setea cache **en el mount HTTP** del HLS local (`.m3u8` no-cache, `.ts` immutable) pero **no** en los objetos S3 de VOD. | **Alto** — CDN/hit-ratio de VOD | S |
| `s3TransferBufferSizeInBytes` (`10000000`) | Buffer de subida S3 (debe superar el tamaño de segmento TS). | ❌ (SDK maneja) | Bajo | S |
| `s3StorageClass` (`STANDARD`) | Clase de almacenamiento S3 (`GLACIER`, `STANDARD_IA`, `INTELLIGENT_TIERING`…). | ❌ | Medio — costo | S |
| `s3Permission` (`public-read`) | ACL del objeto subido (`public-read`/`private`/…). | 🟡 StreamHub decide público vs presigned vía `s3.public_url` + gate `confirmPublic`. | Medio | S |
| `httpForwardingBaseURL` / `httpForwardingExtension` (`""`/`""`) | Reenvía requests HTTP con ciertas extensiones (`mp4,m3u8`) a otra base URL (offload a CDN). | ❌ | Medio (front CDN) | M |
| `contentSecurityPolicyHeaderValue` (`""`) | Header CSP para los assets servidos. | ❌ | Bajo | S |

> **Cache HLS live**: StreamHub ya hace lo correcto en el mount estático (playlist
> `no-cache`, segmentos `immutable`, CORS abierto) — ver [`hls-live.md`](hls-live.md). El gap
> real es (a) `Cache-Control` sobre los **objetos S3 de VOD** y (b) exponer un knob por app.

---

## 5. Ingest (control de publishers)

| Setting AntMedia (exacto) | Qué hace | StreamHub hoy | Valor usuarios | Esf. |
|---|---|---|---|---|
| `acceptOnlyStreamsInDataStore` (`false`) | Solo se puede publicar si el `streamId` existe en la DB (pre-registro). | 🟡 análogo funcional: `features.rtmp_password` + `POST /ingress/:id/validate` (pre-autorización). | **Alto** — anti-hotlink de ingest | M |
| `acceptOnlyRoomsInDataStore` (`false`) | Idem para rooms de conferencia. | ❌ (rooms LiveKit son dinámicos) | Medio | M |
| `allowedPublisherCIDR` (`""`) | CIDR desde el que se aceptan streams RTMP (whitelist de origen de ingest). | ❌ (los tokens `sk_` tienen `allowedIps`, pero no aplica al push RTMP) | Alto — cerrar el ingest a IPs conocidas | M |
| `ingestingStreamLimit` (`-1`) | Límite total de streams entrantes de la app. | 🟡 quota tenant `max_concurrent_streams` (cuenta ingress + publishers). | Medio | S |
| `maxFpsAccept` / `maxResolutionAccept` / `maxBitrateAccept` (`0`) | Rechaza RTMP que exceda FPS/resolución/bitrate. | ❌ | Medio — proteger recursos | M |
| `dropWebRTCIngestIfNoPacketReceived` (`false`) | Corta el ingest WebRTC si no llegan paquetes en `webRTCClientStartTimeoutMs`. | ❌ (LiveKit maneja) | Bajo | L (N/A) |
| `relayRTMPMetaDataToMuxers` (`true`) | Relay de metadata RTMP a los muxers (sync de playback). | ❌ | Bajo | M |
| `rtmpPlaybackEnabled` (`false`) | Habilita **playback** por RTMP (deprecado por AntMedia). | ❌ (StreamHub usa WebRTC/HLS) | Nulo | — (N/A, deprecado) |

**Toggles de tipo de ingest**: AntMedia habilita WebRTC ingest con `webRTCEnabled` (`true`).
StreamHub tiene el equivalente en `rtmp.enabled` (RTMP) y el `inputType` del ingress
(`rtmp`/`whip`/`url`) — ver [`ingress.md`](ingress.md). **SRT ingest**: AntMedia sí; LiveKit
ingress no lo soporta nativo → **N/A**.

---

## 6. Seguridad de playback (tokens, TOTP, hash, IP filter, JWT)

| Setting AntMedia (exacto) | Qué hace | StreamHub hoy | Valor usuarios | Esf. |
|---|---|---|---|---|
| `playTokenControlEnabled` (`false`) | Exige token de un solo uso para **reproducir**. | ✅ análogo: el playback usa **JWT de LiveKit** (subscribe grant) minteado en `POST /apps/:app/tokens`. | Alto (ya cubierto) | — |
| `publishTokenControlEnabled` (`false`) | Idem para **publicar**. | ✅ token LiveKit con `canPublish`. | Alto (cubierto) | — |
| `tokenHashSecret` (`""`) | Secreto para tokens hash-based (HMAC del `streamId+tipo+expiración`). | 🟡 StreamHub firma JWT LiveKit (secreto global), no hash per-app tipo AntMedia. | Medio | M |
| `hashControlPlayEnabled` / `hashControlPublishEnabled` (`false`) | Activa control por hash (compartís el secret, el cliente arma el hash). | ❌ | Medio — links firmados sin llamar a la API | M |
| `enableTimeTokenForPlay` / `enableTimeTokenForPublish` (`false`) | Acepta solo **TOTP** (token temporal rotativo). | ❌ | Medio-alto — anti-share de links | M |
| `timeTokenPeriod` (`60`) | Período (s) del TOTP. | ❌ | (con lo anterior) | S |
| `jwtControlEnabled` / `jwtSecretKey` (`false`/`""`) | JWT filter para la **REST API** de la app. | 🟡 StreamHub tiene su propia auth: Bearer `sk_` + RBAC + JWT de dashboard. | Alto (cubierto de otra forma) | — |
| `publishJwtControlEnabled` / `playJwtControlEnabled` (`false`) | JWT específico para publish/play. | ✅ vía token LiveKit | — | — |
| `jwtStreamSecretKey` (`""`) | Secreto JWT ≥32 chars para el stream. | 🟡 secreto LiveKit | — | — |
| `jwksURL` (`""`) | Valida JWT contra un JWKS externo (IdP). | ❌ | Medio (SSO de terceros) | M |
| `ipFilterEnabled` (`true`) | Filtro IP de la app (REST + playback). | 🟡 `allowedIps` por token `sk_` (REST), **no** en playback. | Medio | M |
| `remoteAllowedCIDR` (`127.0.0.1`) | CIDR permitido para pegarle a la REST API. | 🟡 se resuelve a nivel proxy/red + tokens. | Bajo | S |
| `webhookPlayAuthUrl` (`""`) | Autoriza cada play consultando un webhook externo. | ❌ | Medio | M |
| `secureAnalyticEndpoint` (`false`) | Exige JWT en los eventos de analytics. | ❌ | Bajo | S |

---

## 7. Recording (MP4/WebM, folders, VOD, previews)

| Setting AntMedia (exacto) | Qué hace | StreamHub hoy | Valor usuarios | Esf. |
|---|---|---|---|---|
| `mp4MuxingEnabled` (`false`) | Graba MP4 a `<APP>/streams`. | ✅ `recording.enabled` (egress → MP4 → S3). | Alto (cubierto) | — |
| `webMMuxingEnabled` (`false`) | Graba WebM. | ❌ (egress LiveKit = MP4/H.264) | Bajo | M |
| `dashMuxingEnabled` (`false`) | Graba DASH. | ❌ | Bajo | L (N/A) |
| `hlsMuxingEnabled` (`true`) | Genera HLS (grabación + playback). | ✅ HLS live por egress (on-demand). | Alto (cubierto) | — |
| `addDateTimeToMp4FileName` / `addDateTimeToHlsFileName` (`false`) | Agrega fecha/hora al nombre. | 🟡 StreamHub nombra por room/stream/timestamp. | Bajo | S |
| `fileNameFormat` (`%r%b`) | Formato del nombre de salida (`%r` room, `%b` broadcast…). | ❌ (fijo) | Bajo | S |
| `previewOverwrite` (`false`) | Sobrescribe el preview si el stream reusa id. | 🟡 snapshots por timestamp (no colisionan). | Bajo | S |
| `createPreviewPeriod` (`5000`) | Período (ms) de generación de preview PNG/JPG. | 🟡 `snapshot_seconds` (0,1,30,60,120,360 s). | Medio (cubierto) | — |
| `generatePreview` (`false`) | Genera preview cuando hay ABR. | ✅ snapshots on-demand + periódicos. | — | — |
| `previewFormat` (`png`) | `png` \| `jpg`. | 🟡 StreamHub usa JPEG. | Bajo | S |
| `previewHeight` (`480`) | Altura del preview. | ❌ (fijo) | Bajo | S |
| `previewQuality` (`75`) | Calidad JPG/WEBP del preview. | ❌ | Bajo | S |
| `uploadExtensionsToS3` (`7`) | Bitmask de qué subir a S3 (mp4/HLS/preview). | 🟡 StreamHub sube MP4 + snapshot; HLS live no se sube. | Bajo | S |
| `s3RecordingEnabled` (`false`) | Sube las grabaciones a S3. | ✅ pipeline recording→S3→VOD. | Alto (cubierto) | — |
| `s3StreamsFolderPath` (`streams`) | Carpeta S3 de streams/MP4/HLS. | ✅ `s3.prefix`. | — | — |
| `s3PreviewsFolderPath` (`previews`) | Carpeta S3 de previews. | 🟡 `<prefix>/snapshots/` (hardcode). | Bajo | S |
| `subFolder` (`""`) | Subcarpeta dinámica (`streams/<room>/…`). | 🟡 el prefix es por app, no por room. | Bajo | S |
| `hlsEncryptionKeyInfoFile` (`""`) | Encriptación AES de HLS (key info file). | ❌ | Medio (DRM ligero) | L |

**Split de grabación** (AntMedia no tiene setting de split per-app directo; usa REST). En
StreamHub **sí** existe: `split_minutes` (0/15/30/60/90/120) y snapshots — ver
[`recording.md`](recording.md). Ventaja de StreamHub aquí.

---

## 8. Restream / endpoints (RTMP push a YouTube/Twitch, multi-destino)

AntMedia gestiona los endpoints de re-publish **por broadcast vía REST** (no como setting
per-app), pero expone tuning per-app del reintento:

| Setting AntMedia (exacto) | Qué hace | StreamHub hoy | Valor usuarios | Esf. |
|---|---|---|---|---|
| `endpointHealthCheckPeriodMs` (`2000`) | Intervalo de health-check del endpoint de push. | 🟡 estado por endpoint (starting/active/failed) avanzado por webhooks de egress; sin período configurable | (cubierto) | — |
| `endpointRepublishLimit` (`3`) | Reintentos antes de cerrar el endpoint (`-1` = infinito). | ✅ retry con backoff exponencial, límite 3 (fijo, mismo default) | (cubierto) | — |
| `heightRtmpForwarding` (`360`) | Altura del stream transcodificado WebRTC→RTMP en el forwarding. | ❌ | | M |

> ✅ **GAP CERRADO** — Restream multi-destino (simulcast a YouTube/Twitch/Facebook/custom)
> está implementado en el core sobre LiveKit egress **StreamOutput** (RTMP), un egress por
> destino, gestionado por REST bajo `/apps/:app/streams/:id/restream` (como AntMedia:
> endpoints por broadcast vía REST, no como setting per-app). Estado por endpoint +
> retry con backoff + callbacks `restream_*`. Ver [restream.md](restream.md).

---

## 9. HLS / DASH / LL-HLS (muxing)

Cubierto en detalle en §2 (latencia). Resumen de settings AntMedia relevantes y estado:
`hlsMuxingEnabled` ✅, `hlsTime`/`hlsListSize`/`hlsflags`/`hlsPlayListType`/`hlsSegmentType`
❌ (fijos por egress), `deleteHLSFilesOnEnded` (`true`) 🟡 (StreamHub limpia por egress
stop), `hlsSegmentFileSuffixFormat` (`%09d`) ❌, `id3TagEnabled` (`false`, tags ID3 en HLS)
❌, `hlsHttpEndpoint`/`dashHttpEndpoint` (`""`, push del HLS/DASH a un endpoint HTTP
externo) ❌. Todo el bloque DASH/LL-HLS = **N/A** (el egress de LiveKit no produce DASH ni
LL-HLS).

---

## 10. Data channels / player / eventos

| Setting AntMedia (exacto) | Qué hace | StreamHub hoy | Valor usuarios | Esf. |
|---|---|---|---|---|
| `dataChannelEnabled` (`true`) | Habilita el data channel (mensajería pub→players). | ✅ `features.chat` / `features.reactions` sobre data channels de LiveKit. | Alto (cubierto) | — |
| `dataChannelPlayerDistribution` (`all`) | A quién se entregan los mensajes de players: `none`/`publisher`/`all`. | 🟡 topics fijos (`chat`/`reaction`); no hay control de distribución. | Medio | S |
| `dataChannelWebHookURL` (`""`) | Reenvía todos los mensajes del data channel a un webhook. | 🟡 callbacks `chat_message`/`reaction`. | Medio (cubierto) | — |
| `sendAudioLevelToViewers` (`false`) | Envía nivel de audio (quién habla) por data channel — útil en conferencia. | ❌ (LiveKit expone `ActiveSpeakers` en cliente) | Bajo | S |
| `audioLevelThreshold` (`120`) | Umbral de nivel de audio para asignar track en conferencia. | ❌ (LiveKit interno) | Bajo | — (N/A) |
| `id3TagEnabled` (`false`) | Metadata ID3 embebida en HLS (sync con eventos). | ❌ | Bajo | M |

**Player embebido**: ambos ofrecen player/iframe. StreamHub arma `playUrl`/`embedUrl`/`iframe`
en cada token e ingress (ver [`tokens.md`](tokens.md), [`features/players.md`](players.md)).
Paridad buena; no depende de settings de app.

---

## 11. Webhooks / callbacks por app

| Setting AntMedia (exacto) | Qué hace | StreamHub hoy | Valor usuarios | Esf. |
|---|---|---|---|---|
| `listenerHookURL` (`""`) | URL de callbacks de eventos (stream started/ended, etc.). | ✅ `callbacks.url`. | Alto (cubierto) | — |
| `webhookRetryCount` (`0`) | Reintentos al fallar el POST del webhook. | 🟡 StreamHub reintenta (ver [`webhooks.md`](../webhooks.md)) pero no es un knob per-app. | Medio | S |
| `webhookRetryAttemptDelay` (`1000`) | Delay (ms) entre reintentos. | 🟡 idem | Medio | S |
| `webhookStreamStatusUpdatePeriodMs` (`-1`) | Período de push de estado del stream al webhook (`-1` = off). | ❌ | Bajo-medio | S |
| `webhookAuthenticateURL` (`""`) | Webhook que autoriza el **publish**. | 🟡 análogo: `POST /ingress/:id/validate` para RTMP password. | Medio | M |
| `webhookPlayAuthUrl` (`""`) | Webhook que autoriza el **play** (ver §6). | ❌ | Medio | M |
| `muxerFinishScript` / `streamStartedScript` / `streamEndedScript` / `streamIdleTimeoutScript` / `vodUploadFinishScript` (`""`) | Hooks de **script bash** local en eventos de muxing/stream/VOD. | ❌ (StreamHub usa HTTP callbacks, no scripts locales) | Bajo | S |

Firma/HMAC: AntMedia no firma el callback por default; StreamHub **sí** (`callbacks.secret`
→ `X-StreamHub-Signature` HMAC-SHA256). Ventaja de StreamHub.

---

## 12. Otros (GPU, stream sources, conferencia, límites, misc)

| Setting AntMedia (exacto) | Qué hace | StreamHub hoy | Valor usuarios | Esf. |
|---|---|---|---|---|
| `webRTCViewerLimit` (`-1`) | Límite de viewers WebRTC por app. | 🟡 quota tenant (concurrencia), no viewers-por-app. | Medio | S |
| `startStreamFetcherAutomatically` (`false`) | Arranca stream sources (pull) al iniciar el server. | 🟡 ingress `url` (RTSP relay) existe, pero no auto-start persistente. | Medio | M |
| `restartStreamFetcherPeriod` (`0`) | Reinicio periódico de sources. | ❌ | Bajo | M |
| `maxVideoTrackCount` / `maxAudioTrackCount` (`-1`) | Límite de tracks en conexión multitrack (conferencia). | ❌ (LiveKit maneja rooms/tracks) | Bajo | — (N/A) |
| `participantVisibilityMatrix` (`DEFAULT`) | Matriz de roles: qué rol ve a qué rol (conferencia). | 🟡 análogo parcial: `hidden_qc` (participantes invisibles). | Medio | L |
| `playWebRTCStreamOnceForEachSession` (`true`) | Impide reproducir el mismo stream 2× en la misma sesión WS. | ❌ (LiveKit interno) | Bajo | — (N/A) |
| `writeStatsToDatastore` (`true`) | Persiste conteo de viewers (HLS/WebRTC) en la DB. | 🟡 `features.viewer_counter` + stats en `lastStatsJson`. | Medio (cubierto) | — |
| `writeSubscriberEventsToDatastore` (`false`) | Persiste eventos connect/disconnect de subscribers. | 🟡 vía webhooks/eventos. | Bajo | S |
| `disableIPv6Candidates` (`true`) | Deshabilita candidatos IPv6 en WebRTC. | ❌ (LiveKit, global) | Bajo | — (N/A per-app) |
| `stunServerURI` / `turnServerUsername` / `turnServerCredential` (`stun:…l.google.com` / `""` / `""`) | STUN/TURN para ICE. | ❌ (config global de LiveKit, no per-app) | Bajo | — (N/A per-app) |
| `webRTCPortRangeMin` / `webRTCPortRangeMax` (`50000`/`60000`) | Rango de puertos WebRTC. | ❌ (LiveKit, global) | Bajo | — (N/A per-app) |
| `webRTCTcpCandidatesEnabled` (`false`) | Candidatos TCP para WebRTC. | ❌ (LiveKit, global) | Bajo | — (N/A per-app) |
| `webRTCSdpSemantics` (`unifiedPlan`) | Semántica SDP (`planB`/`unifiedPlan`). | ❌ (LiveKit = unified plan) | Nulo | — (N/A) |
| `portAllocatorFlags` (`0`) | Flags del port allocator (disable UDP/STUN/RELAY). | ❌ | Nulo | — (N/A) |
| `replaceCandidateAddrWithServerAddr` (`false`) | Reemplaza el addr del candidato por el del server (NAT). | ❌ | Bajo | — (N/A per-app) |
| `signalingEnabled` / `signalingAddress` (`false`/`""`) | Corre/usa un signaling server AntMedia (NAT traversal EE). | ❌ (LiveKit tiene su signaling) | Nulo | — (N/A) |
| `apnsServer` (`api.sandbox.push.apple.com`) | Servidor de Apple Push Notifications. | ❌ | Bajo | S |
| `aacEncodingEnabled` (`true`) | AAC activo aun sin MP4/HLS (para push RTMP). | ❌ (implícito) | Bajo | — |
| `audioBitrateSFU` (`96000`) | Bitrate de transcode de audio (opus/aac) en modo SFU. | ❌ | Bajo | M |
| `encodingQueueSize` (`150`) | Tamaño de la cola de encoding (frames en espera). | ❌ | Bajo | — (N/A) |
| `rtspPullTransportType` (`3`) | Transport RTSP al tirar de cámaras (`udp`/`tcp`/…). | ❌ | Bajo | M |
| `maxAnalyzeDurationMS` (`1500`) | (ver §3) | ❌ | Bajo | M |

---

# PLAN PROPUESTO — qué agregar al `config.yaml` per-app

Ordenado por relación **valor/esfuerzo**. Cada bloque indica si es **solo core**
(plumbing/config) o requiere **trabajo en LiveKit egress/ingress**. Nada de esto rompe el
`config.yaml` actual: son sub-bloques opcionales con defaults seguros (el core ya "nunca
crashea con config inválida, cae a defaults" — ver notas de `config-reference.md`).

## A. Quick wins — solo core, esfuerzo S (hacerlos ya)

**A1. Bitrates en el ladder ABR** (hoy solo `height`). Alinea con `encoderSettingsString`.
El bitrate se aplica al **ingress transcodificado** (LiveKit ingress `VideoEncoding` por
layer); para el simulcast WebRTC nativo es informativo (lo elige el cliente). Solo core para
persistir; el wiring a ingress es §B.

```yaml
webrtc:
  adaptive: true
  layers:
    - { name: high, height: 720, video_bitrate: 2500000, audio_bitrate: 128000, fps: 30 }
    - { name: med,  height: 480, video_bitrate: 1200000 }
    - { name: low,  height: 240, video_bitrate: 400000 }
```

**A2. Cache/almacenamiento S3 de VOD** (`s3CacheControl`, `s3StorageClass`, `s3Permission`).
Puro plumbing al `PutObject`. Alto valor para CDN.

```yaml
s3:
  # …existente…
  cache_control: "public, max-age=31536000, immutable"   # objetos VOD/MP4
  storage_class: STANDARD          # STANDARD_IA | GLACIER | INTELLIGENT_TIERING
  object_acl: private              # private (presigned) | public-read
```

**A3. Tuning de webhooks per-app** (`webhookRetryCount`, `webhookRetryAttemptDelay`,
`webhookStreamStatusUpdatePeriodMs`). El core ya reintenta; exponerlo per-app.

```yaml
callbacks:
  url: ""
  secret: ""
  retry_count: 3
  retry_delay_ms: 1000
  status_update_period_ms: 0    # 0/-1 = off; >=5000 recomendado
```

**A4. Límite de viewers por app** (`webRTCViewerLimit`, `ingestingStreamLimit`). Se chequea
en el minteo de tokens subscribe / creación de ingress.

```yaml
limits:
  max_viewers: 0          # 0 = ilimitado
  max_ingest_streams: 0   # 0 = ilimitado (además de la quota de tenant)
```

## B. Alto valor, esfuerzo M — requiere wiring a LiveKit egress/ingress

**B1. Parámetros de segmentado HLS** (`hlsTime`, `hlsListSize`, `hlsPlayListType`) — el knob
de latencia del path HLS de escala. LiveKit egress `SegmentedFileOutput` acepta
`segmentDuration`; el `listSize`/playlist-type requiere post-proceso o el flag del egress.

```yaml
hls:
  enabled: false          # auto-HLS al iniciar stream (ya contemplado en hls-live.md)
  segment_seconds: 4      # ↔ hlsTime (default egress ~6)
  list_size: 10           # ↔ hlsListSize (ventana del m3u8)
  playlist_type: event    # event | vod | live
  cache_seconds: 3600     # Cache-Control de segmentos servidos localmente
```

**B2. Restream / multi-endpoint (simulcast a YouTube/Twitch/Facebook)** — ✅ **HECHO**
(feature `restream`, ver [restream.md](restream.md)): endpoints gestionados por REST por
stream (`POST/GET/DELETE /apps/:app/streams/:id/restream`), un egress `StreamOutput` RTMP
por destino, presets YouTube/Twitch/Facebook/custom, estado por endpoint, retry con backoff
(límite 3 ↔ `endpointRepublishLimit`) y callbacks HMAC `restream_*`. El YAML de abajo queda
como referencia histórica del diseño propuesto (se optó por REST per-stream, como AntMedia,
en lugar de config estática per-app):

```yaml
restream:
  enabled: false
  endpoints:
    - { name: youtube, protocol: rtmp, url: "rtmp://a.rtmp.youtube.com/live2/<key>" }
    - { name: twitch,  protocol: rtmp, url: "rtmp://live.twitch.tv/app/<key>" }
  retry_limit: 3          # ↔ endpointRepublishLimit
  health_check_ms: 2000   # ↔ endpointHealthCheckPeriodMs
```

**B3. Control de ingest** (`allowedPublisherCIDR`, `acceptOnlyStreamsInDataStore`,
`maxResolutionAccept`/`maxBitrateAccept`/`maxFpsAccept`). CIDR y pre-registro se validan en
el core en el webhook `ingress_started`/`on_publish`; los caps de resolución/bitrate requieren
leer los stats del ingress y cortar.

```yaml
rtmp:
  enabled: true
  transcode: true
  allowed_publisher_cidr: []      # ["203.0.113.0/24"]  ↔ allowedPublisherCIDR
  require_registered_stream: false # ↔ acceptOnlyStreamsInDataStore
  max_accept: { height: 1080, bitrate: 8000000, fps: 60 }  # 0/omitido = sin límite
```

**B4. Seguridad de playback avanzada** (`enableTimeTokenForPlay`/`timeTokenPeriod` TOTP,
`hashControlPlayEnabled`/`tokenHashSecret`, `webhookPlayAuthUrl`). StreamHub ya tiene JWT
LiveKit; esto agrega **links firmados sin llamar a la API** (hash) y **anti-share** (TOTP).

```yaml
playback_security:
  hash_secret: ""            # ↔ tokenHashSecret (HMAC de link firmado)
  time_token: false          # ↔ enableTimeTokenForPlay (TOTP)
  time_token_period: 60
  play_auth_webhook: ""      # ↔ webhookPlayAuthUrl
  ip_filter: []              # aplica al playback, no solo a la REST
```

## C. Nice-to-have, esfuerzo S/M (backlog)

- **Recording**: `webm` (M, egress no lo hace hoy), `file_name_format`/`preview_format`/
  `preview_height`/`preview_quality` (S), `uploadExtensionsToS3` selectivo (S).
- **GPU/encoder**: `encoder_selection_preference` (`gpu_and_cpu`/`only_gpu`), `gop_size`,
  `fps` — parte ya vive en `transcoding.hwaccel`.
- **Data channel**: `player_distribution` (`none`/`publisher`/`all`), `send_audio_level`.
- **Scripts locales de evento** (`streamStartedScript`, etc.): StreamHub prefiere HTTP
  callbacks; probablemente **no** valga la pena replicar scripts locales.

## D. N/A por arquitectura LiveKit (NO implementar)

- **Ladder ABR transcodificado server-side para WebRTC nativo**: LiveKit usa **simulcast del
  cliente**; el servidor no re-encodea el WebRTC a bitrates fijos. (El ladder con bitrate
  **sí** aplica al *ingress* transcodificado — §A1/§B3.)
- **LL-HLS / DASH / LL-DASH nativos** (`dash*`, `hlsEnableLowLatency`, `hlsEnabledViaDash`):
  el egress de LiveKit produce HLS-TS, no CMAF/DASH. La baja latencia en StreamHub es el
  **path WebRTC** (≤0.5 s), no LL-HLS.
- **Tuning de red WebRTC** (STUN/TURN, port range, TCP candidates, SDP semantics, IPv6,
  port allocator, ICE/keyframe timeouts): en LiveKit son **globales del proceso**, no
  per-app.
- **SRT ingest** (`srtReceiveLatencyInMs`), **RTMP playback** (`rtmpPlaybackEnabled`,
  deprecado), **signaling server AntMedia** (`signalingEnabled`), **conferencia multitrack**
  (`maxVideoTrackCount`/`maxAudioTrackCount`/`audioLevelThreshold`): los maneja LiveKit
  internamente o no existen en su pipeline.

---

## Anexo — cobertura

Se relevaron **178 `@Value`** de `AppSettings.java` (≈170 settings per-app únicos, rama
`master`, versión ~2.16). No todos aparecen en la tabla uno a uno: los ~30 knobs de red
WebRTC, del algoritmo ABR interno y de conferencia se agruparon en las notas "N/A per-app"
porque en la arquitectura LiveKit no son configurables por aplicación. Los settings con más
**gap accionable** (donde LiveKit sí permite el knob) están en el PLAN §A y §B.
