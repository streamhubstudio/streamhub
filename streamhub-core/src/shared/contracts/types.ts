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
 * streamhub-docs/integrations/ESP32-WS-INGEST.md). On disk under
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
  };
  s3: S3Config;
  webrtc: {
    adaptive: boolean;
    layers: WebrtcLayer[];
  };
  rtmp: {
    enabled: boolean;
    transcode: boolean;
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
   * Per-app stream latency alerting. Optional for back-compat; AppsService
   * always resolves it (defaults applied, disabled when missing on disk).
   */
  latencyAlert?: LatencyAlertConfig;
  /** Wave-2 feature flags (SPEC §16). Always resolved (defaults applied). */
  features: AppFeatures;
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
  // Stream health alerts (mqtt module latency monitor): the per-room probe RTT
  // crossed `latency_alert.threshold_ms` (high) / dropped back under it
  // (recovered). Dotted names are intentional (alert family).
  | 'stream.latency_high'
  | 'stream.latency_recovered';
