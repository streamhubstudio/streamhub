/**
 * Type definitions for the streamhub-core API (base /api/v1).
 * Derived from the authoritative OpenAPI doc
 * (https://streamhub.digitalhub.com.ar/api/v1/openapi.json) plus verified notes.
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

/** This node's role in a StreamHub cluster (CLUSTER-ROADMAP §5). */
export type NodeRole = 'standalone' | 'master' | 'edge'

/** GET /auth/config — public auth capabilities of this deployment. */
export interface AuthConfig {
  /** True when public self-signup (STREAMHUB_ALLOW_SIGNUP) is enabled. */
  allowSignup: boolean
  /**
   * Cluster role of this node. `edge` nodes disable login (managed at the
   * master). Older backends omit these fields — treat a missing value as a
   * `standalone` node with login enabled.
   */
  nodeRole?: NodeRole
  /** Master API base URL to link to from the edge screen (when nodeRole=edge). */
  masterUrl?: string | null
  /** False on a cluster edge — the SPA shows the "manage at the master" screen. */
  loginEnabled?: boolean
  /**
   * Real product version (repo-root VERSION file, e.g. "2.7.0") — shown in the
   * dashboard footer. Optional: older backends omit it (footer hides then).
   */
  appVersion?: string
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
  /**
   * Per-app IANA timezone (owner item 11), e.g. `America/Argentina/Buenos_Aires`.
   * Empty string = server default (local time). Validated server-side against
   * the runtime's IANA zone list.
   */
  timezone?: string
  recordingEnabled?: boolean
  callbackUrl?: string
  callbackSecret?: string
  features?: AppFeatures
  /**
   * RTMP→HLS passthrough (remux, no transcode). Turning it ON forces
   * transcode/adaptive OFF and vice-versa — the backend enforces the invariant.
   */
  rtmpPassthrough?: boolean
  /** Split recordings into N-minute parts. 0|15|30|60|90|120. */
  splitMinutes?: number
  /** Snapshot every N seconds during recording. 0|1|30|60|120|360. */
  snapshotSeconds?: number
  /** Recording filename/S3-key template (`${}` dialect). '' = built-in naming. */
  filenameTemplate?: string
  /** Snapshot filename/S3-key template. '' = built-in naming. */
  snapshotTemplate?: string
  /** VOD retention window in days. 0=off | 7 | 30 | 90 | 180 | 360. */
  retentionDays?: number
  /** Per-app plain-config variables (`${var.NAME}`) — whole-map replace. */
  variables?: Record<string, string>
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
  /**
   * RTMP block as returned by GET /apps/:app/config. `passthrough` is the
   * RTMP→HLS remux switch (mutually exclusive with transcode/adaptive).
   */
  rtmp?: { enabled?: boolean; transcode?: boolean; passthrough?: boolean }
  /** Server-side transcoding block. `enabled` is the master transcode switch. */
  transcoding?: { enabled?: boolean; [k: string]: unknown }
  /** Hardware acceleration preference for FFmpeg transcode (config.yaml). */
  hwaccel?: HwAccelMode
  /**
   * Per-app IANA timezone (owner item 11), e.g. `America/Argentina/Buenos_Aires`.
   * Empty/absent = server default (local time). Edited via `PATCH /apps/:name`
   * (`UpdateAppConfigRequest.timezone`), not this endpoint — read-only here.
   */
  timezone?: string
  features?: AppFeatures
  /**
   * Recording naming + retention (camelCase) as returned by
   * GET /apps/:app/config for the config screen.
   */
  recording?: RecordingViewConfig
  callbacks?: CallbacksConfig
  /** Per-app plain-config variables (`${var.NAME}` in filename templates). */
  variables?: Record<string, string>
  [k: string]: unknown
}

/**
 * Recording naming/retention as returned (camelCase) by GET /apps/:app/config.
 */
export interface RecordingViewConfig {
  enabled: boolean
  splitMinutes: number
  snapshotSeconds: number
  filenameTemplate: string
  snapshotTemplate: string
  retentionDays: number
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
  /**
   * G4 fold-2: true iff every key this preset sets currently matches, at the
   * same value, the app's config.yaml. Drives the "Applied ✓ / Deactivate" vs
   * "Apply" toggle in the Config tab.
   */
  applied: boolean
}

/** G4 — result of POST /apps/:app/presets/:name/apply (or .../deactivate). */
export interface ApplyPresetResult {
  preset: string
  /** true after an apply, false after a deactivate — mirrors the resulting state. */
  applied: boolean
  reloaded: boolean
  changed: boolean
  /** Unified diff current → resulting config. */
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
// Owner item 29 — per-app + per-user SMTP
// ---------------------------------------------------------------------------

/** GET /apps/:app/smtp and GET/PUT /account/smtp — password masked. */
export interface SmtpConfig {
  enabled?: boolean
  host?: string
  port?: number
  user?: string
  from?: string
  /** Masked password (display only). */
  pass?: string
  hasPass?: boolean
  configured?: boolean
  [k: string]: unknown
}

/**
 * PUT /apps/:app/smtp and PUT /account/smtp — writes the smtp block; the
 * password goes to secrets.json (app) / an encrypted user column (account).
 * Omit `pass` to keep the stored one.
 */
export interface UpdateSmtpRequest {
  enabled?: boolean
  host?: string
  port?: number
  user?: string
  from?: string
  pass?: string
}

/** Body of POST .../smtp/test. */
export interface TestSmtpRequest {
  to: string
}

/** Result of POST .../smtp/test — never an HTTP error, always this shape. */
export interface SendResult {
  ok: boolean
  messageId?: string
  error?: string
  skipped?: boolean
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

/**
 * One downloadable, self-contained example bundle (GET /apps/:app/examples).
 * The zip (index.html + config.js + README.md) is pre-configured for the app
 * and can be hosted on any static host.
 */
export interface ExampleInfo {
  id: string
  file: string
  title: string
  description: string
  authModel: string
  requiredConfig: string[]
  optionalConfig: string[]
  /** Absolute URL of the per-app zip (management endpoint, bearer). */
  downloadUrl: string
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

/**
 * POST /apps/:app/play-token/:room/sign — a signed, expiring playback
 * capability (P0-3) plus ready-to-paste tokenized surfaces. `sig`+`exp` are an
 * app+room-scoped HMAC (NOT an sk_ token or JWT); `embedUrl`/`iframe` carry them
 * so a private-playback app can be embedded without leaking a bearer.
 */
export interface SignedPlayback {
  app: string
  room: string
  exp: number
  ttlSeconds: number
  sig: string
  /** Raw API capability URL (GET play-token with ?exp=&sig=). */
  tokenUrl: string
  /** Public player page carrying the capability. */
  playUrl: string
  /** Bare embeddable player page carrying the capability. */
  embedUrl: string
  /** `<iframe>` snippet over embedUrl — the full player widget. */
  iframe: string
}

// ---------------------------------------------------------------------------
// Ingress
// ---------------------------------------------------------------------------

/**
 * Ingest input type for POST /apps/:app/ingress.
 *  - `rtmp` / `whip` / `url` — the LiveKit ingress kinds (`url` also PULLS a
 *    remote `srt://` source when the LiveKit server version supports it).
 *  - `srt` — SRT PUSH listener. Passthrough (remux) plane ONLY: LiveKit's
 *    ingress API has no SRT input, so the backend rejects `inputType:'srt'`
 *    without `mode:'passthrough'` (400).
 *  - `mpegts` — MPEG-TS over UDP (unicast + multicast) PULL. Passthrough (remux)
 *    plane ONLY: `url` carries a `udp://@GROUP:PORT` source; the backend rejects
 *    `inputType:'mpegts'` without `mode:'passthrough'` (400).
 */
export type IngressInputType = 'rtmp' | 'whip' | 'url' | 'srt' | 'mpegts'

/**
 * Ingest plane for a new RTMP/SRT ingress:
 *  - `transcode` (default) — the normal LiveKit path (WebRTC + HLS + optional
 *    adaptive/recording/room features);
 *  - `passthrough` — REMUX the RTMP/SRT push straight to HLS (`ffmpeg -c copy`),
 *    bypassing LiveKit. Near-zero CPU, no GPU; gives up everything that needs the
 *    media to enter the SFU (see `PassthroughCapabilities`). Server-gated (503
 *    when off). SRT pushes are passthrough-ONLY.
 */
export type IngressMode = 'transcode' | 'passthrough'

/**
 * What an RTMP→HLS passthrough (remux) ingress GIVES UP versus the normal
 * LiveKit path, returned on a passthrough create so the dashboard can warn the
 * operator. Every boolean is a capability that is OFF because the media never
 * enters LiveKit. `lost` is the human-readable "what you lose" list to render.
 */
export interface PassthroughCapabilities {
  mode: 'passthrough'
  remux?: boolean
  webrtc?: boolean
  subSecondLatency?: boolean
  adaptiveBitrate?: boolean
  transcode?: boolean
  requiresH264Aac?: boolean
  recording?: boolean
  roomFeatures?: boolean
  backupKey?: boolean
  gpu?: boolean
  /**
   * SRT only: the SRT receive-latency budget (libsrt retransmission window,
   * default ~120 ms) added on top of the HLS latency. Not a lost capability —
   * a heads-up the UI surfaces next to the warning.
   */
  latencyMs?: number
  /** Human-readable "what you lose" lines for the UI warning. */
  lost: string[]
}

export interface CreateIngressRequest {
  inputType: IngressInputType
  room?: string
  participantIdentity?: string
  participantName?: string
  /**
   * Pull source. Required for `inputType:'url'` (rtsp/http/srt via LiveKit) and
   * for `inputType:'mpegts'` (a udp://@GROUP:PORT multicast/unicast source).
   */
  url?: string
  /**
   * MPEG-TS multicast only: source-specific multicast (SSM/IGMPv3) include list —
   * a comma-separated list of source IPv4s to receive from (ffmpeg `sources=`).
   */
  sources?: string
  /** MPEG-TS only: local interface (NIC) IPv4 to bind/join the group on. */
  localaddr?: string
  /** MPEG-TS only: ffmpeg `fifo_size` (UDP receive buffer, in 188-byte packets). */
  fifoSize?: number
  /** MPEG-TS only: ffmpeg `overrun_nonfatal` (survive a buffer overrun). Default on. */
  overrunNonfatal?: boolean
  enableTranscoding?: boolean
  /**
   * RTMP only: also mint a BACKUP (failover) stream key bound to the SAME room.
   * Both keys publish into one room, so the player URL is unchanged whichever
   * key is live. Ignored for whip/url.
   */
  backup?: boolean
  /**
   * RTMP/SRT only: ingest plane. Defaults server-side to the app's
   * `rtmp.passthrough` config. `passthrough` cannot be combined with
   * `enableTranscoding`/`backup` (the backend rejects the mix with a 400).
   * `inputType:'srt'` REQUIRES `mode:'passthrough'` (LiveKit has no SRT input).
   */
  mode?: IngressMode
}

/**
 * A per-app dynamic tag (Vision-Edge §E) — an operator-created label applied to
 * streams by slug, with an optional per-consumer settings blob. CRUD lives under
 * /apps/:app/tags.
 */
export interface Tag {
  slug: string
  label: string
  kind?: string
  config_json?: Record<string, unknown> | null
  createdAt?: string
  updatedAt?: string
}

/** Body of POST /apps/:app/tags — create a tag. `slug` must be kebab-case. */
export interface CreateTagRequest {
  slug: string
  label: string
  kind?: string
  config_json?: Record<string, unknown>
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
  /**
   * Ingest plane. `passthrough` rows (id `pti_…`, key `ptk_…`) are remuxed
   * straight to HLS and carry `hls_url` + `capabilities`; `transcode` (or absent)
   * is the normal LiveKit ingress.
   */
  mode?: IngressMode
  /** Passthrough only: `/hls/<app>/<room>/index.m3u8` (the only playback). */
  hls_url?: string
  /**
   * SRT passthrough only (id `pti_srt_…`): the SRT push URL —
   * `srt://<host>:<port>?streamid=<key>`. SRT URLs have no path, so the stream
   * key rides as `streamid`; the key IS the credential (no user/password).
   * Mutually exclusive with `rtmp_url` (one push transport per ingress).
   */
  srt_url?: string
  /**
   * MPEG-TS passthrough only (id `pti_mpegts_…`): the canonical udp://@GROUP:PORT
   * source the remux PULLS from (a multicast group / unicast port — there is no
   * push URL for this transport). Mutually exclusive with rtmp_url / srt_url.
   */
  source_url?: string
  /** Passthrough only: what this ingress gives up vs the LiveKit path. */
  capabilities?: PassthroughCapabilities
  /** Role inside a primary+backup (failover) pair, when annotated. */
  role?: 'primary' | 'backup'
  /** The sibling ingress id of a failover pair (the other key). */
  pairedIngressId?: string
  /** True on a create response when a backup key was also minted. */
  hasBackup?: boolean
  /** Primary stream key (mirrors `stream_key`) — present on RTMP responses. */
  primaryStreamKey?: string
  primary_rtmp_url?: string
  primary_rtmps_url?: string
  /** Backup (failover) key + push URLs, present when a backup exists. */
  backupIngressId?: string
  backupStreamKey?: string
  backup_stream_key?: string
  backup_rtmp_url?: string
  backup_rtmps_url?: string
  backup_stream_password?: string
  /** RTMPS push URL for the primary key (only when RTMPS is enabled). */
  rtmps_url?: string
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

/** One timed transcript segment (seconds), speaker-labelled when attributable. */
export interface VodTranscriptSegment {
  start: number
  end: number
  text: string
  speaker?: string | null
}

/**
 * GET /apps/:app/vods/:id/transcript — output of the `transcription` plugin
 * for a VOD (404 until a transcription was triggered). `srtUrl` is a fresh
 * presigned URL of the SRT uploaded next to the VOD in the app's S3.
 */
export interface VodTranscript {
  vodId: number
  status: 'queued' | 'processing' | 'ready' | 'failed'
  provider: string | null
  model: string | null
  language: string | null
  text: string | null
  segments: VodTranscriptSegment[]
  speakers: string[]
  srtKey: string | null
  srtUrl: string | null
  error: string | null
  createdAt?: string
  updatedAt?: string
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
 * Per-stream plugin opt-out state. Returned by GET/PATCH
 * /apps/:app/streams/:id/plugins. `disabled` lists the plugin ids this stream
 * is opted OUT of — a stream is affected by every app-enabled plugin NOT here.
 */
export interface StreamPluginsState {
  streamId: string
  disabled: string[]
}

/**
 * Per-stream applied tags. Returned by GET/PATCH /apps/:app/streams/:id/tags.
 * `tags` are the slugs applied to this stream (each references an app tag).
 */
export interface StreamTagsState {
  streamId: string
  tags: string[]
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
// Rooms (metadata + moderation — /apps/:app/rooms/*)
// ---------------------------------------------------------------------------

/** One published track of a room participant (with its sid, for moderation). */
export interface RoomParticipantTrack {
  sid: string
  /** 'audio' | 'video' | 'data'. */
  type: string
  source: string
  muted: boolean
}

/** Room participant as returned by GET /apps/:app/rooms/:room/participants. */
export interface RoomParticipant {
  identity: string
  name: string
  sid: string
  hidden: boolean
  isPublisher: boolean
  metadata?: string
  joinedAt: string | null
  tracks: RoomParticipantTrack[]
  permission: {
    canPublish: boolean
    canSubscribe: boolean
    canPublishData: boolean
    hidden: boolean
  }
}

/** Body of POST /apps/:app/rooms/:room/participants/:identity/mute. */
export interface MuteParticipantRequest {
  trackSid?: string
  kind?: 'audio' | 'video' | 'all'
  /** true = mute (default), false = unmute. */
  muted?: boolean
}

/** Result of the mute action (per-track outcomes). */
export interface MuteParticipantResult {
  room: string
  identity: string
  muted: boolean
  tracks: { trackSid: string; muted: boolean }[]
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
// Network I/O counters — GET /apps/:app/net (+ /net/history) (Wave 1C)
// ---------------------------------------------------------------------------

/** Byte totals for a rolling window. */
export interface NetWindow {
  in: number
  out: number
  total: number
}

/** Threshold posture for the app's rolling-24h ingress+egress bytes. */
export interface NetThresholdState {
  /** Configured rolling-24h cap in GB (GiB); 0 = unset. */
  gbPerDay: number
  /** Cap in bytes (0 = unset). */
  thresholdBytes: number
  /** Rolling-24h metered bytes (ingress+egress). */
  usage24hBytes: number
  /** usage / threshold as a percent; null when no threshold configured. */
  percent: number | null
  /** Instantaneous breach (usage >= threshold). */
  exceeded: boolean
}

/** GET /apps/:app/net response body. */
export interface NetSummary {
  today: NetWindow
  last24h: NetWindow
  last7d: NetWindow
  bySource: { source: string; in: number; out: number }[]
  threshold: NetThresholdState
}

/** One hourly history bucket. */
export interface NetHistoryBucket {
  bucket: string
  in: number
  out: number
}

/** GET /apps/:app/net/history response body. */
export interface NetHistory {
  hours: number
  buckets: NetHistoryBucket[]
}

// ---------------------------------------------------------------------------
// App pipeline — GET /apps/:app/pipeline (the Tablero flow-diagram source)
// ---------------------------------------------------------------------------

export type PipelineIngestType =
  | 'rtmp'
  | 'rtmps'
  | 'whip'
  | 'webrtc'
  | 'rtsp'
  | 'url'
  | 'ws-mjpeg'
  | 'srt'

/** One ingest entry point. `enabled` = configured; `active` = receiving now. */
export interface PipelineIngest {
  type: PipelineIngestType
  enabled: boolean
  active: boolean
  label: string
  detail?: string
}

/** Transports the remux / `-c copy` passthrough plane can accept. */
export type PassthroughTransport = 'rtmp' | 'srt'

export interface PipelineTranscoding {
  enabled: boolean
  encoder: 'gpu' | 'cpu'
  hwaccel: 'auto' | 'gpu' | 'cpu'
}

export interface PipelineAdaptive {
  enabled: boolean
  layers: Array<{ name: string; height: number }>
}

export interface PipelinePassthrough {
  enabled: boolean
  transports: PassthroughTransport[]
}

export interface PipelineProcessing {
  transcoding: PipelineTranscoding
  adaptive: PipelineAdaptive
  /** Remux / `-c copy` plane (no transcode), parallel to transcoding+adaptive. */
  passthrough: PipelinePassthrough
}

/** Distributed inference fleet + the app's enabled vision models. */
export interface PipelineCompute {
  edge: { total: number; online: number }
  vision: {
    enabled: boolean
    models: string[]
    assignments: { running: number; pending: number }
  }
}

export type PipelineDeliveryType = 'webrtc' | 'hls' | 'cdn' | 'restream'

/** One delivery endpoint. `enabled` = configured; `active` = serving now. */
export interface PipelineDelivery {
  type: PipelineDeliveryType
  enabled: boolean
  active: boolean
  label: string
  detail?: string
}

export interface PipelineStorage {
  recording: { enabled: boolean; splitMinutes?: number; snapshotSeconds?: number }
  s3: { configured: boolean; bucket?: string }
}

/** Plugin kind (Studio App vs in-process extension) and grouping category. */
export type PipelinePluginKind = 'plugin' | 'app'
export type PipelinePluginCategory = 'tool' | 'processor' | 'panel'

export interface PipelinePlugin {
  id: string
  enabled: boolean
  kind: PipelinePluginKind
  category: PipelinePluginCategory
}

/** Event fan-out taps — booleans/presence only, never a url/secret/token. */
export interface PipelineEvents {
  callbacks: { configured: boolean }
  mqtt: { enabled: boolean }
  log: { enabled: boolean }
}

/** Resolved notification channels (booleans only — never tokens/webhooks). */
export interface PipelineNotifications {
  email: boolean
  discord: boolean
  telegram: boolean
}

/**
 * GET /apps/:app/pipeline — the app's ACTUAL configured media pipeline
 * (ingest → core → processing → delivery + storage + compute + events), consumed
 * by <AppFlowDiagram> on the Tablero. Every section is always present; new
 * sections are optional-safe on the client so an older core still renders.
 */
export interface AppPipeline {
  ingest: PipelineIngest[]
  /** MediaMTX single-port :1935 front-door router. */
  ingestFront?: { mediamtx: boolean; port: number }
  processing: PipelineProcessing
  compute?: PipelineCompute
  delivery: PipelineDelivery[]
  storage: PipelineStorage
  plugins: PipelinePlugin[]
  live: { activeStreams: number; viewers?: number; tags?: string[] }
  events?: PipelineEvents
  notifications?: PipelineNotifications
  /** Rolling network I/O over `windowSec` seconds (bytes). */
  net?: { inBytes: number; outBytes: number; windowSec: number }
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
// Edge — the cluster's distributed processing surface (GET /edge/nodes,
// /edge/assignments; POST /edge/nodes/:id/command). Global-scope (superadmin).
// ---------------------------------------------------------------------------

/** GPU capability block a node advertises inside its telemetry `stats.grid`. */
export interface EdgeGridCaps {
  gpu?: boolean
  vramGb?: number | null
  vramFreeMb?: number | null
  gpuName?: string | null
  capabilities?: string[]
}

/** A node dressed for the edge manager UI: registry row + live liveness + stats. */
export interface EdgeNodeView {
  id: string
  name: string
  url: string | null
  region: string | null
  type: 'common' | 'edge'
  weight: number
  status: string
  /** Live WS connection right now. */
  connected: boolean
  /** Not connected AND not heartbeated within the stale window. */
  stale: boolean
  createdAt: string
  lastSeenAt: string | null
  /** Last telemetry blob (cpu/mem/disk numbers + a `grid` GPU block), or null. */
  stats: Record<string, unknown> | null
}

/**
 * PATCH /edge/nodes/:id — retype a node (`common`↔`edge`) and/or set its
 * scheduling `weight` (share ∝ weight/Σweights, used by the weighted policy).
 * Weight is an integer 0–100000; an empty body is a no-op.
 */
export interface PatchEdgeNodeRequest {
  type?: EdgeNodeView['type']
  weight?: number
}

/** Node commands the master relays over the WS channel. */
export type EdgeNodeCommand = 'restart' | 'reboot' | 'ping'

/** Lifecycle of one edge assignment (a worker workload placed on one node). */
export type EdgeAssignmentStatus =
  | 'pending'
  | 'offered'
  | 'running'
  | 'stopped'
  | 'failed'
  | 'revoked'

/** One row of the global `edge_assignments` table (app × plugin [× stream] → node). */
export interface EdgeAssignment {
  id: string
  nodeId: string
  app: string
  pluginId: string
  streamId: string | null
  config: Record<string, unknown>
  status: EdgeAssignmentStatus
  detail: string | null
  createdAt: string
  updatedAt: string
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

// --- network security (/security/*) ------------------------------------------

/** One allow/block rule (GET/POST /security/ip-rules). */
export interface SecurityIpRule {
  id: number
  cidr: string
  action: 'allow' | 'block'
  note: string | null
  createdAt: string
  createdBy: string | null
}

/** An active or recently expired auto-ban (GET /security/bans). */
export interface SecurityBan {
  ip: string
  reason: string
  firstSeen: string
  offenseCount: number
  bannedUntil: string
  escalationLevel: number
  active: boolean
}

/** A recent offender inside the sliding window (GET /security/offenses). */
export interface SecurityOffender {
  ip: string
  count: number
  lastSeen: string
  kinds: Record<string, number>
}

/** GET /security/status — mode, autoban config and live counts. */
export interface SecurityStatus {
  mode: 'off' | 'log' | 'enforce'
  allowlistOnly: boolean
  autoban: {
    enabled: boolean
    maxOffenses: number
    windowS: number
    baseTtlS: number
    track404: boolean
  }
  counts: {
    rules: number
    allowRules: number
    blockRules: number
    activeBans: number
    trackedOffenders: number
  }
}

// --- backups (/system/backups — superadmin) -----------------------------------

/** One snapshot file of a database (GET /system/backups). */
export interface BackupSnapshot {
  /** Target id (`streamhub` | `app-<name>`). */
  db: string
  /** Filename inside the target's snapshot dir, e.g. `2026-07-06T03-30-00-000Z.db.gz`. */
  file: string
  sizeBytes: number
  createdAt: string
  /** True for the automatic safety copy taken right before a restore. */
  preRestore: boolean
}

/** One database (global registry or an app.db) with its snapshots. */
export interface BackupDatabase {
  db: string
  kind: 'global' | 'app'
  app?: string
  dbPath: string
  liveSizeBytes: number | null
  /** Snapshots exist but the target (e.g. a deleted app) no longer does. */
  orphaned: boolean
  snapshots: BackupSnapshot[]
}

/** GET /system/backups — settings + per-DB snapshot inventory. */
export interface BackupsOverview {
  enabled: boolean
  retentionDays: number
  backupDir: string
  schedule: string
  databases: BackupDatabase[]
}

/** POST /system/backups — on-demand run summary. */
export interface BackupRunResult {
  ranAt: string
  reason: string
  snapshots: BackupSnapshot[]
  errors: { db: string; error: string }[]
  prunedCount: number
}

/** POST /system/backups/restore — result of a guarded restore. */
export interface BackupRestoreResult {
  db: string
  snapshot: string
  /** The safety copy taken from the live DB right before the swap. */
  preRestoreSnapshot: string
  integrity: 'ok'
  restored: true
  /** True when restoring the global registry — restart the core to refresh caches. */
  restartRecommended: boolean
}

// --- resource-usage history (/system/metrics/history — superadmin) -----------

/** Time window accepted by the history endpoint. */
export type MetricsHistoryRange = '24h' | '7d' | '30d' | '90d'

/** Which series to fetch (omit for all). */
export type MetricsHistoryMetric = 'cpu' | 'mem' | 'disk' | 'net'

/** A CPU / disk dot: percentage over the bucket (null = no data). */
export interface HistoryPoint {
  /** Bucket start, epoch ms. */
  ts: number
  value: number | null
}

/** A memory dot: absolute bytes + derived percentage. */
export interface MemHistoryPoint {
  ts: number
  used: number | null
  total: number | null
  pct: number | null
}

/** A network dot: bytes moved during the bucket (delta of the counters). */
export interface NetHistoryPoint {
  ts: number
  rx: number | null
  tx: number | null
}

/**
 * GET /system/metrics/history — bucketed host resource-usage history for the
 * dot charts. Only the requested metric(s) are present in `series`.
 */
export interface MetricsHistoryResponse {
  range: MetricsHistoryRange
  retentionDays: number
  /** Query time, epoch ms. */
  now: number
  /** Bucket width in ms (3_600_000 = 1h). */
  bucketMs: number
  series: {
    cpu?: HistoryPoint[]
    mem?: MemHistoryPoint[]
    disk?: HistoryPoint[]
    net?: NetHistoryPoint[]
  }
}

// --- audit log (/system/audit — superadmin) ----------------------------------

/** Who performed an audited action. */
export type AuditActorType = 'user' | 'token' | 'admin' | 'system' | 'anonymous'

/** Outcome of an audited action. */
export type AuditResult = 'success' | 'failure' | 'deny'

/**
 * One tamper-evident audit entry (GET /system/audit). `action` is dotted, e.g.
 * `auth.login`, `token.create`, `authz.deny`, `config.update`. Entries are
 * chained by hash; integrity is checked via GET /system/audit/verify.
 */
export interface AuditEntry {
  id: number
  /** ISO timestamp. */
  ts: string
  actorType: AuditActorType
  actorId: string | null
  tenantId: string | null
  action: string
  targetType: string | null
  targetId: string | null
  ip: string | null
  result: AuditResult
  meta: Record<string, unknown> | null
}

/** GET /system/audit — a page of entries (newest first) + paging siblings. */
export interface AuditPage {
  entries: AuditEntry[]
  total: number
  limit: number
  offset: number
}

/** GET /system/audit/verify — hash-chain integrity check of the log. */
export interface AuditVerifyResult {
  /** True when the whole chain verifies. */
  ok: boolean
  /** Number of entries checked. */
  checked: number
  /** Id of the first broken link, or null when the chain is intact. */
  brokenAt: number | null
}

// --- security posture / compliance (/system/compliance — superadmin) ---------

/** State of a single compliance control. */
export type ComplianceState = 'active' | 'partial' | 'off' | 'unknown'

/**
 * One ISO 27002 §8 technological control mapped to its live state on this
 * deployment (GET /system/compliance). `iso` is the clause number, e.g. '8.15'.
 */
export interface ComplianceControl {
  id: string
  name: string
  iso: string
  state: ComplianceState
  detail: string
}

/** Per-state control counts. */
export interface ComplianceSummary {
  active: number
  partial: number
  off: number
  unknown: number
}

/** GET /system/compliance — live evidence of active security controls. */
export interface ComplianceReport {
  /** ISO timestamp the evidence was gathered. */
  checkedAt: string
  summary: ComplianceSummary
  controls: ComplianceControl[]
}

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

// --- OS performance tuning (/system/os-tuning — superadmin) ------------------

/** Verdict for one OS tuning knob. */
export type TuningStatus = 'applied' | 'not-applied' | 'unknown'

/**
 * One kernel/limit knob that matters for a LiveKit/WebRTC media server: its
 * live value vs the recommended value vs an applied/not-applied verdict, with a
 * copy-paste remedy line. Read-only — the core never applies these (install.sh
 * does, on the real host).
 */
export interface OsTuningKnob {
  id: string
  label: string
  /** Where it is read from: sysctl file / process limits / /sys. */
  source: 'sysctl' | 'limits' | 'sys'
  /** The sysctl key, /proc/self/limits row name, or /sys path. */
  key: string
  /** Raw current value (null = unknown / unavailable / non-Linux). */
  current: string | null
  recommended: string
  status: TuningStatus
  /** Why it matters for a media server. */
  why: string
  /** The remedy line (sysctl/ulimit) to apply on the host. */
  remedy: string
  /** Non-essential knobs (e.g. transparent hugepages) are flagged optional. */
  optional: boolean
}

/** Per-status knob counts. */
export interface OsTuningSummary {
  applied: number
  notApplied: number
  unknown: number
}

/** GET /system/os-tuning — live OS tuning posture of this node. */
export interface OsTuningReport {
  /** ISO timestamp the values were read. */
  checkedAt: string
  /** process.platform of the node the core runs on. */
  platform: string
  /** True on Linux (where /proc tuning can actually be inspected). */
  supported: boolean
  summary: OsTuningSummary
  knobs: OsTuningKnob[]
  /** Operator note (install.sh applies these on a real host). */
  note: string
}
