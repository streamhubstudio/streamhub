/**
 * Read-only "Server settings" contract (#16).
 *
 * The effective configuration of THIS core, with EVERY secret redacted: the
 * panel shows what is configured (and gives copy-paste guidance to change it)
 * but the API never returns a JWT/API/admin/cluster/SMTP secret or a Redis
 * password in the clear — only `…Set` booleans, masks and host:port endpoints.
 * `authzEnforce` is a MODE (not a secret) so it is shown verbatim.
 */

/** How the permission enforcement switch is set (security-relevant, not secret). */
export type AuthzEnforce = 'off' | 'log' | 'on';

/** Core process / networking config (no secrets). */
export interface CoreSettings {
  nodeEnv: string;
  port: number;
  host: string;
  publicBaseUrl: string;
  publicWsUrl: string;
  rtmpPublicHost: string;
  logLevel: string;
  logRetentionDays: number;
  /** STREAMHUB_AUTHZ_ENFORCE — visible on purpose (a security mode, not a secret). */
  authzEnforce: AuthzEnforce;
  /** Redis endpoint as `host:port` — any password is stripped. */
  redisUrl: string;
  dataDir: string;
}

/** Auth / identity config — credentials appear only as `…Set` booleans. */
export interface AuthSettings {
  /** Break-glass UI login user (a username, not a secret). */
  adminUser: string;
  jwtSecretSet: boolean;
  adminPassSet: boolean;
  smtpConfigured: boolean;
  superadminEmail: string;
}

/** LiveKit wiring — the API secret is NEVER returned; the key is masked. */
export interface LivekitSettings {
  url: string;
  apiKeySet: boolean;
  /** First 6 chars of the API key + ellipsis (empty when unset). */
  apiKeyMasked: string;
}

/** Cluster wiring — the shared token appears only as an `enabled` boolean. */
export interface ClusterSettings {
  enabled: boolean;
  redisConfigured: boolean;
  nodesCount: number;
}

/** Prometheus scrape token — only whether it is set. */
export interface MetricsSettings {
  tokenSet: boolean;
}

/** On-disk footprint (global registry DB + app count). */
export interface StorageSettings {
  dataDir: string;
  dbSizeBytes: number;
  appsCount: number;
}

/** Build versions. */
export interface VersionsSettings {
  core: string;
  node: string;
}

/** Live process snapshot. */
export interface RuntimeSettings {
  uptimeSeconds: number;
  pid: number;
  platform: string;
  memoryRssBytes: number;
}

/** Well-known ports (config-derived where possible, else the fixed defaults). */
export interface PortsSettings {
  core: number;
  livekitSignaling: number;
  livekitTcp: number;
  livekitUdp: number;
  rtmp: number;
  whip: number;
}

/** One operator hint: what a setting is, its env var, and how to change it. */
export interface SettingGuidance {
  setting: string;
  envVar: string;
  howToChange: string;
}

/** Guidance keyed by group id (core/auth/livekit/cluster/metrics/storage). */
export type SettingsGuidance = Record<string, SettingGuidance[]>;

/** The full read-only server-settings payload (returned under `{ data }`). */
export interface ServerSettings {
  core: CoreSettings;
  auth: AuthSettings;
  livekit: LivekitSettings;
  cluster: ClusterSettings;
  metrics: MetricsSettings;
  storage: StorageSettings;
  versions: VersionsSettings;
  runtime: RuntimeSettings;
  ports: PortsSettings;
  /** Per-group operator guidance (read-only — the panel never writes). */
  guidance: SettingsGuidance;
}
