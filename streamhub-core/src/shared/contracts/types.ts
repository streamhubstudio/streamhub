/**
 * StreamHub — shared domain types.
 *
 * STABLE CONTRACT. These shapes are consumed across modules. Do not change a
 * field's name/type without coordinating; only additive changes are safe.
 */

export type S3Provider = 'aws' | 'wasabi' | 'minio';
export type RecordingMode = 'room-composite' | 'participant';
export type StreamType = 'webrtc' | 'rtmp' | 'rtsp' | 'whip' | 'ws-mjpeg';
export type StreamStatus = 'active' | 'ended';
export type VodStatus = 'recording' | 'uploading' | 'ready' | 'failed';
export type TokenScope = 'global' | 'app';
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * Resolved S3 configuration for one app. Credentials are already resolved
 * (read from env/secret store via the `*_env` refs in config.yaml), never the
 * raw env names. Consumers (S3Service) use this as-is.
 */
export interface S3Config {
  provider: S3Provider;
  bucket: string;
  region: string;
  /** Empty/undefined for plain AWS. Full URL for wasabi/minio. */
  endpoint?: string;
  /** true for minio (path-style), false for aws/wasabi (vhost-style). */
  forcePathStyle: boolean;
  /** Key prefix inside the bucket, e.g. "streamhub/live". */
  prefix: string;
  /**
   * Public/CDN base URL for objects (wave-4 §2), e.g.
   * `https://cdn.example.com` or `https://s3.wasabisys.com/my-bucket`. When set,
   * VOD URLs are built deterministically as `<publicUrl>/<objectKey>` instead of
   * presigned. Empty/undefined → fall back to presigned URLs.
   */
  publicUrl?: string;
  /** Resolved access key (already dereferenced from access_key_env). */
  accessKey: string;
  /** Resolved secret key (already dereferenced from secret_key_env). */
  secretKey: string;
}

export interface WebrtcLayer {
  name: string;
  height: number;
}

/**
 * Output encoding target for recordings/VODs (SPEC §5 transcoding).
 *  - `h264`      — MP4/H.264 only (what the LiveKit egress produces natively).
 *  - `h264+vp8`  — additionally generate a WebM/VP8 alternate per recording via
 *    an ffmpeg post-transcode job (the egress cannot emit VP8).
 */
export type TranscodingEncoding = 'h264' | 'h264+vp8';

/**
 * One VOD rendition of the adaptive ladder (post-transcode HLS output).
 * `bitrateKbps` is the video bitrate target for that height.
 */
export interface VodRendition {
  height: number;
  bitrateKbps: number;
}

/**
 * Direct WebSocket MJPEG ingest limits (ESP32-CAM et al — see
 * https://streamhub.studio/docs/integrations/ESP32-WS-INGEST). On disk under
 * `features.ws_ingest` in snake_case; AppsService resolves defaults.
 */
export interface WsIngestFeatures {
  /** Master switch for `/ingest/ws` on this app. Default true. */
  enabled: boolean;
  /** Max simultaneous ws-mjpeg cameras for the app. 0 = unlimited. */
  maxCameras: number;
  /** Server-side fps cap per camera (excess frames are dropped). */
  maxFps: number;
  /** Max accepted JPEG frame size in KB (bigger → close 4413). */
  maxFrameKb: number;
  /**
   * Max raw byte size of a structured `{"type":"data",…}` text frame (IoT data
   * plane — internal design notes). A bigger data frame is DROPPED (never
   * closes the socket — only oversized JPEG frames do). Optional for back-compat
   * with older fixtures; AppsService always resolves it (default 16384 = 16 KB).
   */
  maxDataBytes?: number;
  /**
   * Per-socket rate cap for structured data frames (messages/second, own token
   * bucket separate from the fps cap). Excess data frames are dropped silently.
   * Optional for back-compat; AppsService always resolves it (default 5).
   */
  maxDataPerSec?: number;
}

/** DRM system a packaged VOD can be protected for. */
export type DrmSystem = 'widevine' | 'playready' | 'fairplay';

/**
 * Common-encryption scheme used at packaging time.
 *  - `cbcs` — AES-CBC pattern encryption. The one-encode-covers-all choice:
 *    required by FairPlay, supported by modern Widevine + PlayReady clients.
 *  - `cenc` — AES-CTR. Widest legacy Widevine/PlayReady device reach, but
 *    NOT playable by FairPlay/Safari.
 */
export type DrmScheme = 'cenc' | 'cbcs';

/** Per-DRM-system license server URLs (empty = not configured). */
export interface DrmLicenseUrls {
  widevine: string;
  playready: string;
  fairplay: string;
}

/**
 * Per-app DRM feature block (`features.drm` in config.yaml, snake_case on
 * disk). Applies to the PACKAGED VOD/HLS output only — WebRTC playback is
 * protected by SRTP and never goes through a CDM (see
 * https://streamhub.studio/docs/features/DRM). Resolved with defaults by
 * `resolveDrmFeatures` (modules/recording/drm/drm-config.ts). Default OFF.
 */
export interface DrmFeatures {
  /** Master switch. Default false — clear packaging, pipeline unchanged. */
  enabled: boolean;
  /** Content-key provider: `none` (noop, default) | `external` (key server). */
  provider: 'none' | 'external';
  /** DRM systems to signal/protect for. Default all three. */
  systems: DrmSystem[];
  /** Encryption scheme (default `cbcs` — the CMAF one-encode path). */
  scheme: DrmScheme;
  /** External key-server endpoint (SPEKE-style POST). Empty = not configured. */
  keyServerUrl: string;
  /**
   * Env var / data/secrets.json key holding the key-server bearer token —
   * a REF like the S3 `*_env` fields, never the value. Empty = no auth header.
   */
  keyServerTokenEnv: string;
  /** License server URL per system (handed to players; empty = unset). */
  licenseUrls: DrmLicenseUrls;
  /** FairPlay application certificate URL (Safari needs it before licensing). */
  fairplayCertUrl: string;
  /**
   * When DRM is enabled but encryption is impossible (no packager binary, no
   * keys, provider down): `false` (default) = FAIL CLOSED, the HLS variants
   * are skipped; `true` = degrade to CLEAR packaging (logged loudly).
   */
  failOpen: boolean;
}

/**
 * 24/7 "linear channel" feature block (endless-radio Tier 1). Groups the knobs
 * that turn an app's room into an always-on broadcast channel. Optional on disk
 * (`features.linear:`); AppsService always resolves it with defaults so every
 * field is present. When `persistentRoom`/`alwaysOnHls`/`dvr` are all false the
 * app behaves exactly like a normal conference/stream app.
 */
export interface LinearChannelFeatures {
  /**
   * QW-1: pre-create the LiveKit room with a long `emptyTimeout` before the
   * ingress is created, so a brief source outage never recycles the room (which
   * would change its SID and drop viewers). Default false — conference rooms
   * keep LiveKit's ~300s server default.
   */
  persistentRoom: boolean;
  /**
   * `emptyTimeout` (seconds) applied to the pre-created persistent room. Default
   * 86400 (24h). NOTE: LiveKit's createRoom only RAISES the timeout of a room
   * that does not yet exist — it will NOT lower an already-live room's timeout.
   */
  roomEmptyTimeoutSeconds: number;
  /**
   * QW-2: the HLS watchdog relaunches a dead HLS egress for this app's active
   * rooms (idempotent — `HlsService.start` reuses a live egress). Default false.
   */
  alwaysOnHls: boolean;
  /**
   * QW-4: DVR — serve the rolling (live-window) playlist as the public manifest
   * so it never grows unbounded, and run the `.ts` retention janitor. Default
   * false (the full `index.m3u8` is served, unchanged).
   */
  dvr: boolean;
  /**
   * QW-4: DVR retention window (seconds). Segments older than this are pruned by
   * the janitor — never a segment still referenced by the live playlist. Default
   * 3600 (1h).
   */
  dvrWindowSeconds: number;
}

/**
 * Per-app wave-2 feature flags (SPEC §16). All optional/boolean; resolved with
 * sensible defaults by AppsService. On disk they live under `features:` in
 * config.yaml in snake_case (rtmp_password, viewer_counter, hidden_qc, …).
 */
export interface AppFeatures {
  /** Require a stream password in addition to the RTMP stream key. */
  rtmpPassword: boolean;
  /** Expose a live subscriber count on streams. */
  viewerCounter: boolean;
  /** Enable chat over LiveKit data channels (topic `chat`). */
  chat: boolean;
  /** Enable animated reactions over data channels (topic `reaction`). */
  reactions: boolean;
  /** Allow hidden QC/recorder participants (token grant `hidden`). */
  hiddenQc: boolean;
  /** Adaptive player: simulcast in grants + transcoding on ingress. */
  adaptivePlayer: boolean;
  /**
   * Allow anonymous public playback: the /apps/:app/play-token/:room endpoint
   * mints a subscribe-only token with no auth (powers /play + /embed). Default
   * true; set false to require an authenticated join token instead.
   */
  publicPlayback: boolean;
  /**
   * Direct WebSocket MJPEG ingest (ESP32-CAM). Optional for back-compat with
   * older fixtures; AppsService always resolves it with defaults
   * (enabled: true, maxCameras: 0, maxFps: 15, maxFrameKb: 256).
   */
  wsIngest?: WsIngestFeatures;
  /**
   * DRM protection of the packaged VOD/HLS output. Optional for back-compat
   * with older fixtures; AppsService always resolves it with defaults
   * (disabled — clear packaging).
   */
  drm?: DrmFeatures;
  /**
   * 24/7 linear-channel knobs (endless-radio Tier 1). Optional on disk;
   * AppsService always resolves it with defaults (all off). See
   * {@link LinearChannelFeatures}.
   */
  linear?: LinearChannelFeatures;
}

/** MQTT publish QoS level (per-app `mqtt.qos`). */
export type MqttQos = 0 | 1 | 2;

/** Per-app MQTT log forwarding (`mqtt.logs` block). */
export interface MqttLogsConfig {
  /** Forward the app's log stream to `<topicPrefix>/log/<level>`. */
  enabled: boolean;
  /** Minimum level forwarded (trace < debug < info < warn < error < fatal). */
  level: LogLevel;
}

/**
 * Resolved per-app MQTT event publishing config (config.yaml `mqtt:` block).
 * `password` is already resolved from the secret store (the yaml only carries
 * a `password_env` ref, mirroring the S3 credential pattern) — NEVER return it
 * raw over the API (mask like S3 creds).
 */
export interface MqttConfig {
  /** Master switch. Default false. */
  enabled: boolean;
  /** Broker URL, e.g. mqtt://host:1883 or mqtts://host:8883. Empty = off. */
  url: string;
  /** Optional broker username. */
  username: string;
  /** Resolved broker password (from env / data/secrets.json). */
  password: string;
  /** Topic root; defaults to `streamhub/<app>`. */
  topicPrefix: string;
  /** Publish QoS (0 default). */
  qos: MqttQos;
  /** Force TLS (mqtt:// is upgraded to mqtts://). */
  tls: boolean;
  /** Event filter: ['all'] (default) or an explicit list of event names. */
  events: string[];
  /** App-log forwarding. */
  logs: MqttLogsConfig;
}

/**
 * Resolved per-app SMTP config (owner item 29; config.yaml `smtp:` block).
 * `pass` is already resolved from the secret store (the yaml only carries a
 * `pass_env` ref, mirroring the S3/MQTT credential pattern) — NEVER return it
 * raw over the API (mask like S3/MQTT creds). Used by EmailService as the
 * DEFAULT SMTP for this app's notifications when no per-user override applies
 * (precedence: per-user > per-app > global env); global env is the fallback
 * when this block is absent/disabled.
 */
export interface SmtpConfig {
  /** Master switch. Default false (app uses the global SMTP). */
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  /** From header for mail sent through this app's SMTP. */
  from: string;
  /** Resolved SMTP password (from env / data/secrets.json). */
  pass: string;
}

/**
 * Per-app quotas (config.yaml `quotas:` block). DEFAULT UNLIMITED — an absent
 * block or a value <= 0 / -1 means "no limit". Enforced by QuotasService at the
 * slot-opening boundary (publisher token). Complements the per-tenant quotas.
 */
export interface AppQuotasConfig {
  /** Max concurrent live streams for THIS app. -1 / 0 / absent = unlimited. */
  maxConcurrentStreams: number;
  /** Max viewers per single stream. -1 / 0 / absent = unlimited (per-stream). */
  maxViewersPerStream: number;
}

/**
 * Per-app stream latency/health alerting (config.yaml `latency_alert:` block).
 * On breach the core emits `stream.latency_high` (and later
 * `stream.latency_recovered`) through BOTH the callbacks pipeline and MQTT.
 */
export interface LatencyAlertConfig {
  /** Master switch. Default false. */
  enabled: boolean;
  /** Breach threshold for the sampled per-room probe RTT, in ms. */
  thresholdMs: number;
  /** Minimum seconds between successive `stream.latency_high` alerts per room. */
  cooldownSeconds: number;
  /** Sampling interval per app, in seconds (default 10). */
  intervalSeconds: number;
}

/**
 * Full parsed representation of an app's config.yaml (see SPEC §7).
 * Note: s3 here carries the resolved credentials (S3Config), not the raw
 * `access_key_env`/`secret_key_env` refs that live on disk.
 */
export interface AppConfig {
  name: string;
  displayName: string;
  roomPrefix: string;
  /**
   * Per-app IANA timezone (e.g. `America/Argentina/Buenos_Aires`), used to
   * render app-scoped human-facing timestamps (dashboard logs/streams/VODs/
   * backups) and as the DEFAULT timezone for any plugin/schedule config that
   * leaves its own timezone empty (e.g. presence/perimeter arm/disarm
   * schedules, scheduled-live events) — an explicit plugin-level timezone
   * always wins over this default. Empty string = server/host local time
   * (the pre-existing behaviour). Optional in the type for back-compat with
   * older fixtures; AppsService always resolves it (defaults to `''`).
   */
  timezone?: string;
  recording: {
    enabled: boolean;
    mode: RecordingMode;
    layout: string;
    localDir: string;
    deleteLocalAfterUpload: boolean;
    /**
     * Split the recording into N-minute MP4 parts (each part = its own VOD).
     * 0 = continuous single file (default). UI values: 0|15|30|60|90|120.
     */
    splitMinutes: number;
    /**
     * Capture a JPEG snapshot every N seconds during the recording (egress
     * ImageOutput). 0 = disabled (default). UI values: 0|1|30|60|120|360.
     */
    snapshotSeconds: number;
    /**
     * Filename/S3-key template for recordings (StoreHub-style, our `${}`
     * dialect — see modules/recording/filename-template.ts). Empty = the
     * built-in `<streamId-slug>-<epoch>` naming. Rendered to ONE safe segment
     * (no path traversal); the container extension is always appended by core.
     * Optional for back-compat with existing fixtures; AppsService always
     * resolves it (defaults to '').
     */
    filenameTemplate?: string;
    /**
     * Filename/S3-key template for snapshots (same dialect; `${type}` = `jpg`).
     * Empty = the built-in naming. Optional for back-compat; always resolved.
     */
    snapshotTemplate?: string;
    /**
     * VOD retention window in DAYS. `0` = OFF (keep forever, default). Allowed:
     * 7 | 30 | 90 | 180 | 360. A periodic janitor deletes VODs older than this
     * from BOTH the app DB and the app's S3 storage. Optional for back-compat;
     * AppsService always resolves it (invalid → 0).
     */
    retentionDays?: number;
  };
  s3: S3Config;
  webrtc: {
    adaptive: boolean;
    layers: WebrtcLayer[];
    /**
     * Resolution cap (px height) for the TRANSCODED RTMP/URL ingress — one of
     * 360 | 480 | 720 | 1080 (default 720). Bounds the ingress transcode: a
     * single-layer ingest re-encodes to exactly this height; an adaptive ingest
     * caps its top ladder layer here (see modules/livekit/ingress-encoding.util).
     * Always resolved (sanitized default) by AppsService.
     */
    transcodeMaxHeight: number;
  };
  rtmp: {
    enabled: boolean;
    transcode: boolean;
    /**
     * RTMP→HLS passthrough (remux, no re-encode — AntMedia-style). When true the
     * app's RTMP ingest is REMUXED (`ffmpeg -c copy`) straight to HLS, bypassing
     * LiveKit entirely (near-zero CPU, no GPU). MUTUALLY EXCLUSIVE with any
     * transcode/adaptive path: enabling it forces `rtmp.transcode`,
     * `transcoding.enabled` and `webrtc.adaptive` off, and vice-versa
     * (AppsService enforces the invariant on patch). Optional for back-compat
     * with older fixtures; AppsService resolves it to `false` when absent.
     */
    passthrough?: boolean;
  };
  /**
   * Server-side transcoding (config.yaml `transcoding:` block). Optional in the
   * type for back-compat with older fixtures; AppsService always resolves it
   * (defaults applied). When the block is missing on disk, `enabled` falls back
   * to the legacy `rtmp.transcode` behaviour so pre-existing apps keep working.
   * NEW apps are created with `enabled: false` (passthrough — no transcoding).
   */
  transcoding?: {
    /** Master switch: gates RTMP-ingress transcoding + VOD post-processing. */
    enabled: boolean;
    /** Recording output encoding target (default `h264`). */
    encoding: TranscodingEncoding;
    /** Generate an adaptive HLS VOD (master + N renditions) per recording. */
    vodAdaptive: boolean;
    /**
     * Explicit VOD rendition ladder. Empty = derive from `webrtc.layers`
     * heights with default per-height bitrates.
     */
    vodRenditions: VodRendition[];
  };
  callbacks: {
    url: string;
    secret: string;
  };
  /**
   * Per-app MQTT event publishing. Optional in the type for back-compat with
   * older fixtures; AppsService always resolves it (defaults applied,
   * `enabled: false` when the block is missing on disk).
   */
  mqtt?: MqttConfig;
  /**
   * Per-app SMTP override (owner item 29). Optional in the type for
   * back-compat with older fixtures; AppsService always resolves it (defaults
   * applied, `enabled: false` when the block is missing on disk — the app then
   * uses the global SMTP env for its notifications).
   */
  smtp?: SmtpConfig;
  /**
   * Per-app stream latency alerting. Optional for back-compat; AppsService
   * always resolves it (defaults applied, disabled when missing on disk).
   */
  latencyAlert?: LatencyAlertConfig;
  /**
   * Per-app + per-stream quotas. Optional; when absent everything is UNLIMITED
   * (the owner's default). Resolved by AppsService (defaults applied).
   */
  quotas?: AppQuotasConfig;
  /** Wave-2 feature flags (SPEC §16). Always resolved (defaults applied). */
  features: AppFeatures;
  /**
   * Per-app plain-config VARIABLES (`variables:` map in config.yaml). Referenced
   * from filename/S3-key templates as `${var.NAME}`. NOT secrets — plain config,
   * returned by GET config. Optional for back-compat; AppsService resolves it to
   * `{}` when absent.
   */
  variables?: Record<string, string>;
}

/** Row of global `streamhub.db.apps`. */
export interface AppRecord {
  id: number;
  name: string;
  displayName: string;
  livekitRoomPrefix: string;
  createdAt: string;
  updatedAt: string;
  settingsJson: string | null;
}

/** Row of per-app `vods.db.streams`. */
export interface StreamRecord {
  id: number;
  appId: number;
  streamId: string;
  type: StreamType;
  room: string;
  participant: string | null;
  status: StreamStatus;
  startedAt: string;
  endedAt: string | null;
  lastStatsJson: string | null;
  /**
   * Live subscriber count (SPEC §16 viewer counter): real subscribers only,
   * excluding publishers and hidden/QC participants. Present on detail reads
   * when the app enables `features.viewerCounter`; undefined otherwise.
   */
  viewers?: number;
}

/** Row of per-app `vods.db.vods`. */
export interface VodRecord {
  id: number;
  appId: number;
  streamId: string | null;
  room: string | null;
  name: string;
  fileKey: string | null;
  s3Url: string | null;
  publicUrl: string | null;
  sizeBytes: number | null;
  durationS: number | null;
  width: number | null;
  height: number | null;
  format: string | null;
  status: VodStatus;
  localPath: string | null;
  startedAt: string | null;
  endedAt: string | null;
  metatagsJson: string | null;
  snapshotKey: string | null;
}

/** Result of an S3 upload. */
export interface S3UploadResult {
  key: string;
  bucket: string;
  /** Canonical object URL (not necessarily public/accessible). */
  url: string;
  sizeBytes: number;
  etag?: string;
}

/**
 * Outbound callback event names (SPEC §5 callbacks, wave-3 §4 taxonomy).
 * Three families, all classifiable by the `event` field:
 *  - Room/participant (forwarded LiveKit webhooks)
 *  - Ingress/Egress (forwarded LiveKit webhooks)
 *  - StreamHub business events (fired by Recording/Streams services)
 */
export type CallbackEvent =
  // Room / participants (LiveKit webhooks)
  | 'room_started'
  | 'room_finished'
  | 'participant_joined'
  | 'participant_left'
  | 'track_published'
  | 'track_unpublished'
  // Ingress / Egress (LiveKit webhooks)
  | 'ingress_started'
  | 'ingress_ended'
  | 'egress_started'
  | 'egress_updated'
  | 'egress_ended'
  // StreamHub business events
  | 'stream_started'
  | 'stream_ended'
  | 'recording_started'
  | 'recording_part_ready'
  | 'recording_ready'
  | 'recording_failed'
  | 'snapshot_taken'
  | 'vod_ready'
  // Post-transcode variants (adaptive HLS ladder and/or WebM alternate) of a
  // VOD finished generating + uploading.
  | 'vod_variants_ready'
  // HLS live egress (wave-3 §1b): fired when the live HLS egress of a room is
  // started/stopped.
  | 'hls_started'
  | 'hls_stopped'
  // Restream / multi-destination RTMP forwarding (AntMedia "endpoints"): one
  // event per destination when its forwarding egress is started, stopped
  // (manual stop or clean end) or failed (destination rejected/dropped).
  | 'restream_started'
  | 'restream_stopped'
  | 'restream_failed'
  // SPEC §16: client-side chat/reactions relayed via data channels; the core
  // fires these outbound callbacks when a data message is sent server-side.
  | 'chat_message'
  | 'reaction'
  // Plugin worker lifecycle (plugins framework worker-hook): fired when a
  // per-app plugin worker process starts, stops (clean) or errors/crashes.
  | 'plugin_worker_started'
  | 'plugin_worker_stopped'
  | 'plugin_worker_error'
  // App versioning (appstore pin/rollback): the worker_version pin of an app
  // install changed (upgrade or rollback). Payload: { plugin, app, from, to,
  // action: 'pin' | 'rollback' } where from/to are version ids or null
  // (built-in/latest). Family: per-app versioning.
  | 'plugin.version_changed'
  // Stream health alerts (mqtt module latency monitor): the per-room probe RTT
  // crossed `latency_alert.threshold_ms` (high) / dropped back under it
  // (recovered). Dotted names are intentional (alert family).
  | 'stream.latency_high'
  | 'stream.latency_recovered'
  // A snapshot (JPEG) was taken for a stream — fired for BOTH the periodic
  // recording ImageOutput captures AND the on-demand
  // `POST /apps/:app/streams/:id/snapshot`. Dotted `stream.*` family so plugins
  // and Streamflow can subscribe to "any snapshot". Payload:
  // `{ app, room, streamId?, key, url, sizeBytes?, source: 'periodic'|'on_demand' }`.
  // (The legacy `snapshot_taken` event is still emitted for the periodic path.)
  | 'stream.snapshot'
  // Plugin DOMAIN events (plugins framework event channel): a worker POSTs
  // /apps/:app/plugins/:id/events (ingest-token auth) and the core relays the
  // event through this funnel — only names the plugin's manifest DECLARES in
  // `events` are accepted (a worker can never spoof core events). Family:
  // license-plate recognition (`lpr` plugin).
  | 'plate.detected'
  | 'plate.allowed'
  | 'plate.denied'
  // Vision Edge cluster (modules/edge watchdog): an edge/common node flipped
  // liveness — fired through the notifier fan-out (callback/MQTT/email/
  // Discord/Telegram) so operators hear about it wherever they configured.
  | 'node.online'
  | 'node.offline'
  // Per-app network I/O monitor (modules/net-metrics): the app's rolling
  // ingress+egress byte window crossed its configured threshold (high) /
  // dropped back under it (recovered). Same alert-family pattern as
  // `stream.latency_*`.
  | 'network.threshold_exceeded'
  | 'network.threshold_recovered'
  // Stream health monitor (`stream-health` Studio App): its worker samples the
  // per-room ORIGIN HLS output (playlist diffing + TS continuity counters +
  // ffprobe facts + audio volumedetect) and emits these through the plugin
  // event channel (POST :id/events) → this funnel. `degraded`/`recovered` are
  // the per-room ROLLUP transitions; the rest are per-detector alerts. Same
  // alert-family pattern as `stream.latency_*`.
  | 'health.degraded'
  | 'health.recovered'
  | 'health.audio_lost'
  | 'health.audio_recovered'
  | 'health.av_desync'
  | 'health.stalled'
  | 'health.discontinuity'
  // Streamflow (workflow engine): a run's lifecycle + the generic `emit` action
  // box output. Dispatched through this SAME funnel (webhook + MQTT tap) so an
  // `action.emit` box or a run-status change reaches the app's configured sinks.
  // Emitted names never re-enter the trigger engine as core events (the runner
  // uses these only outbound), matching the `plate.*` family pattern.
  | 'streamflow.run_started'
  | 'streamflow.run_finished'
  | 'streamflow.run_failed'
  | 'streamflow.output'
  // IoT structured data plane (internal design notes): every inbound
  // device message — a ws-ingest `{"type":"data",…}` frame OR a generic MQTT-in
  // subscription message — becomes ONE `dispatch(app,'iot.data',payload)` through
  // this SAME funnel, so it powers MQTT-out + the signed webhook + Streamflow
  // (the `trigger.mqtt` box matches `iot.data` by topic) with a single emit site.
  // Payload shape: `{ topic, deviceId, data, source: 'ws' | 'mqtt' }` — `data` is
  // the device's JSON object (ws) or parsed-JSON/raw-string (mqtt); `deviceId` is
  // the ws device identity, or undefined for a broker message.
  | 'iot.data';

/**
 * What an RTMP→HLS passthrough (remux) ingress GIVES UP versus the normal
 * LiveKit path — surfaced by the ingress API so the dashboard can warn the
 * operator. Every field that is `false`/`true` here is a capability that is OFF
 * because the media never enters LiveKit (it is `ffmpeg -c copy`'d to HLS).
 */
export interface PassthroughCapabilities {
  mode: 'passthrough';
  /** Media is remuxed (`-c copy`), never re-encoded. */
  remux: true;
  /** No WebRTC / sub-second playback (HLS only, ~2 segments of latency). */
  webrtc: false;
  subSecondLatency: false;
  /** No adaptive bitrate / ABR ladder (single passthrough rendition). */
  adaptiveBitrate: false;
  /** No server-side transcode safety net — the source MUST be H.264/AAC. */
  transcode: false;
  requiresH264Aac: true;
  /** No egress recording / VOD for a passthrough ingress. */
  recording: false;
  /** No room features (viewer count / chat / reactions / moderation / snapshots / track plugins). */
  roomFeatures: false;
  /** No backup/failover key, no GPU acceleration. */
  backupKey: false;
  gpu: false;
  /**
   * SRT ingest only: the SRT receive latency budget in milliseconds (libsrt
   * default ~120 ms — configurable on the encoder side, added on top of the HLS
   * segment latency). Absent for RTMP ingresses.
   */
  latencyMs?: number;
  /** Human-readable "what you lose" lines for the UI warning. */
  lost: string[];
}

/**
 * Public surface of an RTMP/SRT→HLS passthrough ingress (remux, no transcode).
 * This ingress has NO LiveKit ingress behind it: the RTMP/SRT push is remuxed
 * straight to the app's HLS dir, so the only playback is HLS. Returned by the
 * passthrough branch of `POST /apps/:app/ingress` and merged into the ingress
 * listing.
 */
export interface PassthroughIngressInfo {
  mode: 'passthrough';
  ingressId: string;
  app: string;
  /** Namespaced room (== HLS sub-dir under apps/<app>/hls/<room>/). */
  room: string;
  /** The passthrough stream key (`ptk_…`); also the RTMP path segment. */
  streamKey: string;
  /** Ingest transport of this passthrough ingress. Absent/`rtmp` = RTMP. */
  inputType?: 'rtmp' | 'srt' | 'mpegts';
  /** `rtmp://<host>:<port>/<app>/<key>` — where the encoder pushes. Empty for srt/mpegts. */
  rtmpUrl: string;
  /** SRT only: `srt://<host>:<port>?streamid=<key>` — where the encoder pushes. */
  srtUrl?: string;
  /**
   * MPEG-TS only: the canonical `udp://@GROUP:PORT?…` source the remux PULLS from
   * (a multicast group / unicast port — there is no push URL for this transport).
   */
  sourceUrl?: string;
  /** `/hls/<app>/<room>/index.m3u8` (absolute when PUBLIC_BASE_URL is set). */
  hlsUrl: string;
  /** Player page URL for the room. */
  playerUrl?: string;
  /** Remux worker status: 'live' (armed/publishing) | 'idle' | 'error' | 'off'. */
  status?: 'live' | 'idle' | 'error' | 'off';
  /** Whether the HLS playlist has been written recently (fresh segments). */
  playlistFresh?: boolean;
  capabilities: PassthroughCapabilities;
}
