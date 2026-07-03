/**
 * StreamHub — cross-module SERVICE CONTRACTS.
 *
 * STABLE. Each module implements its own interface and may depend on the others
 * via these interfaces only (never on the concrete class). For NestJS DI, inject
 * by the matching token in `tokens.ts` (interfaces vanish at runtime).
 *
 * Implementers: `class XService implements XServiceContract {}`.
 * Consumers:    `@Inject(X_SERVICE) private readonly x: XServiceContract`.
 */

import {
  AppConfig,
  AppRecord,
  CallbackEvent,
  LogLevel,
  S3Config,
  S3UploadResult,
  StreamRecord,
  StreamType,
  VodStatus,
} from './types';

/**
 * Response-header overrides for a presigned GET (S3 `response-*` params).
 * Used to force a browser download (attachment) with a friendly filename.
 */
export interface S3PresignOptions {
  /** Value for the `Content-Disposition` response header (e.g. attachment). */
  responseContentDisposition?: string;
  /** Value for the `Content-Type` response header. */
  responseContentType?: string;
}

/** Multi-provider S3 abstraction (AWS/Wasabi/MinIO). SPEC §5 s3. */
export interface S3ServiceContract {
  /** Upload a local file to `key` under the app's bucket/prefix. */
  upload(
    config: S3Config,
    localPath: string,
    key: string,
    contentType?: string,
  ): Promise<S3UploadResult>;
  /**
   * Presigned GET URL valid for `expiresInSeconds` (default impl-defined).
   * `options` may override the response headers (e.g. force an attachment
   * download disposition). Additive — existing 3-arg callers are unaffected.
   */
  presignGet(
    config: S3Config,
    key: string,
    expiresInSeconds?: number,
    options?: S3PresignOptions,
  ): Promise<string>;
  /** Delete an object. No-op if it does not exist. */
  delete(config: S3Config, key: string): Promise<void>;
  /** Whether the object exists. */
  exists(config: S3Config, key: string): Promise<boolean>;
}

export interface MintTokenOptions {
  room: string;
  identity: string;
  name?: string;
  canPublish?: boolean;
  canSubscribe?: boolean;
  /** TTL like "10m", "1h". */
  ttl?: string;
  metadata?: string;
}

export interface CreateIngressInput {
  appName: string;
  roomName: string;
  /** rtmp = push URL+key; whip = WHIP endpoint; url = pull a remote source. */
  inputType: 'rtmp' | 'whip' | 'url';
  participantIdentity: string;
  participantName?: string;
  /** For inputType 'url': the source URL (e.g. rtsp:// relay). */
  url?: string;
  enableTranscoding?: boolean;
}

export interface IngressInfo {
  ingressId: string;
  url: string;
  streamKey?: string;
  roomName: string;
}

export interface StartEgressInput {
  appName: string;
  roomName: string;
  mode: 'room-composite' | 'participant';
  /** Required for participant mode. */
  participantIdentity?: string;
  layout?: string;
  /** Absolute local filepath the egress writes to. */
  outputFilepath: string;
  /**
   * If > 0, attach an ImageOutput to the egress that captures a JPEG every
   * `snapshotIntervalS` seconds (wave-3 §3 snapshots). Requires
   * `snapshotFilePrefix`.
   */
  snapshotIntervalS?: number;
  /**
   * Absolute local filename prefix the egress ImageOutput writes snapshots to
   * (e.g. /…/snapshots/<base>_). The egress appends an index + `.jpg`.
   */
  snapshotFilePrefix?: string;
}

export interface EgressInfo {
  egressId: string;
  status: string;
}

/** RoomComposite → RTMP stream egress (broadcast to an external RTMP target). */
export interface StartStreamEgressInput {
  appName: string;
  /** Room name (already namespaced under the app prefix by the caller). */
  roomName: string;
  /** Destination push URL — must be rtmp:// or rtmps://. */
  rtmpUrl: string;
  /** Optional egress layout (e.g. "grid", "speaker"). */
  layout?: string;
}

/** A live stream (RTMP) egress as surfaced by the broadcast endpoints. */
export interface StreamEgressInfo {
  egressId: string;
  status: string;
  roomName: string;
  /** Destination RTMP URLs the room is being pushed to. */
  urls: string[];
}

/**
 * RoomComposite → HLS (SegmentedFileOutput) egress (wave-3 §1b). The egress
 * writes an `.m3u8` playlist + `.ts` segments to a LOCAL directory shared with
 * the core (the egress container mounts the same data dir), which the core then
 * serves under `/hls/<app>/<room>/...`.
 */
export interface StartHlsEgressInput {
  appName: string;
  /** Room name (already namespaced under the app prefix by the caller). */
  roomName: string;
  /** Absolute local directory the egress writes the playlist + segments into. */
  outputDir: string;
  /** Playlist filename written inside `outputDir` (e.g. "index.m3u8"). */
  playlistName: string;
  /** HLS segment duration in seconds (default 4). */
  segmentDurationS?: number;
  /** Optional egress layout (e.g. "grid", "speaker"). */
  layout?: string;
}

/** A live HLS (segmented file) egress as surfaced by the HLS endpoints. */
export interface HlsEgressInfo {
  egressId: string;
  status: string;
  roomName: string;
  /** Playlist path/location reported by the egress, if already available. */
  playlistLocation?: string;
}

export interface LiveKitRoomInfo {
  name: string;
  sid: string;
  numParticipants: number;
  creationTime: number;
}

/** Wrapper over livekit-server-sdk. SPEC §5 livekit. */
export interface LiveKitServiceContract {
  createRoom(name: string, emptyTimeoutS?: number): Promise<LiveKitRoomInfo>;
  deleteRoom(name: string): Promise<void>;
  listRooms(names?: string[]): Promise<LiveKitRoomInfo[]>;
  mintToken(opts: MintTokenOptions): Promise<string>;
  createIngress(input: CreateIngressInput): Promise<IngressInfo>;
  deleteIngress(ingressId: string): Promise<void>;
  startEgress(input: StartEgressInput): Promise<EgressInfo>;
  /** Start a RoomComposite egress that pushes the room to an RTMP target. */
  startStreamEgress(input: StartStreamEgressInput): Promise<StreamEgressInfo>;
  /** List active stream (RTMP) egresses whose room is under `roomPrefix`. */
  listStreamEgress(roomPrefix: string): Promise<StreamEgressInfo[]>;
  /**
   * Start a RoomComposite egress that writes an HLS playlist + `.ts` segments
   * to a local directory (wave-3 §1b live HLS).
   */
  startHlsEgress(input: StartHlsEgressInput): Promise<HlsEgressInfo>;
  /** List active HLS (segmented file) egresses whose room is under `roomPrefix`. */
  listHlsEgress(roomPrefix: string): Promise<HlsEgressInfo[]>;
  stopEgress(egressId: string): Promise<EgressInfo>;
  /** Validate + parse a raw LiveKit webhook body. Returns the decoded event. */
  receiveWebhook(body: string, authHeader: string): Promise<unknown>;
  /** Is the LiveKit server reachable. */
  isReachable(): Promise<boolean>;
}

export interface StartRecordingInput {
  appName: string;
  roomName: string;
  streamId?: string;
}

export interface RecordingHandle {
  vodId: number;
  egressId: string;
  status: VodStatus;
}

/** Orchestrates recording → upload → VOD. SPEC §5 recording, §8 flow. */
export interface RecordingServiceContract {
  start(input: StartRecordingInput): Promise<RecordingHandle>;
  stop(appName: string, recordingId: string): Promise<RecordingHandle>;
  /**
   * Called by the livekit module on egress_updated/egress_ended webhooks to
   * advance the flow (enqueue upload job, etc).
   */
  onEgressEvent(egressId: string, status: string, payload: unknown): Promise<void>;
}

export interface CreateAppInput {
  name: string;
  displayName?: string;
  roomPrefix?: string;
  /** Owning tenant stamped onto the app row (defaults to the platform tenant). */
  tenantId?: string;
  /** Optional partial config overrides applied to the default template. */
  config?: Partial<AppConfig>;
}

export interface DeleteAppOptions {
  /** If true, also delete VOD rows and their S3 objects. */
  deleteVods?: boolean;
}

/** App registry + filesystem/config/samples lifecycle. SPEC §3, §5 apps. */
export interface AppsServiceContract {
  list(): Promise<AppRecord[]>;
  get(name: string): Promise<AppRecord | null>;
  create(input: CreateAppInput): Promise<AppRecord>;
  delete(name: string, options?: DeleteAppOptions): Promise<void>;
  /** Parsed config.yaml with resolved S3 credentials. Throws if app missing. */
  getConfig(name: string): Promise<AppConfig>;
  /** Persist a (partial) config update; returns the merged config. */
  updateConfig(name: string, patch: Partial<AppConfig>): Promise<AppConfig>;
  /** Absolute path to apps/<name>/ on disk. */
  appDir(name: string): string;
}

export interface LogQuery {
  app?: string;
  level?: LogLevel;
  /** ISO date lower bound (inclusive). */
  since?: string;
  /** ISO date upper bound (inclusive). */
  until?: string;
  limit?: number;
  offset?: number;
}

export interface LogEntry {
  id: number;
  ts: string;
  level: LogLevel;
  source: string;
  appId: number | null;
  message: string;
  metaJson: string | null;
}

/** Structured logging → console + file + server_logs table. SPEC §5 logs. */
export interface LogsServiceContract {
  write(
    level: LogLevel,
    source: string,
    message: string,
    meta?: Record<string, unknown>,
    appId?: number | null,
  ): void;
  query(q: LogQuery): Promise<LogEntry[]>;
}

export interface SnapshotInput {
  appName: string;
  roomName: string;
  /** Optional participant to snapshot; default = room composite/last frame. */
  participantIdentity?: string;
}

export interface SnapshotResult {
  key: string;
  url: string;
}

/** Active stream listing/detail/stop + snapshots. SPEC §5 streams. */
export interface StreamsServiceContract {
  list(appName: string): Promise<StreamRecord[]>;
  get(appName: string, streamId: string): Promise<StreamRecord | null>;
  /** Stop a stream (disconnect participant / remove ingress / end room). */
  stop(appName: string, streamId: string): Promise<void>;
  /** Upsert a stream row (used by webhook handlers). */
  upsert(
    appName: string,
    streamId: string,
    type: StreamType,
    room: string,
    participant: string | null,
  ): Promise<StreamRecord>;
  /**
   * Mark a stream row ended WITHOUT LiveKit teardown (used by webhook handlers
   * on participant_left / track_unpublished — the participant is already gone or
   * has stopped publishing, so there is nothing to disconnect). No-op when the
   * row does not exist or is already ended.
   */
  end(appName: string, streamId: string): Promise<void>;
  snapshot(input: SnapshotInput): Promise<SnapshotResult>;
}

/** One generated/editable sample file under apps/<app>/samples/. */
export interface SampleFileInfo {
  /** Filename (e.g. webrtc-publish.html). */
  name: string;
  /** Size in bytes. */
  sizeBytes: number;
  /** Public, auth-less embed URL (/samples/<app>/<name>). */
  embedUrl: string;
  /** Whether this is one of the regenerable template files. */
  generated: boolean;
}

/**
 * Per-app sample pages (wave-4 §3). Generates self-contained HTML demos wired
 * to one app (WebRTC publish/play, HLS player, audio radio). Editing one app's
 * samples never affects another's.
 */
export interface SamplesServiceContract {
  /** (Re)generate the standard sample set for an app; returns filenames. */
  generate(appName: string): Promise<string[]>;
  /** List the app's sample files. */
  list(appName: string): Promise<SampleFileInfo[]>;
  /** Read one sample file raw. */
  read(appName: string, file: string): Promise<string>;
  /** Overwrite one sample file (only this app's copy). */
  write(appName: string, file: string, content: string): Promise<void>;
}

/** Outbound per-app webhook dispatcher. SPEC §5 callbacks. */
export interface CallbacksServiceContract {
  dispatch(
    appName: string,
    event: CallbackEvent,
    payload: Record<string, unknown>,
  ): Promise<void>;
}

/**
 * Restream (multi-destination RTMP forwarding — AntMedia "endpoints").
 * Cross-module surface is intentionally minimal: the livekit webhook sink
 * advances per-destination state on egress_* events (started/updated/ended)
 * exactly like RECORDING_SERVICE.onEgressEvent. `appName` is the app resolved
 * from the room prefix (null when unresolvable — the service then falls back
 * to its in-memory egress→app map).
 */
export interface RestreamServiceContract {
  onEgressEvent(
    appName: string | null,
    egressId: string,
    status: string,
  ): Promise<void>;
}
