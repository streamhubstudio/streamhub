/**
 * Typed streamhub-core API client (base /api/v1).
 * Grouped by resource. Every method returns the unwrapped payload.
 *
 * Usage:
 *   import { api } from '@/api'
 *   const apps = await api.apps.list()
 */
import { request } from './http'
import {
  buildIngressQuery,
  buildLogsQuery,
  buildVodsQuery,
  toQueryRecord,
} from '@/lib/queryParams'
import type {
  AccountInfo,
  App,
  AppSizes,
  AppStats,
  AuthConfig,
  ChangePasswordRequest,
  ClusterInfo,
  ClusterNode,
  UpdateNodeRequest,
  VodListParams,
  VodsPage,
  VodDownload,
  CreateAppRequest,
  CreatedToken,
  CreateIngressRequest,
  CreateTokenRequest,
  ApplyPresetResult,
  ConfigBackup,
  ConfigDryRunResult,
  ConfigPreset,
  ConfigReloadResult,
  DbHealth,
  DbOptimizeResult,
  DbPurgeRequest,
  DbPurgeResult,
  GpuInfo,
  Health,
  InviteMemberRequest,
  InviteResult,
  Member,
  MeResponse,
  MyTeam,
  PendingInvite,
  Tenant,
  TenantUsage,
  TwoFaSetup,
  UpdateAccountRequest,
  UpdateMemberRequest,
  UpdateQuotasRequest,
  HlsSession,
  HlsStatus,
  HlsStopResult,
  Ingress,
  IngressListParams,
  IngressPage,
  ListenToken,
  LogEntry,
  LoginRequest,
  LoginResponse,
  MagicLinkRequest,
  MagicLinkResponse,
  MagicVerifyRequest,
  MagicVerifyResponse,
  SessionInfo,
  SignupRequest,
  LogQuery,
  LogsPage,
  MintedToken,
  MintTokenRequest,
  PlayToken,
  RawConfig,
  RecordingHandle,
  RegenerateSamplesResult,
  Sample,
  S3Config,
  MqttConfig,
  UpdateMqttRequest,
  RecordStopResult,
  AddRestreamRequest,
  RestreamTarget,
  SecurityBan,
  SecurityIpRule,
  SecurityOffender,
  SecurityStatus,
  SendDataRequest,
  ServerSettings,
  SnapshotRequest,
  SnapshotResult,
  BroadcastEgress,
  StartBroadcastRequest,
  StopBroadcastResult,
  Stats,
  Stream,
  StartRecordingRequest,
  TokenSummary,
  TranscodingConfig,
  UpdateAppConfigRequest,
  UpdateS3Request,
  UpdateTranscodingConfigRequest,
  ValidateIngressPasswordRequest,
  Vod,
  WebrtcLayer,
  CreateWsIngestRequest,
  WsIngestKey,
  WsIngestLiveInfo,
} from './types'

// --- auth -------------------------------------------------------------------

const auth = {
  /**
   * GET /auth/config — public capabilities (e.g. allowSignup). Drives the
   * "Create account" affordance on the login screen. No bearer required.
   */
  config(signal?: AbortSignal): Promise<AuthConfig> {
    return request<AuthConfig>('/auth/config', { auth: false, signal })
  },
  /** POST /auth/login — returns { token }. No bearer required. */
  login(payload: LoginRequest): Promise<LoginResponse> {
    return request<LoginResponse>('/auth/login', {
      method: 'POST',
      body: payload,
      auth: false,
    })
  },
  /** POST /auth/signup — create an account (+ optional team). Returns { token }. */
  signup(payload: SignupRequest): Promise<LoginResponse> {
    return request<LoginResponse>('/auth/signup', {
      method: 'POST',
      body: payload,
      auth: false,
    })
  },
  /**
   * POST /auth/magic-link — passwordless sign-in. The backend emails a signed
   * link (SMTP) to the address; no bearer required. Always resolves on 2xx even
   * for unknown emails (anti-enumeration).
   */
  magicLink(payload: MagicLinkRequest): Promise<MagicLinkResponse> {
    return request<MagicLinkResponse>('/auth/magic-link', {
      method: 'POST',
      body: payload,
      auth: false,
    })
  },
  /**
   * POST /auth/magic/verify — exchange a magic-link token (from the emailed
   * link's ?token=) for a session JWT. Throws ApiRequestError on invalid/expired
   * tokens (400/401/410). No bearer required.
   */
  magicVerify(payload: MagicVerifyRequest): Promise<MagicVerifyResponse> {
    return request<MagicVerifyResponse>('/auth/magic/verify', {
      method: 'POST',
      body: payload,
      auth: false,
    })
  },
}

// --- health / stats (PLAIN, no envelope) ------------------------------------

const system = {
  /** GET /health — public, plain object. */
  health(signal?: AbortSignal): Promise<Health> {
    return request<Health>('/health', { auth: false, plain: true, signal })
  },
  /** GET /stats — auth, plain object. */
  stats(signal?: AbortSignal): Promise<Stats> {
    return request<Stats>('/stats', { plain: true, signal })
  },
  /**
   * GET /system/gpu — server-wide GPU detection ({ available, type, devices }).
   * Drives the hwaccel selector: when `available` is false, gpu/auto → CPU.
   */
  gpu(signal?: AbortSignal): Promise<GpuInfo> {
    return request<GpuInfo>('/system/gpu', { signal })
  },
  /**
   * GET /system/settings — READ-ONLY effective server config with every secret
   * redacted, plus per-group guidance on how to change each setting. Global-scope
   * (superadmin) surface; an app-scoped token gets 403, anonymous gets 401.
   */
  settings(signal?: AbortSignal): Promise<ServerSettings> {
    return request<ServerSettings>('/system/settings', { signal })
  },
}

// --- apps -------------------------------------------------------------------

const apps = {
  list(signal?: AbortSignal): Promise<App[]> {
    return request<App[]>('/apps', { signal })
  },
  get(name: string, signal?: AbortSignal): Promise<App> {
    return request<App>(`/apps/${encodeURIComponent(name)}`, { signal })
  },
  /** GET /apps/:app/sizes → this app's app.db size + VOD storage rollup. */
  sizes(name: string, signal?: AbortSignal): Promise<AppSizes> {
    return request<AppSizes>(`/apps/${encodeURIComponent(name)}/sizes`, { signal })
  },
  /**
   * GET /apps/:app/stats → the Tablero (overview) rollup: live rooms/viewers,
   * VOD counts by status, storage, ingress and 24h event buckets. Enveloped
   * ({ data }); the whole payload lives inside `data`.
   */
  stats(name: string, signal?: AbortSignal): Promise<AppStats> {
    return request<AppStats>(`/apps/${encodeURIComponent(name)}/stats`, { signal })
  },
  create(payload: CreateAppRequest): Promise<App> {
    return request<App>('/apps', { method: 'POST', body: payload })
  },
  update(name: string, payload: UpdateAppConfigRequest): Promise<App> {
    return request<App>(`/apps/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: payload,
    })
  },
  remove(name: string, deleteVods = false): Promise<void> {
    return request<void>(`/apps/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      query: { deleteVods },
    })
  },

  // transcoding / adaptive config
  getConfig(name: string, signal?: AbortSignal): Promise<TranscodingConfig> {
    return request<TranscodingConfig>(`/apps/${encodeURIComponent(name)}/config`, {
      signal,
    })
  },
  updateConfig(
    name: string,
    payload: UpdateTranscodingConfigRequest,
  ): Promise<TranscodingConfig> {
    return request<TranscodingConfig>(`/apps/${encodeURIComponent(name)}/config`, {
      method: 'PATCH',
      body: payload,
    })
  },
  transcodingLayers(name: string, signal?: AbortSignal): Promise<WebrtcLayer[]> {
    return request<WebrtcLayer[]>(
      `/apps/${encodeURIComponent(name)}/transcoding/layers`,
      { signal },
    )
  },

  // --- Wave 4: raw config.yaml editor + hot reload --------------------------

  /** GET /apps/:app/config/raw → the verbatim config.yaml text. */
  getConfigRaw(name: string, signal?: AbortSignal): Promise<RawConfig> {
    return request<RawConfig>(`/apps/${encodeURIComponent(name)}/config/raw`, {
      signal,
    })
  },
  /**
   * PUT /apps/:app/config/raw { yaml } → validates (js-yaml parse + shape),
   * writes config.yaml and hot-reloads into the in-memory registry (+ re-inits
   * the S3 client). Parse errors throw ApiRequestError (400) and DO NOT write.
   */
  putConfigRaw(name: string, yaml: string): Promise<ConfigReloadResult> {
    return request<ConfigReloadResult>(
      `/apps/${encodeURIComponent(name)}/config/raw`,
      { method: 'PUT', body: { yaml } },
    )
  },
  /** POST /apps/:app/reload — manual hot-reload (no process restart). */
  reload(name: string): Promise<ConfigReloadResult> {
    return request<ConfigReloadResult>(`/apps/${encodeURIComponent(name)}/reload`, {
      method: 'POST',
    })
  },

  // --- G4: config presets ---------------------------------------------------

  /** GET /apps/:app/presets → the built-in delivery/quality profiles. */
  listPresets(name: string, signal?: AbortSignal): Promise<ConfigPreset[]> {
    return request<ConfigPreset[]>(`/apps/${encodeURIComponent(name)}/presets`, {
      signal,
    })
  },
  /**
   * POST /apps/:app/presets/:preset/apply → deep-merges the preset over
   * config.yaml (credential-safe), backs up, writes and hot-reloads. Returns the
   * diff of the change.
   */
  applyPreset(name: string, preset: string): Promise<ApplyPresetResult> {
    return request<ApplyPresetResult>(
      `/apps/${encodeURIComponent(name)}/presets/${encodeURIComponent(preset)}/apply`,
      { method: 'POST' },
    )
  },

  // --- Wave 5 / Fold 2: dry-run validation + timestamped backups ------------

  /**
   * POST /apps/:app/config/raw/validate { yaml } → validates (parse + schema)
   * and returns the unified diff vs the live config WITHOUT writing anything.
   * (Backend fold-2 dry-run route is `config/raw/validate`.)
   */
  dryRunConfigRaw(name: string, yaml: string): Promise<ConfigDryRunResult> {
    return request<ConfigDryRunResult>(
      `/apps/${encodeURIComponent(name)}/config/raw/validate`,
      { method: 'POST', body: { yaml } },
    )
  },
  /** GET /apps/:app/config/backups → list of config.yaml.bak.<ts> snapshots. */
  listConfigBackups(name: string, signal?: AbortSignal): Promise<ConfigBackup[]> {
    return request<ConfigBackup[]>(
      `/apps/${encodeURIComponent(name)}/config/backups`,
      { signal },
    )
  },
  /** GET /apps/:app/config/backups/:ts → that backup's verbatim YAML. */
  getConfigBackup(name: string, ts: string, signal?: AbortSignal): Promise<RawConfig> {
    return request<RawConfig>(
      `/apps/${encodeURIComponent(name)}/config/backups/${encodeURIComponent(ts)}`,
      { signal },
    )
  },
  /**
   * POST /apps/:app/config/backups/:ts/revert → revert to a backup
   * (writes it as the live config.yaml + hot-reloads). A fresh backup of the
   * current config is taken first, server-side. `ts` is the backup id (the
   * suffix of `config.yaml.bak.<ts>`), not the full filename.
   */
  restoreConfigBackup(name: string, ts: string): Promise<ConfigReloadResult> {
    return request<ConfigReloadResult>(
      `/apps/${encodeURIComponent(name)}/config/backups/${encodeURIComponent(ts)}/revert`,
      { method: 'POST' },
    )
  },

  // --- Wave 4: S3 storage block --------------------------------------------

  /** GET /apps/:app/s3 → config without secrets (key/secret masked). */
  getS3(name: string, signal?: AbortSignal): Promise<S3Config> {
    return request<S3Config>(`/apps/${encodeURIComponent(name)}/s3`, { signal })
  },
  /**
   * PUT /apps/:app/s3 — writes the s3 block to config.yaml (sans key/secret),
   * key/secret to secrets.json, and re-inits the S3 client. Omit key/secret to
   * keep the stored credentials.
   */
  putS3(name: string, payload: UpdateS3Request): Promise<S3Config> {
    return request<S3Config>(`/apps/${encodeURIComponent(name)}/s3`, {
      method: 'PUT',
      body: payload,
    })
  },

  // --- Per-app MQTT event publishing ----------------------------------------

  /** GET /apps/:app/mqtt → config with the broker password masked. */
  getMqtt(name: string, signal?: AbortSignal): Promise<MqttConfig> {
    return request<MqttConfig>(`/apps/${encodeURIComponent(name)}/mqtt`, {
      signal,
    })
  },
  /**
   * PUT /apps/:app/mqtt — writes the mqtt/latency_alert blocks to config.yaml,
   * the password to secrets.json, and reconnects the app's MQTT client. Omit
   * password to keep the stored one.
   */
  putMqtt(name: string, payload: UpdateMqttRequest): Promise<MqttConfig> {
    return request<MqttConfig>(`/apps/${encodeURIComponent(name)}/mqtt`, {
      method: 'PUT',
      body: payload,
    })
  },

  // --- Wave 4: per-app HTML samples ----------------------------------------

  /** GET /apps/:app/samples → list. Tolerates string[] | Sample[] | {files}. */
  async listSamples(name: string, signal?: AbortSignal): Promise<Sample[]> {
    const raw = await request<unknown>(`/apps/${encodeURIComponent(name)}/samples`, {
      signal,
    })
    const arr = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { files?: unknown })?.files)
        ? (raw as { files: unknown[] }).files
        : []
    return arr.map((s) => {
      if (typeof s === 'string') return { file: s } as Sample
      // Backend SampleFileInfo uses { name, sizeBytes, embedUrl, generated };
      // normalize to the frontend Sample shape ({ file, size, url }).
      const o = s as Record<string, unknown>
      return {
        ...o,
        file: (o.file ?? o.name) as string,
        url: (o.url ?? o.embedUrl) as string | undefined,
        size: (o.size ?? o.sizeBytes) as number | undefined,
      } as Sample
    })
  },
  /** GET /apps/:app/samples/:file → raw HTML text. */
  async getSample(name: string, file: string, signal?: AbortSignal): Promise<string> {
    const raw = await request<unknown>(
      `/apps/${encodeURIComponent(name)}/samples/${encodeURIComponent(file)}`,
      { signal },
    )
    if (typeof raw === 'string') return raw
    const content = (raw as { content?: unknown })?.content
    return typeof content === 'string' ? content : ''
  },
  /** PUT /apps/:app/samples/:file { content } — edits only THIS app's sample. */
  putSample(name: string, file: string, content: string): Promise<Sample> {
    return request<Sample>(
      `/apps/${encodeURIComponent(name)}/samples/${encodeURIComponent(file)}`,
      { method: 'PUT', body: { content } },
    )
  },
  /** POST /apps/:app/samples/regenerate — re-render samples from the templates. */
  regenerateSamples(name: string): Promise<RegenerateSamplesResult> {
    return request<RegenerateSamplesResult>(
      `/apps/${encodeURIComponent(name)}/samples/regenerate`,
      { method: 'POST' },
    )
  },

  // --- Wave 4: radio listen token ------------------------------------------

  /**
   * GET /apps/:app/radio/:room/listen-token → subscribe-only audio token + wsUrl
   * for a listener embed (no publish grant).
   */
  radioListenToken(
    name: string,
    room: string,
    signal?: AbortSignal,
  ): Promise<ListenToken> {
    return request<ListenToken>(
      `/apps/${encodeURIComponent(name)}/radio/${encodeURIComponent(room)}/listen-token`,
      { signal },
    )
  },
}

// --- admin ------------------------------------------------------------------

const admin = {
  /** POST /admin/restart — restarts the streamhub-core process (systemd). */
  restart(): Promise<unknown> {
    return request('/admin/restart', { method: 'POST' })
  },
}

// --- ingress ----------------------------------------------------------------

const ingress = {
  /**
   * GET /apps/:app/ingress — PAGINATED ({ data, total, limit, offset }) with
   * room/q filters. total/paging live NEXT TO `data`, so we read the whole
   * body via `plain` and fold it (tolerating the legacy bare-array shape)
   * into an IngressPage.
   */
  async list(
    app: string,
    params: IngressListParams = {},
    signal?: AbortSignal,
  ): Promise<IngressPage> {
    const raw = await request<unknown>(`/apps/${encodeURIComponent(app)}/ingress`, {
      query: toQueryRecord(buildIngressQuery(params)),
      plain: true,
      signal,
    })
    return unwrapPage<Ingress>(raw, params.limit, params.offset)
  },
  get(app: string, id: string, signal?: AbortSignal): Promise<Ingress> {
    return request<Ingress>(
      `/apps/${encodeURIComponent(app)}/ingress/${encodeURIComponent(id)}`,
      { signal },
    )
  },
  create(app: string, payload: CreateIngressRequest): Promise<Ingress> {
    return request<Ingress>(`/apps/${encodeURIComponent(app)}/ingress`, {
      method: 'POST',
      body: payload,
    })
  },
  validate(
    app: string,
    id: string,
    payload: ValidateIngressPasswordRequest,
  ): Promise<unknown> {
    return request(
      `/apps/${encodeURIComponent(app)}/ingress/${encodeURIComponent(id)}/validate`,
      { method: 'POST', body: payload },
    )
  },
  remove(app: string, id: string): Promise<void> {
    return request<void>(
      `/apps/${encodeURIComponent(app)}/ingress/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    )
  },
}

// --- WS ingest (ESP32 direct MJPEG — ESP32-WS-INGEST.md) ---------------------

const wsIngest = {
  /** POST /apps/:app/ws-ingest — mint a wsk_ camera key (+ URLs). */
  create(app: string, payload: CreateWsIngestRequest): Promise<WsIngestKey> {
    return request<WsIngestKey>(`/apps/${encodeURIComponent(app)}/ws-ingest`, {
      method: 'POST',
      body: payload,
    })
  },
  /** GET /apps/:app/ws-ingest — keys + live state (active camera). */
  list(app: string, signal?: AbortSignal): Promise<WsIngestKey[]> {
    return request<WsIngestKey[]>(`/apps/${encodeURIComponent(app)}/ws-ingest`, {
      signal,
    })
  },
  /** DELETE /apps/:app/ws-ingest/:id — revoke (closes the live camera). */
  remove(app: string, id: string): Promise<unknown> {
    return request(
      `/apps/${encodeURIComponent(app)}/ws-ingest/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    )
  },
  /**
   * GET /apps/:app/ws-ingest/live/:room — PUBLIC (no bearer). Whether a
   * ws-mjpeg camera is live in the room; drives the /play + /embed MJPEG mode.
   */
  liveInfo(app: string, room: string, signal?: AbortSignal): Promise<WsIngestLiveInfo> {
    return request<WsIngestLiveInfo>(
      `/apps/${encodeURIComponent(app)}/ws-ingest/live/${encodeURIComponent(room)}`,
      { auth: false, signal },
    )
  },
}

// --- recording / vods -------------------------------------------------------

const recording = {
  start(app: string, payload: StartRecordingRequest): Promise<RecordingHandle> {
    return request<RecordingHandle>(
      `/apps/${encodeURIComponent(app)}/recording/start`,
      { method: 'POST', body: payload },
    )
  },
  stop(app: string, id: string): Promise<unknown> {
    return request(
      `/apps/${encodeURIComponent(app)}/recording/${encodeURIComponent(id)}/stop`,
      { method: 'POST' },
    )
  },
}

const vods = {
  /**
   * GET /apps/:app/vods — filters (room/status/since/until/order/dir/all) +
   * paging. The backend answers { data: Vod[], total, limit, offset } (total &
   * paging live NEXT TO `data`, not inside it), so we read the whole body via
   * `plain` and fold it — plus the legacy bare-array shape — into a VodsPage.
   */
  async list(
    app: string,
    params: VodListParams = {},
    signal?: AbortSignal,
  ): Promise<VodsPage> {
    const raw = await request<unknown>(`/apps/${encodeURIComponent(app)}/vods`, {
      query: toQueryRecord(buildVodsQuery(params)),
      plain: true,
      signal,
    })
    return unwrapPage<Vod>(raw, params.limit, params.offset)
  },
  /** GET /apps/:app/vods/:id — includes a fresh presigned publicUrl. */
  get(app: string, id: number, signal?: AbortSignal): Promise<Vod> {
    return request<Vod>(`/apps/${encodeURIComponent(app)}/vods/${id}`, { signal })
  },
  /**
   * GET /apps/:app/vods/:id/download → a short-lived presigned URL + filename.
   * Throws ApiRequestError(409) when the VOD isn't `ready` yet.
   */
  download(app: string, id: number, signal?: AbortSignal): Promise<VodDownload> {
    return request<VodDownload>(
      `/apps/${encodeURIComponent(app)}/vods/${id}/download`,
      { signal },
    )
  },
  remove(app: string, id: number): Promise<void> {
    return request<void>(`/apps/${encodeURIComponent(app)}/vods/${id}`, {
      method: 'DELETE',
    })
  },
  /**
   * POST /apps/:app/vods/:id/probe — ffprobe the VOD (local file or presigned
   * S3 URL) and backfill duration_s / dimensions for legacy recordings.
   * Returns the updated VOD + `probed` (false when the probe found nothing).
   */
  probe(app: string, id: number): Promise<Vod & { probed: boolean }> {
    return request<Vod & { probed: boolean }>(
      `/apps/${encodeURIComponent(app)}/vods/${id}/probe`,
      { method: 'POST' },
    )
  },
}

/**
 * Fold a paginated response into { items, total, limit, offset }, tolerating:
 *  - a bare array (legacy, no envelope siblings),
 *  - the enveloped page { data: T[], total, limit, offset } (read via `plain`),
 *  - a { items, total } body.
 */
function unwrapPage<T>(
  raw: unknown,
  fallbackLimit?: number,
  fallbackOffset?: number,
): { items: T[]; total?: number; limit?: number; offset?: number } {
  if (Array.isArray(raw)) {
    return { items: raw as T[], total: raw.length, limit: fallbackLimit, offset: fallbackOffset }
  }
  const o = (raw ?? {}) as {
    data?: unknown
    items?: unknown
    total?: number
    limit?: number
    offset?: number
  }
  const items = Array.isArray(o.data)
    ? (o.data as T[])
    : Array.isArray(o.items)
      ? (o.items as T[])
      : []
  return {
    items,
    total: typeof o.total === 'number' ? o.total : undefined,
    limit: o.limit ?? fallbackLimit,
    offset: o.offset ?? fallbackOffset,
  }
}

// --- database maintenance (per-app app.db) ----------------------------------

const db = {
  /** GET /apps/:app/db/health — app.db size + per-table row counts. */
  health(app: string, signal?: AbortSignal): Promise<DbHealth> {
    return request<DbHealth>(`/apps/${encodeURIComponent(app)}/db/health`, { signal })
  },
  /** POST /apps/:app/db/optimize — VACUUM/ANALYZE; returns before/after size. */
  optimize(app: string): Promise<DbOptimizeResult> {
    return request<DbOptimizeResult>(`/apps/${encodeURIComponent(app)}/db/optimize`, {
      method: 'POST',
    })
  },
  /**
   * POST /apps/:app/db/purge { scope, confirm } — destructive wipe of the chosen
   * scope (vods | logs | all). `confirm` MUST be true or the backend rejects it.
   */
  purge(app: string, payload: DbPurgeRequest): Promise<DbPurgeResult> {
    return request<DbPurgeResult>(`/apps/${encodeURIComponent(app)}/db/purge`, {
      method: 'POST',
      body: payload,
    })
  },
}

// --- streams ----------------------------------------------------------------

const streams = {
  list(app: string, signal?: AbortSignal): Promise<Stream[]> {
    return request<Stream[]>(`/apps/${encodeURIComponent(app)}/streams`, { signal })
  },
  get(app: string, id: string, signal?: AbortSignal): Promise<Stream> {
    return request<Stream>(
      `/apps/${encodeURIComponent(app)}/streams/${encodeURIComponent(id)}`,
      { signal },
    )
  },
  stop(app: string, id: string): Promise<void> {
    return request<void>(
      `/apps/${encodeURIComponent(app)}/streams/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    )
  },
  /** POST /apps/:app/streams/:id/data — chat/reaction/raw data. */
  sendData(app: string, id: string, payload: SendDataRequest): Promise<unknown> {
    return request(
      `/apps/${encodeURIComponent(app)}/streams/${encodeURIComponent(id)}/data`,
      { method: 'POST', body: payload },
    )
  },
  /**
   * Start recording an already-running stream (room-composite egress over the
   * stream's room). POST /apps/:app/streams/:id/record/start.
   */
  recordStart(app: string, id: string): Promise<RecordingHandle> {
    return request<RecordingHandle>(
      `/apps/${encodeURIComponent(app)}/streams/${encodeURIComponent(id)}/record/start`,
      { method: 'POST' },
    )
  },
  /** Stop a stream recording. POST /apps/:app/streams/:id/record/stop. */
  recordStop(app: string, id: string): Promise<RecordStopResult> {
    return request<RecordStopResult>(
      `/apps/${encodeURIComponent(app)}/streams/${encodeURIComponent(id)}/record/stop`,
      { method: 'POST' },
    )
  },

  /**
   * Start a live HLS egress (SegmentedFileOutput) over the stream's room.
   * POST /apps/:app/streams/:id/hls/start → { playlistUrl, status, egressId }.
   * Feed `playlistUrl` to <HlsPlayer src> / embeds.
   */
  hlsStart(app: string, id: string): Promise<HlsSession> {
    return request<HlsSession>(
      `/apps/${encodeURIComponent(app)}/streams/${encodeURIComponent(id)}/hls/start`,
      { method: 'POST' },
    )
  },
  /** Stop a stream's HLS egress. POST /apps/:app/streams/:id/hls/stop. */
  hlsStop(app: string, id: string): Promise<HlsStopResult> {
    return request<HlsStopResult>(
      `/apps/${encodeURIComponent(app)}/streams/${encodeURIComponent(id)}/hls/stop`,
      { method: 'POST' },
    )
  },
  /** Current HLS egress status for a stream. GET /apps/:app/streams/:id/hls. */
  hlsStatus(app: string, id: string, signal?: AbortSignal): Promise<HlsStatus> {
    return request<HlsStatus>(
      `/apps/${encodeURIComponent(app)}/streams/${encodeURIComponent(id)}/hls`,
      { signal },
    )
  },
}

// --- restream (multi-destination RTMP forwarding per stream) -----------------

const restream = {
  /** GET /apps/:app/streams/:id/restream — destinations + per-endpoint state. */
  list(app: string, streamId: string, signal?: AbortSignal): Promise<RestreamTarget[]> {
    return request<RestreamTarget[]>(
      `/apps/${encodeURIComponent(app)}/streams/${encodeURIComponent(streamId)}/restream`,
      { signal },
    )
  },
  /**
   * POST /apps/:app/streams/:id/restream — add ONE destination (preset
   * platform + stream key, or custom rtmp(s):// URL). Starts a dedicated
   * LiveKit stream egress towards it; several can run simultaneously.
   */
  add(
    app: string,
    streamId: string,
    payload: AddRestreamRequest,
  ): Promise<RestreamTarget> {
    return request<RestreamTarget>(
      `/apps/${encodeURIComponent(app)}/streams/${encodeURIComponent(streamId)}/restream`,
      { method: 'POST', body: payload },
    )
  },
  /** DELETE /apps/:app/streams/:id/restream/:egressId — stop ONE destination. */
  remove(app: string, streamId: string, egressId: string): Promise<RestreamTarget> {
    return request<RestreamTarget>(
      `/apps/${encodeURIComponent(app)}/streams/${encodeURIComponent(streamId)}/restream/${encodeURIComponent(egressId)}`,
      { method: 'DELETE' },
    )
  },
}

// --- broadcast (room-composite egress -> RTMP) ------------------------------

const broadcast = {
  /**
   * Start a room-composite egress that renders the room and pushes it to
   * `rtmpUrl`. The browser must already be CONNECTED and PUBLISHING to the room
   * before calling this. POST /apps/:app/broadcast/start.
   */
  start(app: string, payload: StartBroadcastRequest): Promise<BroadcastEgress> {
    return request<BroadcastEgress>(
      `/apps/${encodeURIComponent(app)}/broadcast/start`,
      { method: 'POST', body: payload },
    )
  },
  /** Stop an egress. POST /apps/:app/broadcast/:id/stop. */
  stop(app: string, id: string): Promise<StopBroadcastResult> {
    return request<StopBroadcastResult>(
      `/apps/${encodeURIComponent(app)}/broadcast/${encodeURIComponent(id)}/stop`,
      { method: 'POST' },
    )
  },
  /** List active egresses. GET /apps/:app/broadcast. */
  list(app: string, signal?: AbortSignal): Promise<BroadcastEgress[]> {
    return request<BroadcastEgress[]>(`/apps/${encodeURIComponent(app)}/broadcast`, {
      signal,
    })
  },
}

// --- snapshots --------------------------------------------------------------

const snapshots = {
  create(app: string, payload: SnapshotRequest): Promise<SnapshotResult> {
    return request<SnapshotResult>(`/apps/${encodeURIComponent(app)}/snapshots`, {
      method: 'POST',
      body: payload,
    })
  },
}

// --- tokens -----------------------------------------------------------------

const tokens = {
  /** Mint a LiveKit join token for an app room (+ public/iframe URLs). */
  mint(app: string, payload: MintTokenRequest = {}): Promise<MintedToken> {
    return request<MintedToken>(`/apps/${encodeURIComponent(app)}/tokens`, {
      method: 'POST',
      body: payload,
    })
  },
  // global API tokens
  list(signal?: AbortSignal): Promise<TokenSummary[]> {
    return request<TokenSummary[]>('/tokens', { signal })
  },
  create(payload: CreateTokenRequest): Promise<CreatedToken> {
    return request<CreatedToken>('/tokens', { method: 'POST', body: payload })
  },
  revoke(id: number): Promise<void> {
    return request<void>(`/tokens/${id}`, { method: 'DELETE' })
  },
}

// --- logs -------------------------------------------------------------------

const logs = {
  /**
   * GET /logs — global feed. Filters: app, level, source, q, since, until,
   * limit, offset. Newest first. `total`/paging live next to `data`, so we read
   * the whole body via `plain` and fold it (also tolerating the legacy bare
   * array / { items, total } shapes) into a LogsPage.
   */
  async query(params: LogQuery = {}, signal?: AbortSignal): Promise<LogsPage> {
    const raw = await request<unknown>('/logs', {
      query: toQueryRecord(buildLogsQuery(params)),
      plain: true,
      signal,
    })
    return unwrapPage<LogEntry>(raw, params.limit, params.offset)
  },
  /**
   * GET /apps/:app/logs — same shape as the global feed but scoped to one app
   * by path (so `app` in params is ignored). Supports level/source/q + paging.
   */
  async queryApp(
    app: string,
    params: Omit<LogQuery, 'app'> = {},
    signal?: AbortSignal,
  ): Promise<LogsPage> {
    const raw = await request<unknown>(`/apps/${encodeURIComponent(app)}/logs`, {
      query: toQueryRecord(buildLogsQuery(params)),
      plain: true,
      signal,
    })
    return unwrapPage<LogEntry>(raw, params.limit, params.offset)
  },
}

// --- cluster (multi-node registry) ------------------------------------------

const cluster = {
  /** GET /cluster/nodes → every registered node (+ stale flag). */
  nodes(signal?: AbortSignal): Promise<ClusterNode[]> {
    return request<ClusterNode[]>('/cluster/nodes', { signal })
  },
  /** GET /cluster/info → enabled flag, counts, token, redis url, join command. */
  info(signal?: AbortSignal): Promise<ClusterInfo> {
    return request<ClusterInfo>('/cluster/info', { signal })
  },
  /** PATCH /cluster/nodes/:id — edit name / region / status. */
  updateNode(id: string, payload: UpdateNodeRequest): Promise<ClusterNode> {
    return request<ClusterNode>(`/cluster/nodes/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: payload,
    })
  },
  /** DELETE /cluster/nodes/:id — de-register a node. */
  removeNode(id: string): Promise<void> {
    return request<void>(`/cluster/nodes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },
}

// --- network security (/security/* — superadmin) ------------------------------

const security = {
  /** GET /security/status → mode, autoban config and live counts. */
  status(signal?: AbortSignal): Promise<SecurityStatus> {
    return request<SecurityStatus>('/security/status', { signal })
  },
  /** GET /security/ip-rules → the allow/block rule list (newest first). */
  rules(signal?: AbortSignal): Promise<SecurityIpRule[]> {
    return request<SecurityIpRule[]>('/security/ip-rules', { signal })
  },
  /** POST /security/ip-rules — add an allow/block rule (CIDR or bare IP). */
  addRule(payload: {
    cidr: string
    action: 'allow' | 'block'
    note?: string
  }): Promise<SecurityIpRule> {
    return request<SecurityIpRule>('/security/ip-rules', {
      method: 'POST',
      body: payload,
    })
  },
  /** DELETE /security/ip-rules/:id — remove a rule. */
  removeRule(id: number): Promise<{ id: number; deleted: true }> {
    return request<{ id: number; deleted: true }>(`/security/ip-rules/${id}`, {
      method: 'DELETE',
    })
  },
  /** GET /security/bans → { active, recent } auto-bans. */
  bans(signal?: AbortSignal): Promise<{ active: SecurityBan[]; recent: SecurityBan[] }> {
    return request<{ active: SecurityBan[]; recent: SecurityBan[] }>('/security/bans', {
      signal,
    })
  },
  /** POST /security/bans/:ip/unban — lift a ban (clean slate). */
  unban(ip: string): Promise<{ ip: string; unbanned: true }> {
    return request<{ ip: string; unbanned: true }>(
      `/security/bans/${encodeURIComponent(ip)}/unban`,
      { method: 'POST' },
    )
  },
  /** GET /security/offenses → recent offenders (window counts). */
  offenses(signal?: AbortSignal): Promise<SecurityOffender[]> {
    return request<SecurityOffender[]>('/security/offenses', { signal })
  },
}

// --- account / identity (Wave 5 + cuenta y auth) -----------------------------

const account = {
  /**
   * GET /auth/me — the backend's resolved identity for the bearer token
   * (user + tenant memberships + superadmin flag). Source of truth for scoping;
   * the UI also keeps a JWT-derived fallback for offline rendering.
   */
  me(signal?: AbortSignal): Promise<MeResponse> {
    return request<MeResponse>('/auth/me', { signal })
  },
  /** GET /account — my own profile + tenant + security flags. */
  get(signal?: AbortSignal): Promise<AccountInfo> {
    return request<AccountInfo>('/account', { signal })
  },
  /** PATCH /account — update my display name and/or email. */
  update(payload: UpdateAccountRequest): Promise<AccountInfo> {
    return request<AccountInfo>('/account', { method: 'PATCH', body: payload })
  },
  /** POST /account/password — change my password (needs the current one). */
  changePassword(payload: ChangePasswordRequest): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/account/password', {
      method: 'POST',
      body: payload,
    })
  },
  /** POST /account/2fa/setup → { secret, otpauthUri, qrDataUri }. */
  setup2fa(): Promise<TwoFaSetup> {
    return request<TwoFaSetup>('/account/2fa/setup', { method: 'POST' })
  },
  /** POST /account/2fa/enable { code } — activate 2FA. */
  enable2fa(code: string): Promise<{ enabled: boolean }> {
    return request<{ enabled: boolean }>('/account/2fa/enable', {
      method: 'POST',
      body: { code },
    })
  },
  /** POST /account/2fa/disable { code } — turn 2FA off. */
  disable2fa(code: string): Promise<{ enabled: boolean }> {
    return request<{ enabled: boolean }>('/account/2fa/disable', {
      method: 'POST',
      body: { code },
    })
  },
  /** GET /auth/sessions — my active login sessions (ip, dates, `current`). */
  sessions(signal?: AbortSignal): Promise<SessionInfo[]> {
    return request<SessionInfo[]>('/auth/sessions', { signal })
  },
  /**
   * DELETE /auth/sessions/:id — revoke one of my sessions. Revoking the current
   * session signs me out (the response `current` flag says which happened).
   */
  revokeSession(id: string): Promise<{ revoked: boolean; current: boolean }> {
    return request<{ revoked: boolean; current: boolean }>(
      `/auth/sessions/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    )
  },
  /** DELETE /auth/sessions — sign out every OTHER session, keeping this one. */
  revokeOtherSessions(): Promise<{ revoked: number }> {
    return request<{ revoked: number }>('/auth/sessions', { method: 'DELETE' })
  },
}

// --- teams (self-scoped) + invites -------------------------------------------

const teams = {
  /** GET /teams/mine — my tenant + members + quota usage in one call. */
  mine(signal?: AbortSignal): Promise<MyTeam> {
    return request<MyTeam>('/teams/mine', { signal })
  },
}

const invites = {
  /** GET /tenant/invites — pending invitations of MY tenant (owner only). */
  list(signal?: AbortSignal): Promise<PendingInvite[]> {
    return request<PendingInvite[]>('/tenant/invites', { signal })
  },
  /** POST /tenant/invites { email, role } — invite by email (owner only). */
  create(payload: InviteMemberRequest): Promise<InviteResult> {
    return request<InviteResult>('/tenant/invites', {
      method: 'POST',
      body: payload,
    })
  },
  /** DELETE /tenant/invites/:userId — revoke a pending invitation. */
  revoke(userId: string): Promise<void> {
    return request<void>(`/tenant/invites/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    })
  },
}

// --- tenants / members / quotas (Wave 5) ------------------------------------

const tenants = {
  /** GET /tenants — superadmin: every tenant. Others: their own. */
  list(signal?: AbortSignal): Promise<Tenant[]> {
    return request<Tenant[]>('/tenants', { signal })
  },
  get(id: string, signal?: AbortSignal): Promise<Tenant> {
    return request<Tenant>(`/tenants/${encodeURIComponent(id)}`, { signal })
  },
  /** GET /tenants/:id/usage — apps / streams / rec minutes / egress / storage. */
  usage(id: string, signal?: AbortSignal): Promise<TenantUsage> {
    return request<TenantUsage>(`/tenants/${encodeURIComponent(id)}/usage`, { signal })
  },

  // members
  members(id: string, signal?: AbortSignal): Promise<Member[]> {
    return request<Member[]>(`/tenants/${encodeURIComponent(id)}/members`, { signal })
  },
  /** POST /tenants/:id/members — invite by email (Logto sends the invite). */
  invite(id: string, payload: InviteMemberRequest): Promise<Member> {
    return request<Member>(`/tenants/${encodeURIComponent(id)}/members`, {
      method: 'POST',
      body: payload,
    })
  },
  /** PATCH /tenants/:id/members/:userId — change a member's role. */
  setMemberRole(
    id: string,
    userId: string,
    payload: UpdateMemberRequest,
  ): Promise<Member> {
    return request<Member>(
      `/tenants/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
      { method: 'PATCH', body: payload },
    )
  },
  removeMember(id: string, userId: string): Promise<void> {
    return request<void>(
      `/tenants/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    )
  },

  /** PATCH /tenants/:id/quotas — superadmin: raise plan/limits. */
  updateQuotas(id: string, payload: UpdateQuotasRequest): Promise<Tenant> {
    return request<Tenant>(`/tenants/${encodeURIComponent(id)}/quotas`, {
      method: 'PATCH',
      body: payload,
    })
  },
}

// --- public play token ------------------------------------------------------

/**
 * GET /apps/:app/play-token/:room — PUBLIC, no bearer. Returns a subscribe-only
 * LiveKit token + wsUrl for the public /play and /embed player surfaces. Used
 * by <LivePlayer access="public"> so anonymous viewers can watch without login.
 */
function playToken(app: string, room: string, signal?: AbortSignal): Promise<PlayToken> {
  return request<PlayToken>(
    `/apps/${encodeURIComponent(app)}/play-token/${encodeURIComponent(room)}`,
    { auth: false, signal },
  )
}

// --- aggregate --------------------------------------------------------------

export const api = {
  playToken,
  auth,
  account,
  teams,
  invites,
  tenants,
  system,
  admin,
  apps,
  ingress,
  wsIngest,
  broadcast,
  restream,
  recording,
  vods,
  db,
  streams,
  snapshots,
  tokens,
  logs,
  cluster,
  security,
}

export type StreamHubApi = typeof api
