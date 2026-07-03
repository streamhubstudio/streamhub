/**
 * Type definitions for the streamhub-core API (base /api/v1).
 * Derived from the authoritative OpenAPI doc
 * (https://streamhub.example.com/api/v1/openapi.json) plus verified notes.
 *
 * IMPORTANT envelope rules:
 *  - Most endpoints return { data, error }.
 *  - /health and /stats are PLAIN objects (no envelope).
 *  - Fields are camelCase (e.g. /apps records).
 */

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export interface ApiEnvelope<T> {
  data: T | null
  error: ApiError | null
}

export interface ApiError {
  message?: string
  code?: string | number
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface LoginRequest {
  /** Admin username OR account email — the backend accepts either. */
  user?: string
  email?: string
  password: string
  /** 6-digit TOTP code — required when the account has 2FA enabled. */
  code?: string
}

/** GET /auth/config — public auth capabilities of this deployment. */
export interface AuthConfig {
  /** True when public self-signup (STREAMHUB_ALLOW_SIGNUP) is enabled. */
  allowSignup: boolean
}

export interface LoginResponse {
  token: string
}

/** POST /auth/magic-link — request a passwordless sign-in link by email. */
export interface MagicLinkRequest {
  email: string
}

/**
 * Response for a magic-link request. The backend always answers 200 (even for
 * unknown emails, to avoid account enumeration); `sent` is best-effort.
 */
export interface MagicLinkResponse {
  sent?: boolean
}

/** POST /auth/magic/verify — exchange a magic-link token for a session JWT. */
export interface MagicVerifyRequest {
  token: string
  /**
   * 6-digit TOTP code — required when the account has 2FA enabled (the API
   * answers 401 `totp_required` without it; the link is NOT burnt, so the
   * same token can be re-submitted with the code).
   */
  code?: string
}

/** Verified magic-link → session bearer token (same shape as login). */
export interface MagicVerifyResponse {
  token: string
}

/**
 * One active login session (GET /auth/sessions). Every human sign-in mints a
 * row; the owner can revoke any of them from "Mi cuenta".
 */
export interface SessionInfo {
  id: string
  /** Client IP captured at sign-in (X-Forwarded-For first hop), or null. */
  ip: string | null
  /** Raw User-Agent captured at sign-in, or null. */
  userAgent?: string | null
  createdAt: string
  lastSeen: string | null
  /** True for the session backing the current token (this device). */
  current: boolean
}

/** POST /auth/signup — create an account (and optionally its team). */
export interface SignupRequest {
  email: string
  password: string
  /** Optional display name for the new team/tenant. */
  teamName?: string
}

// ---------------------------------------------------------------------------
// Wave 5 — multi-tenant identity, tenants, members, quotas/usage
// ---------------------------------------------------------------------------

/** Per-tenant role (Casbin RBAC-with-domains). `superadmin` is global. */
export type TenantRole = 'owner' | 'editor' | 'viewer'

/** Quota limits per tenant (enforced by the backend guards). */
export interface Quotas {
  maxApps: number
  maxConcurrentStreams: number
  maxRecordingMinutesMonth: number
  maxEgressGbMonth: number
  maxStorageGb: number
}

/** A tenant = Logto Organization. id is the Logto org id. */
export interface Tenant {
  id: string
  name: string
  plan: string
  createdAt?: string
  quotas: Quotas
  /** Convenience: app count, when the backend includes it. */
  appCount?: number
}

/** One usage metric: how much is consumed vs the plan limit. */
export interface UsageMetric {
  used: number
  limit: number
  unit?: string
}

/** GET /tenants/:id/usage — current consumption vs limits. */
export interface TenantUsage {
  tenantId: string
  apps: UsageMetric
  concurrentStreams: UsageMetric
  recordingMinutes: UsageMetric
  egressGb: UsageMetric
  storageGb: UsageMetric
  /** Billing window the counters belong to. */
  periodStart?: string
  periodEnd?: string
}

/** A tenant member (mirror of a Logto user + org-role). */
export interface Member {
  userId: string
  email: string
  name?: string
  role: TenantRole
  /** `invited` = invitation sent, not yet accepted. */
  status?: 'active' | 'invited'
  invitedAt?: string
  createdAt?: string
}

export interface InviteMemberRequest {
  email: string
  role: TenantRole
}

export interface UpdateMemberRequest {
  role: TenantRole
}

export type UpdateQuotasRequest = Partial<Quotas> & { plan?: string }

/**
 * GET /auth/me — the backend's resolved view of the caller (source of truth for
 * scoping). Optional: the UI also derives a fallback identity from the JWT.
 */
export interface MeResponse {
  userId: string
  email?: string
  name?: string
  isSuperadmin: boolean
  tenants: { id: string; name: string; role: TenantRole }[]
}

// ---------------------------------------------------------------------------
// Cuenta y auth — account, team (teams/mine), invites, 2FA
// ---------------------------------------------------------------------------

/** GET /account — the signed-in user's own profile + tenant context. */
export interface AccountInfo {
  user: {
    id: string
    email: string | null
    name: string | null
    isSuperadmin: boolean
    /** True when a password is set (magic-link accounts sign in without one). */
    hasPassword: boolean
    twoFactorEnabled: boolean
    status: string
    createdAt: string
  }
  tenant: {
    id: string
    name: string
    plan: string
    role: string
  } | null
}

/** PATCH /account — partial profile update. */
export interface UpdateAccountRequest {
  name?: string
  email?: string
}

/** POST /account/password. */
export interface ChangePasswordRequest {
  currentPassword: string
  newPassword: string
}

/** POST /account/2fa/setup — enrolment payload (QR rendered server-side). */
export interface TwoFaSetup {
  secret: string
  otpauthUri: string
  /** PNG data URI — feed straight into an <img src>. */
  qrDataUri: string
}

/** A member row of GET /teams/mine (flattened membership + user). */
export interface TeamMember {
  userId: string
  email: string | null
  name: string | null
  role: TenantRole
  /** 'active' | 'pending' — pending = invited, has not signed in yet. */
  status: string
  isSuperadmin: boolean
  createdAt: string
}

/** Quota usage report of GET /teams/mine (see quotas.md). */
export interface TeamUsage {
  tenantId: string
  apps?: UsageMetric
  concurrentStreams?: UsageMetric
  recordingMinutes?: UsageMetric
  egressGb?: UsageMetric
  storageGb?: UsageMetric
  periodStart?: string
  periodEnd?: string
}

/** GET /teams/mine — my tenant + members + quota usage in one shot. */
export interface MyTeam {
  team: { id: string; name: string; plan: string; created_at?: string } | null
  members: TeamMember[]
  usage: TeamUsage
}

/** A pending invitation (GET /tenant/invites). */
export interface PendingInvite {
  userId: string
  email: string | null
  role: TenantRole
  invitedAt: string
}

/** POST /tenant/invites response — the created invite + email outcome. */
export interface InviteResult extends PendingInvite {
  emailSent: boolean
}

// ---------------------------------------------------------------------------
// Health & Stats (PLAIN — no envelope)
// ---------------------------------------------------------------------------

export interface Health {
  status: string
  up: boolean
  version: string
  ts: string
  uptimeSeconds: number
}

export interface CpuStats {
  loadAvg: number[]
  cores: number
}

export interface MemoryStats {
  totalBytes: number
  freeBytes: number
  usedBytes: number
}

export interface DiskStats {
  totalBytes: number
  freeBytes: number
  usedBytes: number
}

export interface CountsStats {
  apps: number
  rooms: number
  activeStreams: number
}

export interface EndpointStatus {
  reachable: boolean
  active: number
  total: number
}

/** DB + VOD storage footprint on /stats (drives the Dashboard storage cards). */
export interface StorageStats {
  /** Global registry DB — data/streamhub.db (+ sidecars). */
  dbSizeBytes: number
  /** Sum of every per-app app.db (+ sidecars). */
  appsDbSizeBytes: number
  /** dbSizeBytes + appsDbSizeBytes — every SQLite file StreamHub owns. */
  totalDbSizeBytes: number
  /** Sum of size_bytes across all VODs of every app. */
  vodTotalBytes: number
  /** Total number of VOD rows server-wide. */
  vodCount: number
}

export interface Stats {
  ts: string
  uptimeSeconds: number
  version: string
  cpu: CpuStats
  memory: MemoryStats
  disk: DiskStats | null
  livekitReachable: boolean
  counts: CountsStats
  egress: EndpointStatus
  ingress: EndpointStatus
  /** Optional for forward/back-compat with servers that predate the field. */
  storage?: StorageStats
}

/** GET /apps/:app/sizes — this app's app.db size + VOD storage rollup. */
export interface AppSizes {
  app: string
  /** Bytes on disk for apps/<app>/app.db (+ its -wal / -shm sidecars). */
  dbSizeBytes: number
  /** Sum of size_bytes across this app's VODs. */
  vodTotalBytes: number
  /** Number of VOD rows for this app. */
  vodCount: number
}

// ---------------------------------------------------------------------------
// GPU / hardware acceleration
// ---------------------------------------------------------------------------

/** How transcoding picks its encoder. `auto`/`gpu` fall back to CPU when no GPU. */
export type HwAccelMode = 'auto' | 'gpu' | 'cpu'

/**
 * GET /system/gpu — server-wide GPU detection. When `available` is false, any
 * `auto`/`gpu` hwaccel setting transparently degrades to CPU (software) encode.
 */
/** A single detected acceleration device (mirrors backend GpuDevice). */
export interface GpuDevice {
  kind: 'nvidia' | 'vaapi'
  /** NVIDIA product name or the VAAPI render-node path. */
  name: string
  index?: number
  memoryMiB?: number
}

export interface GpuInfo {
  available: boolean
  /** e.g. 'nvidia' | 'vaapi' | 'none' — from the backend. */
  type?: string
  /** Detected devices, when the backend enumerates them. */
  devices?: GpuDevice[]
  driver?: string
  checkedAt?: string
  detail?: string
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// Apps (tenants) — camelCase
// ---------------------------------------------------------------------------

export interface AppFeatures {
  rtmpPassword?: boolean
  viewerCounter?: boolean
  chat?: boolean
  reactions?: boolean
  hiddenQc?: boolean
  adaptivePlayer?: boolean
}

export interface App {
  id: number
  name: string
  displayName: string
  livekitRoomPrefix: string
  createdAt: string
  updatedAt: string
  settingsJson?: string | Record<string, unknown> | null
}

export interface CreateAppRequest {
  name: string
  displayName?: string
  roomPrefix?: string
}

export interface UpdateAppConfigRequest {
  displayName?: string
  roomPrefix?: string
  recordingEnabled?: boolean
  callbackUrl?: string
  callbackSecret?: string
  features?: AppFeatures
}

/** Transcoding / adaptive config (GET/PATCH /apps/:app/config). */
export interface WebrtcLayer {
  name: string
  height: number
}

/**
 * Advanced recording config (config.yaml `recording`). Edited via
 * PATCH /apps/:app/config. UI exposes split_minutes and snapshot_seconds.
 */
export interface RecordingConfig {
  enabled?: boolean
  mode?: string
  /** 0 = no splitting (default). UI choices: 0|15|30|60|90|120 (minutes). */
  split_minutes?: number
  /** 0 = no snapshots (default). UI choices: 0|1|30|60|120|360 (seconds). */
  snapshot_seconds?: number
  delete_local_after_upload?: boolean
}

/** Signed-callback config (config.yaml `callbacks`). Edited via PATCH config. */
export interface CallbacksConfig {
  url?: string
  secret?: string
}

export interface TranscodingConfig {
  adaptive?: boolean
  layers?: WebrtcLayer[]
  rtmpTranscode?: boolean
  /** Hardware acceleration preference for FFmpeg transcode (config.yaml). */
  hwaccel?: HwAccelMode
  features?: AppFeatures
  recording?: RecordingConfig
  callbacks?: CallbacksConfig
  [k: string]: unknown
}

export type UpdateTranscodingConfigRequest = Partial<TranscodingConfig>

// ---------------------------------------------------------------------------
// Wave 4 — raw config editor + hot reload (config.yaml)
// ---------------------------------------------------------------------------

/** GET /apps/:app/config/raw — the verbatim config.yaml text. */
export interface RawConfig {
  yaml: string
}

/** Result of PUT /apps/:app/config/raw — written + hot-reloaded into memory. */
export interface ConfigReloadResult {
  reloaded: boolean
  warnings?: string[]
  [k: string]: unknown
}

/**
 * Wave 5 / Fold 2 — POST /apps/:app/config/raw/dry-run.
 * Validates the candidate YAML (parse + schema) and returns a unified diff vs
 * the live config WITHOUT writing anything.
 */
export interface ConfigDryRunResult {
  valid: boolean
  /** Unified diff (current → candidate). Empty when there are no changes. */
  diff?: string
  warnings?: string[]
  errors?: string[]
}

/** Wave 5 / Fold 2 — a timestamped config.yaml backup (config.yaml.bak.<ts>). */
export interface ConfigBackup {
  file: string
  /** Backup id (suffix of config.yaml.bak.<ts>) — used for get/revert calls. */
  ts: string
  /** ISO timestamp the backup was taken, when the server provides it. */
  createdAt?: string
  size?: number
  /** Backend returns sizeBytes; kept optional for forward-compat. */
  sizeBytes?: number
}

/** G4 — a config preset (GET /apps/:app/presets). */
export interface ConfigPreset {
  name: string
  title: string
  description: string
  useCase: string
  /** Human summary of what the preset sets. */
  sets: string[]
}

/** G4 — result of POST /apps/:app/presets/:name/apply. */
export interface ApplyPresetResult {
  preset: string
  applied: boolean
  reloaded: boolean
  changed: boolean
  /** Unified diff current → preset-applied config. */
  diff: string
  warnings?: string[]
}

// ---------------------------------------------------------------------------
// Wave 4 — S3 storage block (per app)
// ---------------------------------------------------------------------------

export type S3Provider = 'aws' | 'wasabi' | 'minio'

/**
 * GET /apps/:app/s3 — the S3 block from config.yaml. `key`/`secret` are
 * MASKED (e.g. "AKIA••••" / "••••") because they live in secrets.json.
 */
export interface S3Config {
  provider?: S3Provider | string
  bucket?: string
  region?: string
  endpoint?: string
  prefix?: string
  /** Public/CDN base for deterministic VOD URLs (e.g. https://cdn.midominio.com). */
  public_url?: string
  /** Masked access key id (display only). */
  key?: string
  /** Masked secret (display only). */
  secret?: string
  /** Whether real credentials exist in secrets.json. */
  configured?: boolean
  [k: string]: unknown
}

/**
 * PUT /apps/:app/s3 — writes the s3 block to config.yaml (sans key/secret) and
 * the key/secret to secrets.json. Omit key/secret to KEEP the stored ones.
 */
export interface UpdateS3Request {
  provider?: S3Provider | string
  bucket?: string
  region?: string
  endpoint?: string
  prefix?: string
  public_url?: string
  key?: string
  secret?: string
}

// ---------------------------------------------------------------------------
// Per-app MQTT event publishing (+ latency alert)
// ---------------------------------------------------------------------------

/** GET/PUT /apps/:app/mqtt — masked view (password never in clear). */
export interface MqttConfig {
  enabled?: boolean
  url?: string
  username?: string
  topicPrefix?: string
  qos?: number
  tls?: boolean
  /** ['all'] or an explicit list of event names. */
  events?: string[]
  logs?: { enabled?: boolean; level?: string }
  /** Masked password (display only). */
  password?: string
  hasPassword?: boolean
  configured?: boolean
  latencyAlert?: {
    enabled?: boolean
    thresholdMs?: number
    cooldownSeconds?: number
    intervalSeconds?: number
  }
  [k: string]: unknown
}

/**
 * PUT /apps/:app/mqtt — writes the mqtt/latency_alert blocks to config.yaml
 * and the password to secrets.json. Omit password to KEEP the stored one.
 */
export interface UpdateMqttRequest {
  enabled?: boolean
  url?: string
  username?: string
  password?: string
  topicPrefix?: string
  qos?: number
  tls?: boolean
  events?: string[]
  logs?: { enabled?: boolean; level?: string }
  latencyAlert?: {
    enabled?: boolean
    thresholdMs?: number
    cooldownSeconds?: number
    intervalSeconds?: number
  }
}

// ---------------------------------------------------------------------------
// Wave 4 — per-app HTML samples
// ---------------------------------------------------------------------------

/** One generated sample file, served at /samples/<app>/<file>. */
export interface Sample {
  file: string
  title?: string
  description?: string
  size?: number
  updatedAt?: string
  /** Public URL where the rendered HTML is served, if the server provides it. */
  url?: string
  [k: string]: unknown
}

export interface RegenerateSamplesResult {
  files?: string[]
  /** Backend returns the list of regenerated filenames. */
  regenerated?: string[]
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// Wave 4 — radio listen token (subscribe-only, audio)
// ---------------------------------------------------------------------------

/** GET /apps/:app/radio/:room/listen-token — token for an audio listener embed. */
export interface ListenToken {
  token: string
  wsUrl: string
  room?: string
  joinUrl?: string
  embed_iframe?: string
  [k: string]: unknown
}

/**
 * GET /apps/:app/play-token/:room — PUBLIC (no auth) subscribe-only token used
 * by the public /play and /embed player surfaces. Same shape as a minted
 * subscribe token: { token, wsUrl } (+ optional canonical share URLs).
 */
export interface PlayToken {
  token: string
  wsUrl: string
  room?: string
  player_url?: string
  embed_iframe?: string
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// Ingress
// ---------------------------------------------------------------------------

export type IngressInputType = 'rtmp' | 'whip' | 'url'

export interface CreateIngressRequest {
  inputType: IngressInputType
  room?: string
  participantIdentity?: string
  participantName?: string
  url?: string
  enableTranscoding?: boolean
}

export interface Ingress {
  ingressId: string
  streamKey?: string
  rtmp_url?: string
  stream_key?: string
  stream_password?: string
  requires_password?: boolean
  adaptive?: boolean
  player_url?: string
  embed_iframe?: string
  /** Ingest server URL as reported by LiveKit (public host rewritten). */
  url?: string
  /** Ingress display name (LiveKit `name`, e.g. `<app>-<room>`). */
  name?: string
  /** Room the ingress publishes into (alias of roomName). */
  room?: string
  roomName?: string
  inputType?: IngressInputType
  /** Live endpoint state: inactive | buffering | publishing | error | complete. */
  status?: string
  /** Average incoming video bitrate (bps) while publishing. */
  bitrate?: number
  width?: number
  height?: number
  /** Approx. current viewers of the room (participants - publisher); null = unknown. */
  viewers?: number | null
  /** ISO timestamp of the current publish session start, when live. */
  startedAt?: string | null
  [k: string]: unknown
}

/** Filter/paging inputs for GET /apps/:app/ingress (paginated listing). */
export interface IngressListParams {
  room?: string
  q?: string
  limit?: number
  offset?: number
}

/** Normalised page of ingresses ({ data, total, limit, offset } wire shape). */
export interface IngressPage {
  items: Ingress[]
  total?: number
  limit?: number
  offset?: number
}

export interface ValidateIngressPasswordRequest {
  password: string
}

// ---------------------------------------------------------------------------
// WS ingest (ESP32-CAM direct WebSocket MJPEG — ESP32-WS-INGEST.md)
// ---------------------------------------------------------------------------

/** Body of POST /apps/:app/ws-ingest. */
export interface CreateWsIngestRequest {
  room: string
  identity?: string
}

/**
 * A provisioned WS ingest key. POST returns the full credential set (wsUrl +
 * plaintext wsk_ streamKey + playback URLs); GET lists the keys with their
 * live state (`active` = a camera is connected right now).
 */
export interface WsIngestKey {
  id: string
  streamKey?: string | null
  room?: string | null
  identity?: string
  active?: boolean
  createdAt?: string | null
  /** wss://…/ingest/ws?app=&room= — what the device connects to. */
  wsUrl?: string
  mjpegUrl?: string
  frameUrl?: string
  playerUrl?: string
  embedUrl?: string
  [k: string]: unknown
}

/**
 * GET /apps/:app/ws-ingest/live/:room — PUBLIC live info driving the player
 * mode of /play + /embed (active ws-mjpeg camera → MJPEG mode).
 */
export interface WsIngestLiveInfo {
  active: boolean
  type: 'ws-mjpeg' | null
  room?: string
  mjpegUrl?: string
  frameUrl?: string
  wsUrl?: string
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// Recording & VODs
// ---------------------------------------------------------------------------

export interface StartRecordingRequest {
  roomName: string
  streamId?: string
}

export interface RecordingHandle {
  vodId: number
  egressId: string
  status: string
  [k: string]: unknown
}

/** Result of stopping a stream recording (POST .../record/stop). */
export interface RecordStopResult {
  egressId: string
  status: string
  [k: string]: unknown
}

export interface Vod {
  id: number
  appId?: number
  room?: string
  status?: string
  /** Backend wire field (VodRecord.durationS, seconds). */
  durationS?: number | null
  /** Legacy spelling kept for tolerance. */
  durationSeconds?: number
  width?: number | null
  height?: number | null
  sizeBytes?: number
  publicUrl?: string
  /** Wave 4: deterministic public/CDN URL when s3.public_url is configured. */
  url?: string
  /** Wave 4: always-available presigned fallback URL. */
  presignedUrl?: string
  snapshotUrl?: string
  createdAt?: string
  startedAt?: string
  [k: string]: unknown
}

/** Sortable VOD columns accepted by GET /apps/:app/vods?order=. */
export type VodOrder = 'started_at' | 'size_bytes' | 'id'
export type SortDir = 'asc' | 'desc'

/** Filter/paging inputs for GET /apps/:app/vods. */
export interface VodListParams {
  room?: string
  status?: string
  since?: string
  until?: string
  order?: VodOrder
  dir?: SortDir
  /** When true, ignore limit/offset and return every VOD. */
  all?: boolean
  limit?: number
  offset?: number
}

/**
 * Normalised page of VODs. The backend answers { data: Vod[], total, limit,
 * offset }; the client folds that (and the legacy bare-array shape) into this.
 */
export interface VodsPage {
  items: Vod[]
  total?: number
  limit?: number
  offset?: number
}

/**
 * GET /apps/:app/vods/:id/download — short-lived presigned download URL.
 * 409 when the VOD isn't `ready`.
 */
export interface VodDownload {
  url: string
  filename: string
  expiresInSeconds: number
}

// ---------------------------------------------------------------------------
// Database maintenance (per-app app.db — SQLite)
// ---------------------------------------------------------------------------

/**
 * One table's row count (+ optional on-disk size) in the app.db. Mirrors the
 * backend DbTableHealth (`bytes` is set only when the dbstat vtab is available).
 */
export interface DbTableInfo {
  name: string
  rows: number
  bytes?: number
}

/**
 * GET /apps/:app/db/health — mirrors the backend DbHealth: file size, WAL size,
 * page/freelist counts, fragmentation %, and per-table row/byte breakdown.
 */
export interface DbHealth {
  /** Absolute path of the app.db file. */
  path?: string
  /** Total on-disk size of app.db (bytes). */
  sizeBytes?: number
  /** SQLite WAL size (bytes). */
  walSizeBytes?: number
  pageCount?: number
  freelistCount?: number
  /** freelistCount / pageCount * 100 — dead-space ratio. */
  fragmentationPct?: number
  tables: DbTableInfo[]
  [k: string]: unknown
}

/** Before/after size snapshot within an optimize result. */
export interface DbSizeSnapshot {
  sizeBytes?: number
  walSizeBytes?: number
  freelistCount?: number
}

/**
 * POST /apps/:app/db/optimize — mirrors the backend DbOptimizeResult: the steps
 * run plus before/after snapshots so the UI can show reclaimed space.
 */
export interface DbOptimizeResult {
  path?: string
  steps?: string[]
  before?: DbSizeSnapshot
  after?: DbSizeSnapshot
  /** before.sizeBytes - after.sizeBytes, precomputed by the backend. */
  reclaimedBytes?: number
  [k: string]: unknown
}

/** What a purge wipes. `all` = every purgeable slice (keeps app + config). */
export type DbPurgeScope = 'vods' | 'logs' | 'all'

/** POST /apps/:app/db/purge — destructive. `confirm` must be true to proceed. */
export interface DbPurgeRequest {
  scope: DbPurgeScope
  confirm: boolean
}

/**
 * Result of a purge — mirrors the backend flat PurgeResult. VOD purges cascade
 * to S3 objects + local files (counted separately).
 */
export interface DbPurgeResult {
  scope: DbPurgeScope
  vodsDeleted?: number
  streamsDeleted?: number
  logsDeleted?: number
  s3Deleted?: number
  localDeleted?: number
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

export type StreamType = 'webrtc' | 'rtmp' | 'rtsp' | 'whip' | 'ws-mjpeg'
export type StreamStatus = 'active' | 'ended'

export interface Stream {
  id: number
  appId: number
  streamId: string
  type: StreamType
  room: string
  participant: string | null
  status: StreamStatus
  startedAt: string
  endedAt: string | null
  lastStatsJson: string | null
  viewers?: number
  /** Server-reported recording state, when available. */
  recording?: boolean
  recordingEgressId?: string
}

/**
 * Live HLS egress session (SegmentedFileOutput). Returned by
 * POST /apps/:app/streams/:id/hls/start and GET /apps/:app/streams/:id/hls.
 * `playlistUrl` is the public `.m3u8` to feed <HlsPlayer src> / embeds.
 */
export interface HlsSession {
  /** Public URL of the live HLS playlist (`.m3u8`). */
  playlistUrl: string
  status: string
  egressId?: string
  /** Server-provided <iframe> embed snippet, if any. */
  embedIframe?: string
  [k: string]: unknown
}

/** Status of a stream's HLS egress (GET .../hls). May be inactive. */
export interface HlsStatus {
  active: boolean
  status?: string
  playlistUrl?: string
  egressId?: string
  [k: string]: unknown
}

/** Result of stopping a stream's HLS egress (POST .../hls/stop). */
export interface HlsStopResult {
  /** Egress id that was stopped, or null if none was active. */
  egressId?: string | null
  status: string
  [k: string]: unknown
}

export interface SendDataRequest {
  topic: string
  message?: string
  reaction?: string
  payload?: string
  from?: string
  destinationIdentities?: string[]
  reliable?: boolean
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export interface SnapshotRequest {
  room: string
  participantIdentity?: string
}

export interface SnapshotResult {
  key: string
  url: string
}

// ---------------------------------------------------------------------------
// Tokens — LiveKit join (per app)
// ---------------------------------------------------------------------------

export interface MintTokenRequest {
  room?: string
  identity?: string
  name?: string
  canPublish?: boolean
  canSubscribe?: boolean
  ttl?: string
  metadata?: string
  /** Hidden QC/recorder participant (invisible, not counted as viewer). */
  hidden?: boolean
  recorder?: boolean
  /**
   * Audio-only grant (Wave 4): publisher should only publish the mic / the
   * server narrows the publish grant to audio. Used by voice channels & radio.
   */
  audioOnly?: boolean
}

export interface MintedToken {
  token: string
  wsUrl: string
  joinUrl?: string
  player_url?: string
  embed_iframe?: string
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// Tokens — global API tokens
// ---------------------------------------------------------------------------

export type TokenScope = 'global' | 'app'

export interface TokenSummary {
  id: number
  name: string
  scope: TokenScope
  appId: number | null
  lastUsedAt: string | null
  createdAt: string
  revoked: boolean
}

export interface CreateTokenRequest {
  name: string
  scope: TokenScope
  appId?: number
  allowedIps?: string[]
}

export interface CreatedToken {
  id: number
  token: string
}

// ---------------------------------------------------------------------------
// Broadcast — room-composite egress to an RTMP URL
// ---------------------------------------------------------------------------

export interface StartBroadcastRequest {
  /** LiveKit room name to compose (already prefixed if applicable). */
  roomName: string
  /** Full RTMP/RTMPS destination URL, including the stream key. */
  rtmpUrl: string
}

export interface BroadcastEgress {
  egressId: string
  status: string
  roomName?: string
  rtmpUrl?: string
  /** Destination URLs the egress is pushing to (stream keys included). */
  urls?: string[]
  [k: string]: unknown
}

export interface StopBroadcastResult {
  egressId: string
  status: string
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// Restream — multi-destination RTMP forwarding of a live stream
// ---------------------------------------------------------------------------

export type RestreamPlatform = 'youtube' | 'twitch' | 'facebook' | 'custom'

export type RestreamStatus = 'starting' | 'active' | 'failed' | 'stopped'

/** Body for POST /apps/:app/streams/:id/restream (one destination). */
export interface AddRestreamRequest {
  platform?: RestreamPlatform
  /** Full rtmp(s):// URL — required for platform 'custom'. */
  url?: string
  /** Destination stream key — required for preset platforms. */
  key?: string
  /** Friendly label shown in listings. */
  name?: string
}

/** One forwarding destination. `urlMasked` NEVER contains the stream key. */
export interface RestreamTarget {
  id: number
  name: string | null
  platform: RestreamPlatform | string
  room: string
  streamId: string | null
  urlMasked: string
  egressId: string | null
  status: RestreamStatus
  error: string | null
  retries: number
  startedAt: string
  endedAt: string | null
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface LogEntry {
  ts?: string
  time?: string
  level?: LogLevel | string
  app?: string
  source?: string
  message?: string
  msg?: string
  [k: string]: unknown
}

export interface LogQuery {
  app?: string
  level?: LogLevel
  /** Filter by emitter (e.g. ffmpeg, egress). Newly supported by both endpoints. */
  source?: string
  /** Free-text search over the message. */
  q?: string
  since?: string
  until?: string
  limit?: number
  offset?: number
}

/** Logs endpoint is paginated; shape tolerates array or {items,total}. */
export interface LogsPage {
  items: LogEntry[]
  total?: number
  limit?: number
  offset?: number
}

// ---------------------------------------------------------------------------
// Per-app dashboard stats (GET /apps/:app/stats)
// ---------------------------------------------------------------------------

/** A single live room in the app-stats payload. */
export interface AppLiveRoom {
  room: string
  /** null when the viewerCounter feature is off for this app. */
  viewers: number | null
  publishers: number
  startedAt?: string
}

export interface AppStatsLive {
  activeStreams: number
  /** null when viewerCounter is disabled app-wide. */
  totalViewers: number | null
  rooms: AppLiveRoom[]
}

/** Per-status VOD counts (mirrors lib/appStats VodStatusCounts). */
export interface AppStatsVods {
  count: number
  totalBytes: number
  byStatus: {
    ready: number
    failed: number
    recording: number
    uploading: number
  }
}

export interface AppStatsStorage {
  appDbBytes: number
  vodBytes: number
}

export interface AppStatsIngress {
  total: number
  active: number
}

export interface AppStatsEvents24h {
  error: number
  warn: number
  info: number
}

/** GET /apps/:app/stats — the Tablero (overview) data source. */
export interface AppStats {
  ts: string
  app: { name: string; displayName: string }
  live: AppStatsLive
  vods: AppStatsVods
  storage: AppStatsStorage
  ingress: AppStatsIngress
  events24h: AppStatsEvents24h
}

// ---------------------------------------------------------------------------
// Cluster — node registry (GET/PATCH/DELETE /cluster/nodes, /cluster/info)
// ---------------------------------------------------------------------------

/** A registered cluster node. `stale` = last_seen_at is older than the TTL. */
export interface ClusterNode {
  id: string
  name: string
  url: string
  region: string | null
  status: string
  created_at: string
  last_seen_at: string | null
  /** Free-form health snapshot (cpu/ram/streams…) when the node reported one. */
  stats?: Record<string, unknown> | null
  stale: boolean
}

/** GET /cluster/info — cluster-wide config + the node join one-liner. */
export interface ClusterInfo {
  enabled: boolean
  nodesCount: number
  clusterToken: string
  clusterRedisUrl: string
  joinCommand: string
}

/** PATCH /cluster/nodes/:id — editable node fields. */
export interface UpdateNodeRequest {
  name?: string
  region?: string
  status?: string
}

// ---------------------------------------------------------------------------
// Server settings — GET /system/settings (read-only, secrets redacted)
// ---------------------------------------------------------------------------

/** Permission-enforcement mode (a security mode, shown verbatim — not a secret). */
export type AuthzEnforce = 'off' | 'log' | 'on'

export interface ServerSettingsCore {
  nodeEnv: string
  port: number
  host: string
  publicBaseUrl: string
  publicWsUrl: string
  rtmpPublicHost: string
  logLevel: string
  logRetentionDays: number
  authzEnforce: AuthzEnforce
  /** Redis endpoint as `host:port` — password already stripped by the backend. */
  redisUrl: string
  dataDir: string
}

export interface ServerSettingsAuth {
  adminUser: string
  jwtSecretSet: boolean
  adminPassSet: boolean
  smtpConfigured: boolean
  superadminEmail: string
}

export interface ServerSettingsLivekit {
  url: string
  apiKeySet: boolean
  /** First 6 chars of the API key + ellipsis (empty when unset). */
  apiKeyMasked: string
}

export interface ServerSettingsCluster {
  enabled: boolean
  redisConfigured: boolean
  nodesCount: number
}

export interface ServerSettingsMetrics {
  tokenSet: boolean
}

export interface ServerSettingsStorage {
  dataDir: string
  dbSizeBytes: number
  appsCount: number
}

export interface ServerSettingsVersions {
  core: string
  node: string
}

export interface ServerSettingsRuntime {
  uptimeSeconds: number
  pid: number
  platform: string
  memoryRssBytes: number
}

export interface ServerSettingsPorts {
  core: number
  livekitSignaling: number
  livekitTcp: number
  livekitUdp: number
  rtmp: number
  whip: number
}

/** One operator hint: what a setting is, its env var, and how to change it. */
export interface SettingGuidance {
  setting: string
  envVar: string
  howToChange: string
}

/** Guidance keyed by group id (core/auth/livekit/cluster/metrics/storage). */
export type SettingsGuidance = Record<string, SettingGuidance[]>

/** GET /system/settings — effective config with every secret redacted. */
export interface ServerSettings {
  core: ServerSettingsCore
  auth: ServerSettingsAuth
  livekit: ServerSettingsLivekit
  cluster: ServerSettingsCluster
  metrics: ServerSettingsMetrics
  storage: ServerSettingsStorage
  versions: ServerSettingsVersions
  runtime: ServerSettingsRuntime
  ports: ServerSettingsPorts
  guidance: SettingsGuidance
}
