import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

import { AuthContext, PLATFORM_TENANT_ID } from '../../shared/auth-context';
import { ConfigService } from '../../shared/config/config.service';
import { DbService } from '../../shared/db/db.service';
import {
  AppConfig,
  AppRecord,
  AppsServiceContract,
  CreateAppInput,
  DeleteAppOptions,
  LatencyAlertConfig,
  LogLevel,
  MQTT_SERVICE,
  MqttConfig,
  MqttQos,
  MqttServiceContract,
  S3Config,
  SAMPLES_SERVICE,
  SamplesServiceContract,
  TranscodingEncoding,
  VodRendition,
  WebrtcLayer,
} from '../../shared/contracts';
import { S3Service } from '../s3/s3.service';
import { SecretsStore } from '../s3/secrets.store';
import { renderSamplePages } from './sample-pages';
import { CONFIG_PRESETS, applyPresetPatch, findPreset } from './config-presets';

/** Input for the S3 config setter (wave-4 §2). */
export interface SetS3Input {
  provider?: S3Config['provider'];
  bucket?: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  prefix?: string;
  public_url?: string;
  /** Access key — persisted to secrets.json, never the yaml. */
  key?: string;
  /** Secret key — persisted to secrets.json, never the yaml. */
  secret?: string;
  /**
   * Fold-3: explicit confirmation required to ENABLE a non-empty `public_url`
   * (turning recordings public). Not needed to keep/clear it.
   */
  confirmPublic?: boolean;
}

/** Result of a hot-reload (wave-4 §1). */
export interface ReloadResult {
  reloaded: boolean;
  warnings: string[];
}

/** G4 config-preset summary (GET /apps/:app/presets). */
export interface ConfigPresetInfo {
  name: string;
  title: string;
  description: string;
  useCase: string;
  sets: string[];
}

/** Result of applying a config preset (G4). */
export interface ApplyPresetResult {
  preset: string;
  applied: boolean;
  reloaded: boolean;
  /** Whether the merged config differs from the current one. */
  changed: boolean;
  /** Unified-style diff current → preset-applied config. */
  diff: string;
  warnings: string[];
}

/** A single timestamped config backup (wave-5 fold-2). */
export interface ConfigBackup {
  /** Backup filename, e.g. `config.yaml.bak.20260630T184500123Z`. */
  file: string;
  /** The `<ts>` token used in revert calls. */
  ts: string;
  sizeBytes: number;
  createdAt: string;
}

/** Dry-run validation result (wave-5 fold-2) — validates + diffs, never writes. */
export interface ConfigDryRun {
  valid: boolean;
  warnings: string[];
  /** Validation error message when `valid` is false (no exception thrown). */
  error: string | null;
  /** Unified-style line diff of current → proposed config. */
  diff: string;
  changed: boolean;
}

/** Masked S3 view (wave-4 §2) — credentials never returned in clear. */
export interface MaskedS3 {
  provider: S3Config['provider'];
  bucket: string;
  region: string;
  endpoint: string;
  forcePathStyle: boolean;
  prefix: string;
  public_url: string;
  accessKeyEnv: string;
  secretKeyEnv: string;
  /** Masked access key (display only). Contract field consumed by the UI. */
  key: string;
  /** Masked secret (display only). Contract field consumed by the UI. */
  secret: string;
  /** Whether real credentials exist in secrets.json. */
  configured: boolean;
  keyMasked: string;
  secretMasked: string;
  hasKey: boolean;
  hasSecret: boolean;
  /**
   * Fold-3: when true a non-empty `public_url` is set, so VOD URLs are built as
   * `<public_url>/<key>` and recordings are publicly reachable (not presigned).
   */
  publicVods: boolean;
  /** Human warning surfaced by the UI when `publicVods` is true; null otherwise. */
  publicWarning: string | null;
}

/** Masked MQTT view — the broker password is never returned in clear. */
export interface MaskedMqtt {
  enabled: boolean;
  url: string;
  username: string;
  topicPrefix: string;
  qos: MqttQos;
  tls: boolean;
  events: string[];
  logs: { enabled: boolean; level: LogLevel };
  /** Ref (env var name / secrets.json key) holding the password. */
  passwordEnv: string;
  /** Masked password (display only). */
  password: string;
  hasPassword: boolean;
  /** Whether the block is usable (enabled + URL set). */
  configured: boolean;
  latencyAlert: LatencyAlertConfig;
}

/** Input for the MQTT config setter (PUT /apps/:app/mqtt). */
export interface SetMqttInput {
  enabled?: boolean;
  url?: string;
  username?: string;
  /** Broker password — persisted to secrets.json, never the yaml. */
  password?: string;
  topicPrefix?: string;
  qos?: number;
  tls?: boolean;
  events?: string[];
  logs?: { enabled?: boolean; level?: string };
  latencyAlert?: {
    enabled?: boolean;
    thresholdMs?: number;
    cooldownSeconds?: number;
    intervalSeconds?: number;
  };
}

const MQTT_LOG_LEVELS: ReadonlySet<string> = new Set([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
]);

/** Fold-3 warning text shown whenever public_url is enabled. */
const PUBLIC_VODS_WARNING =
  'VODs públicos: con public_url activo las grabaciones quedan accesibles ' +
  'sin firma. Preferí una URL firmada de CDN sobre un bucket abierto.';

/** On-disk (YAML) shape of an app's config.yaml — snake_case + secret refs (SPEC §7). */
interface DiskS3Config {
  provider: S3Config['provider'];
  bucket: string;
  region: string;
  endpoint: string;
  force_path_style: boolean;
  prefix: string;
  /** Public/CDN base URL for objects (wave-4 §2). Empty = use presigned URLs. */
  public_url: string;
  /** Env var name holding the access key (value never stored in the yaml). */
  access_key_env: string;
  /** Env var name holding the secret key. */
  secret_key_env: string;
}

interface DiskConfig {
  name: string;
  display_name: string;
  room_prefix: string;
  recording: {
    enabled: boolean;
    mode: AppConfig['recording']['mode'];
    layout: string;
    local_dir: string;
    delete_local_after_upload: boolean;
    /** Wave-3 §3: split into N-minute parts (0 = continuous). */
    split_minutes: number;
    /** Wave-3 §3: snapshot every N seconds (0 = off). */
    snapshot_seconds: number;
  };
  s3: DiskS3Config;
  webrtc: {
    adaptive: boolean;
    layers: WebrtcLayer[];
  };
  rtmp: {
    enabled: boolean;
    transcode: boolean;
  };
  /**
   * Server-side transcoding (master switch + recording/VOD outputs). Optional
   * on disk: configs that predate the block fall back to the legacy behaviour
   * (`enabled` := `rtmp.transcode`) so existing apps don't silently change.
   */
  transcoding: {
    /** Master switch. NEW apps default to `false` (passthrough). */
    enabled: boolean;
    /** Recording output target: `h264` (default) | `h264+vp8`. */
    encoding: string;
    /** Generate an adaptive HLS VOD (master + renditions) per recording. */
    vod_adaptive: boolean;
    /** Explicit ladder; empty = derived from `webrtc.layers`. */
    vod_renditions: { height: number; bitrate_kbps: number }[];
  };
  callbacks: {
    url: string;
    secret: string;
  };
  /**
   * Per-app MQTT event publishing. `password_env` is a REF (like the s3
   * `*_env` fields) — the real password lives in env / data/secrets.json.
   */
  mqtt: {
    enabled: boolean;
    url: string;
    username: string;
    /** Env var / secrets.json key holding the broker password. */
    password_env: string;
    topic_prefix: string;
    qos: number;
    tls: boolean;
    /** ['all'] or an explicit list of event names. */
    events: string[];
    logs: { enabled: boolean; level: string };
  };
  /** Per-app stream latency alerting (emits stream.latency_high/_recovered). */
  latency_alert: {
    enabled: boolean;
    threshold_ms: number;
    cooldown_seconds: number;
    interval_seconds: number;
  };
  /** Wave-2 feature flags (SPEC §16), snake_case on disk. */
  features: DiskFeatures;
}

/** On-disk (YAML) shape of the per-app `features:` block (SPEC §16). */
interface DiskFeatures {
  rtmp_password: boolean;
  viewer_counter: boolean;
  chat: boolean;
  reactions: boolean;
  hidden_qc: boolean;
  adaptive_player: boolean;
  public_playback?: boolean;
  /** Direct WS MJPEG ingest (ESP32-CAM). Absent → defaults (enabled). */
  ws_ingest?: {
    enabled?: boolean;
    max_cameras?: number;
    max_fps?: number;
    max_frame_kb?: number;
  };
}

interface AppRow {
  id: number;
  name: string;
  display_name: string | null;
  livekit_room_prefix: string | null;
  created_at: string;
  updated_at: string;
  settings_json: string | null;
}

/**
 * App registry + filesystem/config/samples lifecycle (SPEC §3, §5 apps, §6).
 *
 * The global `apps` row is the identity/routing POINTER only (name + tenant_id
 * + node_id + created_at, with legacy config columns kept for back-compat);
 * all app-scoped state lives in the per-app apps/<name>/app.db reached via
 * `DbService.appDb(name)`.
 *
 * Creating an app: inserts the `apps` pointer row, scaffolds
 * `apps/<name>/{config.yaml, app.db, recordings/, snapshots/, samples/}` and
 * renders the publish/play/embed sample pages with the public URL.
 *
 * S3 credentials are NEVER written to config.yaml: the yaml carries `*_env`
 * refs and the resolved values live in env or `data/secrets.json` (chmod 600).
 */
@Injectable()
export class AppsService implements AppsServiceContract, OnModuleInit {
  private readonly logger = new Logger(AppsService.name);
  private static readonly DEFAULT_APP = 'live';

  constructor(
    private readonly config: ConfigService,
    private readonly db: DbService,
    private readonly s3: S3Service,
    private readonly secrets: SecretsStore,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Seed the default `live` app on boot (SPEC §2). Never crashes the process. */
  async onModuleInit(): Promise<void> {
    try {
      const existing = await this.get(AppsService.DEFAULT_APP);
      if (!existing) {
        await this.create({ name: AppsService.DEFAULT_APP, displayName: 'Live' });
        this.logger.log(`seeded default app "${AppsService.DEFAULT_APP}"`);
      }
    } catch (err) {
      this.logger.error(
        `failed seeding default app: ${(err as Error).message}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Registry
  // ---------------------------------------------------------------------------

  /**
   * List apps, scoped to the caller's tenant.
   *
   * Multi-tenant isolation: a normal dashboard user (`scope:'user'`) only sees
   * apps owned by their own tenant. Superadmin / global `sk_` credentials (and
   * internal callers that pass no ctx) see EVERY app — that's the admin view.
   * Defensive about the tenancy schema like {@link AuthzService.appBelongsToTenant}:
   * if the `apps.tenant_id` column is somehow absent (pre-migration), fall back
   * to the full list rather than hiding everything.
   */
  async list(ctx?: AuthContext): Promise<AppRecord[]> {
    const g = this.db.global();
    const fullView =
      !ctx ||
      ctx.isSuperadmin ||
      ctx.scope === 'global' ||
      !this.appsHasTenantColumn();
    const rows = (
      fullView
        ? g.prepare('SELECT * FROM apps ORDER BY name ASC').all()
        : g
            .prepare('SELECT * FROM apps WHERE tenant_id = ? ORDER BY name ASC')
            .all(ctx!.tenantId ?? PLATFORM_TENANT_ID)
    ) as AppRow[];
    return rows.map((r) => this.toRecord(r));
  }

  async get(name: string): Promise<AppRecord | null> {
    const row = this.db
      .global()
      .prepare('SELECT * FROM apps WHERE name = ?')
      .get(name) as AppRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  async create(input: CreateAppInput): Promise<AppRecord> {
    const name = (input.name || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(name)) {
      throw new ConflictException(
        'invalid app name (lowercase slug a-z, 0-9, hyphen; 3-32 chars)',
      );
    }
    if (await this.get(name)) {
      throw new ConflictException(`app "${name}" already exists`);
    }

    const displayName = input.displayName?.trim() || name;
    const roomPrefix = (input.roomPrefix?.trim() || name).toLowerCase();
    const dir = this.appDir(name);
    let dirCreated = false;
    let rowId: number | undefined;

    try {
      // 1) filesystem scaffold
      fs.mkdirSync(path.join(dir, 'recordings'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'samples'), { recursive: true });
      dirCreated = true;

      // 2) config.yaml (with secret refs, never raw credentials)
      const disk = this.defaultDiskConfig(name, displayName, roomPrefix);
      this.applyResolvedPatch(disk, input.config);
      this.writeDiskConfig(name, disk);

      // 3) registry row — stamp the OWNING tenant so the apps list scopes per
      //    tenant (a normal user sees only their own apps; superadmin sees all).
      //    Superadmin/internal creates land in the platform tenant.
      const tenantId = input.tenantId ?? PLATFORM_TENANT_ID;
      const info = this.appsHasTenantColumn()
        ? this.db
            .global()
            .prepare(
              `INSERT INTO apps (name, display_name, livekit_room_prefix, tenant_id)
               VALUES (?, ?, ?, ?)`,
            )
            .run(name, displayName, roomPrefix, tenantId)
        : this.db
            .global()
            .prepare(
              `INSERT INTO apps (name, display_name, livekit_room_prefix)
               VALUES (?, ?, ?)`,
            )
            .run(name, displayName, roomPrefix);
      rowId = Number(info.lastInsertRowid);

      // 4) per-app app.db (created + migrated on first open; consolidates the
      //    legacy per-app vods.db). Canonical accessor is appDb(name).
      this.db.appDb(name);

      // 5) sample pages with public URL (legacy publish/play/embed)
      this.writeSamplePages(name, roomPrefix);

      // 5b) wave-4 §3 sample set (webrtc/hls/audio-radio), wired to this app.
      // Best-effort: a samples failure must never abort app creation.
      await this.generateSamples(name);

      const record = await this.get(name);
      if (!record) {
        throw new InternalServerErrorException('app row missing after insert');
      }
      this.logger.log(`created app "${name}"`);
      return record;
    } catch (err) {
      // best-effort rollback so a partial create never leaves junk behind
      try {
        if (rowId !== undefined) {
          this.db.closeApp(name);
          this.db.global().prepare('DELETE FROM apps WHERE id = ?').run(rowId);
        }
        if (dirCreated) fs.rmSync(dir, { recursive: true, force: true });
      } catch (cleanupErr) {
        this.logger.error(
          `rollback of failed create("${name}") incomplete: ${(cleanupErr as Error).message}`,
        );
      }
      if (err instanceof ConflictException) throw err;
      throw new InternalServerErrorException(
        `failed creating app "${name}": ${(err as Error).message}`,
      );
    }
  }

  async delete(name: string, options?: DeleteAppOptions): Promise<void> {
    const record = await this.get(name);
    if (!record) throw new NotFoundException(`app "${name}" not found`);

    // Close the app's MQTT client (if any) before tearing anything down.
    this.disconnectMqtt(name);

    // Release the per-app DB handle before any filesystem removal.
    this.db.closeApp(name);

    // Remove the registry row (cascades api_tokens via FK).
    this.db.global().prepare('DELETE FROM apps WHERE id = ?').run(record.id);

    if (options?.deleteVods) {
      // Purge local VODs/recordings/db. S3 object purge is delegated to the
      // recording/s3 modules (they own the per-VOD keys + credentials).
      try {
        fs.rmSync(this.appDir(name), { recursive: true, force: true });
      } catch (err) {
        this.logger.error(
          `delete("${name}", deleteVods): fs cleanup failed: ${(err as Error).message}`,
        );
      }
      this.logger.warn(
        `deleted app "${name}" with VODs; S3 objects (if any) must be purged by the s3/recording module`,
      );
    } else {
      this.logger.log(`deleted app "${name}" (VODs preserved on disk)`);
    }
  }

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  async getConfig(name: string): Promise<AppConfig> {
    if (!(await this.get(name))) {
      throw new NotFoundException(`app "${name}" not found`);
    }
    const disk = this.readDiskConfig(name);
    return this.toResolvedConfig(disk);
  }

  async updateConfig(name: string, patch: Partial<AppConfig>): Promise<AppConfig> {
    const record = await this.get(name);
    if (!record) throw new NotFoundException(`app "${name}" not found`);

    const disk = this.readDiskConfig(name);
    this.applyResolvedPatch(disk, patch);
    this.writeDiskConfig(name, disk);

    // Keep the registry row in sync with display_name / room_prefix changes.
    if (patch.displayName !== undefined || patch.roomPrefix !== undefined) {
      this.db
        .global()
        .prepare(
          `UPDATE apps
             SET display_name = ?, livekit_room_prefix = ?, updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(disk.display_name, disk.room_prefix, record.id);
    } else {
      this.db
        .global()
        .prepare(`UPDATE apps SET updated_at = datetime('now') WHERE id = ?`)
        .run(record.id);
    }

    return this.toResolvedConfig(disk);
  }

  /** apps/<name>/ absolute path. Stable convention used across modules. */
  appDir(name: string): string {
    return path.join(this.config.dataDir, 'apps', name);
  }

  // ---------------------------------------------------------------------------
  // Wave-4 §1 — raw config editor + hot-reload
  // ---------------------------------------------------------------------------

  /** Raw, unparsed contents of apps/<name>/config.yaml. */
  async getRawConfig(name: string): Promise<string> {
    if (!(await this.get(name))) {
      throw new NotFoundException(`app "${name}" not found`);
    }
    try {
      return fs.readFileSync(this.configPath(name), 'utf8');
    } catch {
      throw new NotFoundException(`config.yaml missing for app "${name}"`);
    }
  }

  /**
   * Validate + persist a raw YAML config, then hot-reload (wave-4 §1). On a
   * parse / shape error the file is NOT written and a 400 is thrown. Secrets are
   * never expected in the raw yaml (refs only) — any inline `key`/`secret` are
   * ignored by the parser.
   */
  async putRawConfig(name: string, rawYaml: string): Promise<ReloadResult> {
    if (!(await this.get(name))) {
      throw new NotFoundException(`app "${name}" not found`);
    }
    const { warnings } = this.validateRawConfig(name, rawYaml);

    // Fold-2: timestamped backup of the CURRENT config before overwriting.
    const backupWarnings = this.backupCurrentConfig(name);

    // Atomic write so a crash mid-write can't truncate the live config.
    const file = this.configPath(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, rawYaml, { encoding: 'utf8', mode: 0o644 });
    fs.renameSync(tmp, file);

    const reload = await this.reload(name);
    return {
      reloaded: reload.reloaded,
      warnings: [...warnings, ...backupWarnings, ...reload.warnings],
    };
  }

  // ---------------------------------------------------------------------------
  // Wave-5 fold-2 — safe config editor: dry-run, backups, revert
  // ---------------------------------------------------------------------------

  /**
   * Validate a proposed raw config and return the diff vs the current one,
   * WITHOUT writing anything. Never throws on a validation error — the error is
   * reported in `error`/`valid` so the UI can show it inline.
   */
  async dryRunRawConfig(name: string, rawYaml: string): Promise<ConfigDryRun> {
    if (!(await this.get(name))) {
      throw new NotFoundException(`app "${name}" not found`);
    }
    let valid = true;
    let error: string | null = null;
    let warnings: string[] = [];
    try {
      warnings = this.validateRawConfig(name, rawYaml).warnings;
    } catch (err) {
      valid = false;
      error = (err as Error).message;
    }
    let current = '';
    try {
      current = fs.readFileSync(this.configPath(name), 'utf8');
    } catch {
      current = '';
    }
    const diff = this.unifiedDiff(current, rawYaml);
    return { valid, warnings, error, diff, changed: diff.length > 0 };
  }

  /** List the timestamped backups for an app (newest first). */
  async listConfigBackups(name: string): Promise<ConfigBackup[]> {
    if (!(await this.get(name))) {
      throw new NotFoundException(`app "${name}" not found`);
    }
    const dir = this.appDir(name);
    const prefix = 'config.yaml.bak.';
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix));
    } catch {
      files = [];
    }
    const out: ConfigBackup[] = [];
    for (const file of files) {
      try {
        const st = fs.statSync(path.join(dir, file));
        out.push({
          file,
          ts: file.slice(prefix.length),
          sizeBytes: st.size,
          createdAt: st.mtime.toISOString(),
        });
      } catch {
        /* skip unreadable entry */
      }
    }
    out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return out;
  }

  /** Read a single backup's verbatim YAML by its `<ts>` id (fold-2 preview). */
  async readConfigBackup(name: string, ts: string): Promise<string> {
    if (!(await this.get(name))) {
      throw new NotFoundException(`app "${name}" not found`);
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(ts)) {
      throw new BadRequestException('invalid backup id');
    }
    const backupFile = path.join(this.appDir(name), `config.yaml.bak.${ts}`);
    try {
      return fs.readFileSync(backupFile, 'utf8');
    } catch {
      throw new NotFoundException(`backup "${ts}" not found for app "${name}"`);
    }
  }

  /**
   * Restore a backup as the live config.yaml, then hot-reload. The current
   * config is itself backed up first (so a revert is reversible).
   */
  async revertConfigBackup(name: string, ts: string): Promise<ReloadResult> {
    if (!(await this.get(name))) {
      throw new NotFoundException(`app "${name}" not found`);
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(ts)) {
      throw new BadRequestException('invalid backup id');
    }
    const dir = this.appDir(name);
    const backupFile = path.join(dir, `config.yaml.bak.${ts}`);
    let content: string;
    try {
      content = fs.readFileSync(backupFile, 'utf8');
    } catch {
      throw new NotFoundException(`backup "${ts}" not found for app "${name}"`);
    }
    // Validate the backup still parses before promoting it.
    const { warnings } = this.validateRawConfig(name, content);
    const backupWarnings = this.backupCurrentConfig(name);

    const file = this.configPath(name);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o644 });
    fs.renameSync(tmp, file);

    const reload = await this.reload(name);
    return {
      reloaded: reload.reloaded,
      warnings: [...warnings, ...backupWarnings, ...reload.warnings],
    };
  }

  /** Copy the current config.yaml to config.yaml.bak.<ts>; prune to last 20. */
  private backupCurrentConfig(name: string): string[] {
    const file = this.configPath(name);
    if (!fs.existsSync(file)) return [];
    // e.g. 2026-06-30T18:45:00.123Z → 20260630T184500123Z
    const stamp = new Date().toISOString().replace(/[-:.]/g, '');
    const dest = `${file}.bak.${stamp}`;
    try {
      fs.copyFileSync(file, dest);
    } catch (err) {
      return [`config backup failed: ${(err as Error).message}`];
    }
    // Prune: keep only the 20 newest backups.
    try {
      const dir = this.appDir(name);
      const prefix = 'config.yaml.bak.';
      const backups = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(prefix))
        .sort();
      const excess = backups.length - 20;
      for (let i = 0; i < excess; i++) {
        fs.rmSync(path.join(dir, backups[i]), { force: true });
      }
    } catch {
      /* pruning is best-effort */
    }
    return [];
  }

  /** Minimal LCS-based unified-style line diff (no external deps). */
  private unifiedDiff(before: string, after: string): string {
    const a = before.length ? before.split('\n') : [];
    const b = after.length ? after.split('\n') : [];
    const n = a.length;
    const m = b.length;
    // LCS length table.
    const lcs: number[][] = Array.from({ length: n + 1 }, () =>
      new Array<number>(m + 1).fill(0),
    );
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] =
          a[i] === b[j]
            ? lcs[i + 1][j + 1] + 1
            : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    const lines: string[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        lines.push(`  ${a[i]}`);
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        lines.push(`- ${a[i]}`);
        i++;
      } else {
        lines.push(`+ ${b[j]}`);
        j++;
      }
    }
    while (i < n) lines.push(`- ${a[i++]}`);
    while (j < m) lines.push(`+ ${b[j++]}`);
    // Only emit a diff when something actually changed.
    return lines.some((l) => l.startsWith('+ ') || l.startsWith('- '))
      ? lines.join('\n')
      : '';
  }

  /**
   * Hot-reload an app WITHOUT restarting the process (wave-4 §1):
   *  - re-reads config.yaml and re-syncs the in-memory registry row
   *    (display_name / room_prefix) so other modules see the new values,
   *  - invalidates the secrets cache + evicts the app's cached S3 client so the
   *    next S3 op rebuilds it from the new credentials/endpoint.
   * Never cuts existing LiveKit streams (no LiveKit restart involved).
   */
  async reload(name: string): Promise<ReloadResult> {
    const record = await this.get(name);
    if (!record) throw new NotFoundException(`app "${name}" not found`);
    const warnings: string[] = [];

    let disk: DiskConfig;
    try {
      disk = this.readDiskConfig(name);
    } catch (err) {
      warnings.push(`config re-read failed: ${(err as Error).message}`);
      return { reloaded: false, warnings };
    }

    // Re-sync registry row from the (possibly edited) yaml.
    try {
      this.db
        .global()
        .prepare(
          `UPDATE apps
             SET display_name = ?, livekit_room_prefix = ?, updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(disk.display_name, disk.room_prefix, record.id);
    } catch (err) {
      warnings.push(`registry sync failed: ${(err as Error).message}`);
    }

    // Re-initialize the S3 client for this app: drop the cached client + cached
    // secrets so the next resolve picks up fresh credentials/endpoint.
    try {
      this.secrets.invalidate();
      // Clear cached S3 clients so the next op rebuilds from fresh creds. A
      // credential change yields a new client fingerprint, so a full evict is
      // the reliable re-init (stale clients would otherwise linger unused).
      this.s3.evict();
    } catch (err) {
      warnings.push(`s3 client re-init failed: ${(err as Error).message}`);
    }

    // Drop the app's MQTT client so the next publish reconnects with the
    // (possibly changed) broker settings. Best-effort.
    this.disconnectMqtt(name);

    this.logger.log(`hot-reloaded app "${name}"`);
    return { reloaded: true, warnings };
  }

  // ---------------------------------------------------------------------------
  // G4 — config presets (declarative delivery/quality profiles)
  // ---------------------------------------------------------------------------

  /** List the built-in config presets (metadata only). */
  async listConfigPresets(name: string): Promise<ConfigPresetInfo[]> {
    if (!(await this.get(name))) {
      throw new NotFoundException(`app "${name}" not found`);
    }
    return CONFIG_PRESETS.map((p) => ({
      name: p.name,
      title: p.title,
      description: p.description,
      useCase: p.useCase,
      sets: p.sets,
    }));
  }

  /**
   * Apply a config preset: deep-merge its (credential-safe) patch over the app's
   * current config.yaml, then validate + backup + write + hot-reload (reusing the
   * raw-config machinery). Returns the unified diff of the change. NEVER touches
   * s3 credentials / callbacks secret / app identity — those keys are stripped
   * from the patch before merging (config-presets.PRESET_PROTECTED_KEYS).
   */
  async applyConfigPreset(
    name: string,
    presetName: string,
  ): Promise<ApplyPresetResult> {
    if (!(await this.get(name))) {
      throw new NotFoundException(`app "${name}" not found`);
    }
    const preset = findPreset(presetName);
    if (!preset) {
      throw new NotFoundException(`preset "${presetName}" not found`);
    }

    const currentRaw = await this.getRawConfig(name);
    let parsed: unknown;
    try {
      parsed = yaml.load(currentRaw);
    } catch (err) {
      throw new BadRequestException(
        `current config.yaml is not parseable; fix it before applying a preset: ${(err as Error).message}`,
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BadRequestException('current config.yaml is not a YAML mapping');
    }

    const merged = applyPresetPatch(
      parsed as Record<string, unknown>,
      preset.patch,
    );
    const mergedYaml = yaml.dump(merged, { lineWidth: 120 });
    const diff = this.unifiedDiff(currentRaw, mergedYaml);

    // Reuse the safe editor path: validates (parse+shape), backs up the current
    // config, atomic-writes the new one, and hot-reloads in place.
    const reload = await this.putRawConfig(name, mergedYaml);

    this.logger.log(`applied preset "${preset.name}" to app "${name}"`);
    return {
      preset: preset.name,
      applied: true,
      reloaded: reload.reloaded,
      changed: diff.length > 0,
      diff,
      warnings: reload.warnings,
    };
  }

  // ---------------------------------------------------------------------------
  // Wave-4 §2 — S3 config setter / masked getter
  // ---------------------------------------------------------------------------

  /**
   * Write the S3 block to config.yaml (provider/bucket/region/endpoint/prefix/
   * public_url) and persist key/secret to data/secrets.json (never the yaml),
   * then re-initialize the app's S3 client (wave-4 §2).
   */
  async setS3(name: string, input: SetS3Input): Promise<MaskedS3> {
    if (!(await this.get(name))) {
      throw new NotFoundException(`app "${name}" not found`);
    }
    const disk = this.readDiskConfig(name);

    if (input.provider !== undefined) disk.s3.provider = input.provider;
    if (input.bucket !== undefined) disk.s3.bucket = input.bucket;
    if (input.region !== undefined) disk.s3.region = input.region;
    if (input.endpoint !== undefined) {
      disk.s3.endpoint = input.endpoint;
    } else if (input.provider === 'aws') {
      // Switching to provider "aws" without an explicit endpoint must clear
      // any stale provider-specific endpoint (the scaffold defaults to
      // Wasabi's) — otherwise uploads silently target the old provider with
      // AWS creds. Empty → the AWS SDK's default regional endpoint.
      disk.s3.endpoint = '';
    }
    if (input.forcePathStyle !== undefined) {
      disk.s3.force_path_style = input.forcePathStyle;
    }
    if (input.prefix !== undefined) disk.s3.prefix = input.prefix;
    if (input.public_url !== undefined) {
      const nextPublic = (input.public_url || '').replace(/\/+$/, '');
      const wasPublic = !!disk.s3.public_url;
      // Fold-3: enabling public VODs (empty → non-empty) needs confirmPublic.
      if (nextPublic && !wasPublic && input.confirmPublic !== true) {
        throw new BadRequestException(
          'enabling public_url makes recordings publicly accessible; ' +
            'resend with confirmPublic=true to proceed',
        );
      }
      disk.s3.public_url = nextPublic;
    }

    // Persist the block (no secrets) then the secrets (async store + the legacy
    // sync writer so both views stay consistent), then re-init the client.
    this.writeDiskConfig(name, disk);
    if (input.key) {
      this.writeSecret(disk.s3.access_key_env, input.key);
      await this.secrets.set(disk.s3.access_key_env, input.key);
    }
    if (input.secret) {
      this.writeSecret(disk.s3.secret_key_env, input.secret);
      await this.secrets.set(disk.s3.secret_key_env, input.secret);
    }
    this.secrets.invalidate();
    try {
      this.s3.evict();
    } catch {
      /* eviction is best-effort */
    }
    return this.maskedS3(disk);
  }

  /** S3 config with credentials masked (wave-4 §2). */
  async getS3(name: string): Promise<MaskedS3> {
    if (!(await this.get(name))) {
      throw new NotFoundException(`app "${name}" not found`);
    }
    return this.maskedS3(this.readDiskConfig(name));
  }

  private maskedS3(disk: DiskConfig): MaskedS3 {
    const key = this.resolveSecret(disk.s3.access_key_env);
    const secret = this.resolveSecret(disk.s3.secret_key_env);
    const publicVods = !!(disk.s3.public_url && disk.s3.public_url.length > 0);
    return {
      provider: disk.s3.provider,
      bucket: disk.s3.bucket,
      region: disk.s3.region,
      endpoint: disk.s3.endpoint,
      forcePathStyle: !!disk.s3.force_path_style,
      prefix: disk.s3.prefix,
      public_url: disk.s3.public_url || '',
      accessKeyEnv: disk.s3.access_key_env,
      secretKeyEnv: disk.s3.secret_key_env,
      key: this.mask(key),
      secret: this.mask(secret),
      configured: !!key && !!secret,
      keyMasked: this.mask(key),
      secretMasked: this.mask(secret),
      hasKey: !!key,
      hasSecret: !!secret,
      publicVods,
      publicWarning: publicVods ? PUBLIC_VODS_WARNING : null,
    };
  }

  private mask(value: string): string {
    if (!value) return '';
    if (value.length <= 4) return '****';
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
  }

  // ---------------------------------------------------------------------------
  // MQTT config setter / masked getter (same pattern as wave-4 §2 S3)
  // ---------------------------------------------------------------------------

  /**
   * Write the `mqtt:` + `latency_alert:` blocks to config.yaml and the broker
   * password to data/secrets.json (never the yaml), then drop the app's live
   * MQTT client so the next publish reconnects with the new settings.
   */
  async setMqtt(name: string, input: SetMqttInput): Promise<MaskedMqtt> {
    if (!(await this.get(name))) {
      throw new NotFoundException(`app "${name}" not found`);
    }
    const disk = this.readDiskConfig(name);

    if (input.enabled !== undefined) disk.mqtt.enabled = input.enabled;
    if (input.url !== undefined) disk.mqtt.url = input.url.trim();
    if (input.username !== undefined) disk.mqtt.username = input.username;
    if (input.topicPrefix !== undefined) {
      disk.mqtt.topic_prefix = input.topicPrefix.trim();
    }
    if (input.qos !== undefined) {
      disk.mqtt.qos = input.qos === 1 || input.qos === 2 ? input.qos : 0;
    }
    if (input.tls !== undefined) disk.mqtt.tls = input.tls;
    if (Array.isArray(input.events)) {
      const events = input.events.map((e) => String(e).trim()).filter(Boolean);
      disk.mqtt.events = events.length ? events : ['all'];
    }
    if (input.logs) {
      if (input.logs.enabled !== undefined) {
        disk.mqtt.logs.enabled = input.logs.enabled;
      }
      if (input.logs.level !== undefined) {
        disk.mqtt.logs.level = MQTT_LOG_LEVELS.has(input.logs.level)
          ? input.logs.level
          : 'info';
      }
    }
    if (input.latencyAlert) {
      const la = input.latencyAlert;
      if (la.enabled !== undefined) disk.latency_alert.enabled = la.enabled;
      if (la.thresholdMs !== undefined) {
        disk.latency_alert.threshold_ms = la.thresholdMs;
      }
      if (la.cooldownSeconds !== undefined) {
        disk.latency_alert.cooldown_seconds = la.cooldownSeconds;
      }
      if (la.intervalSeconds !== undefined) {
        disk.latency_alert.interval_seconds = la.intervalSeconds;
      }
    }

    // Persist the block (no secrets), then the password (async store + legacy
    // sync writer, mirroring setS3), then drop the live client.
    this.writeDiskConfig(name, disk);
    if (input.password) {
      this.writeSecret(disk.mqtt.password_env, input.password);
      await this.secrets.set(disk.mqtt.password_env, input.password);
    }
    this.secrets.invalidate();
    this.disconnectMqtt(name);
    return this.maskedMqtt(disk);
  }

  /** MQTT config with the password masked (never returned in clear). */
  async getMqtt(name: string): Promise<MaskedMqtt> {
    if (!(await this.get(name))) {
      throw new NotFoundException(`app "${name}" not found`);
    }
    return this.maskedMqtt(this.readDiskConfig(name));
  }

  private maskedMqtt(disk: DiskConfig): MaskedMqtt {
    const resolved = this.resolveMqtt(disk);
    return {
      enabled: resolved.enabled,
      url: resolved.url,
      username: resolved.username,
      topicPrefix: resolved.topicPrefix,
      qos: resolved.qos,
      tls: resolved.tls,
      events: resolved.events,
      logs: resolved.logs,
      passwordEnv: disk.mqtt.password_env,
      password: this.mask(resolved.password),
      hasPassword: !!resolved.password,
      configured: resolved.enabled && !!resolved.url,
      latencyAlert: AppsService.resolveLatencyAlert(disk.latency_alert),
    };
  }

  /**
   * Best-effort: drop the app's live MQTT client (config changed / app gone)
   * via the global MQTT_SERVICE. Resolved lazily through ModuleRef — same
   * no-cycle pattern as the samples hand-off.
   */
  private disconnectMqtt(name: string): void {
    try {
      const mqtt = this.moduleRef.get<MqttServiceContract>(MQTT_SERVICE, {
        strict: false,
      });
      void mqtt?.disconnectApp(name).catch(() => undefined);
    } catch {
      /* mqtt module absent (tests) — nothing to drop */
    }
  }

  /**
   * Validate a raw YAML config (wave-4 §1): must parse and carry the minimal
   * shape. Returns soft warnings for missing-but-tolerated blocks. Throws
   * BadRequestException (→ 400) on a hard parse / shape error.
   */
  private validateRawConfig(
    name: string,
    rawYaml: string,
  ): { warnings: string[] } {
    let parsed: unknown;
    try {
      parsed = yaml.load(rawYaml);
    } catch (err) {
      throw new BadRequestException(
        `YAML parse error: ${(err as Error).message}`,
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BadRequestException(
        'config must be a YAML mapping (object) at the top level',
      );
    }
    const obj = parsed as Record<string, unknown>;
    const warnings: string[] = [];

    if (obj.name !== undefined && obj.name !== name) {
      throw new BadRequestException(
        `config "name" ("${String(obj.name)}") must match the app name "${name}"`,
      );
    }
    if (obj.s3 !== undefined && (typeof obj.s3 !== 'object' || obj.s3 === null)) {
      throw new BadRequestException('"s3" must be a mapping if present');
    }
    if (
      obj.recording !== undefined &&
      (typeof obj.recording !== 'object' || obj.recording === null)
    ) {
      throw new BadRequestException('"recording" must be a mapping if present');
    }
    // Refuse inline secrets in the yaml (they belong in secrets.json).
    const s3 = (obj.s3 as Record<string, unknown>) || {};
    if (s3.key !== undefined || s3.secret !== undefined) {
      warnings.push(
        's3.key/s3.secret in the yaml are ignored; use PUT /apps/:app/s3 to set credentials',
      );
    }
    const mqtt = (obj.mqtt as Record<string, unknown>) || {};
    if (mqtt.password !== undefined) {
      warnings.push(
        'mqtt.password in the yaml is ignored; use PUT /apps/:app/mqtt to set the broker password',
      );
    }
    if (obj.room_prefix === undefined) {
      warnings.push('room_prefix missing; defaulting to the app name on reload');
    }
    return { warnings };
  }

  // ---------------------------------------------------------------------------
  // Wave-4 §3 — samples (delegated to SamplesService via ModuleRef, no cycle)
  // ---------------------------------------------------------------------------

  /** Generate the wave-4 sample set for an app. Best-effort (never throws). */
  private async generateSamples(name: string): Promise<void> {
    try {
      const samples = this.moduleRef.get<SamplesServiceContract>(
        SAMPLES_SERVICE,
        { strict: false },
      );
      await samples.generate(name);
    } catch (err) {
      this.logger.warn(
        `samples generation for "${name}" skipped: ${(err as Error).message}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Cached PRAGMA: does the global `apps` table carry the `tenant_id` column? */
  private hasTenantColumn?: boolean;
  private appsHasTenantColumn(): boolean {
    if (this.hasTenantColumn !== undefined) return this.hasTenantColumn;
    try {
      const cols = this.db
        .global()
        .prepare('PRAGMA table_info(apps)')
        .all() as Array<{ name: string }>;
      this.hasTenantColumn = cols.some((c) => c.name === 'tenant_id');
    } catch {
      this.hasTenantColumn = false;
    }
    return this.hasTenantColumn;
  }

  private toRecord(row: AppRow): AppRecord {
    return {
      id: row.id,
      name: row.name,
      displayName: row.display_name ?? row.name,
      livekitRoomPrefix: row.livekit_room_prefix ?? row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      settingsJson: row.settings_json,
    };
  }

  private configPath(name: string): string {
    return path.join(this.appDir(name), 'config.yaml');
  }

  private defaultDiskConfig(
    name: string,
    displayName: string,
    roomPrefix: string,
  ): DiskConfig {
    const envSlug = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    return {
      name,
      display_name: displayName,
      room_prefix: roomPrefix,
      recording: {
        enabled: true,
        mode: 'room-composite',
        layout: 'grid',
        local_dir: 'recordings',
        delete_local_after_upload: true,
        split_minutes: 0,
        snapshot_seconds: 0,
      },
      s3: {
        provider: 'wasabi',
        bucket: '',
        region: 'us-east-1',
        endpoint: 'https://s3.us-east-1.wasabisys.com',
        force_path_style: false,
        prefix: `streamhub/${name}`,
        public_url: '',
        access_key_env: `APP_${envSlug}_S3_KEY`,
        secret_key_env: `APP_${envSlug}_S3_SECRET`,
      },
      webrtc: {
        adaptive: true,
        layers: [
          { name: 'high', height: 720 },
          { name: 'med', height: 480 },
          { name: 'low', height: 240 },
        ],
      },
      rtmp: { enabled: true, transcode: true },
      // NEW apps ship with server-side transcoding OFF (pure passthrough):
      // RTMP ingress is not re-encoded and recordings stay single-file H.264.
      // Opt-in via PATCH /apps/:app/config (transcodingEnabled) or the yaml.
      transcoding: {
        enabled: false,
        encoding: 'h264',
        vod_adaptive: false,
        vod_renditions: [],
      },
      callbacks: { url: '', secret: '' },
      mqtt: {
        enabled: false,
        url: '',
        username: '',
        password_env: `APP_${envSlug}_MQTT_PASSWORD`,
        topic_prefix: `streamhub/${name}`,
        qos: 0,
        tls: false,
        events: ['all'],
        logs: { enabled: false, level: 'info' },
      },
      latency_alert: {
        enabled: false,
        threshold_ms: 1000,
        cooldown_seconds: 60,
        interval_seconds: 10,
      },
      features: {
        rtmp_password: false,
        viewer_counter: true,
        chat: false,
        reactions: false,
        hidden_qc: true,
        adaptive_player: true,
        public_playback: true,
      },
    };
  }

  private readDiskConfig(name: string): DiskConfig {
    const file = this.configPath(name);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      throw new NotFoundException(`config.yaml missing for app "${name}"`);
    }
    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch (err) {
      throw new InternalServerErrorException(
        `invalid config.yaml for app "${name}": ${(err as Error).message}`,
      );
    }
    const over = (parsed as Partial<DiskConfig>) || {};
    // Merge over a fresh default so missing fields are tolerated.
    const base = this.defaultDiskConfig(
      name,
      over.display_name || name,
      over.room_prefix || name,
    );
    return this.mergeDisk(base, over);
  }

  private mergeDisk(base: DiskConfig, over: Partial<DiskConfig>): DiskConfig {
    return {
      name: over.name ?? base.name,
      display_name: over.display_name ?? base.display_name,
      room_prefix: over.room_prefix ?? base.room_prefix,
      recording: { ...base.recording, ...(over.recording ?? {}) },
      s3: { ...base.s3, ...(over.s3 ?? {}) },
      webrtc: {
        adaptive: over.webrtc?.adaptive ?? base.webrtc.adaptive,
        layers:
          Array.isArray(over.webrtc?.layers) && over.webrtc!.layers.length
            ? over.webrtc!.layers
            : base.webrtc.layers,
      },
      rtmp: { ...base.rtmp, ...(over.rtmp ?? {}) },
      transcoding: over.transcoding
        ? { ...base.transcoding, ...over.transcoding }
        : {
            ...base.transcoding,
            // Back-compat: a yaml that predates the `transcoding:` block keeps
            // its historical behaviour — server transcoding was implicitly
            // driven by rtmp.transcode, so mirror it as the master switch.
            enabled: (over.rtmp?.transcode ?? base.rtmp.transcode) === true,
          },
      callbacks: { ...base.callbacks, ...(over.callbacks ?? {}) },
      mqtt: {
        ...base.mqtt,
        ...(over.mqtt ?? {}),
        events:
          Array.isArray(over.mqtt?.events) && over.mqtt!.events.length
            ? over.mqtt!.events
            : base.mqtt.events,
        logs: { ...base.mqtt.logs, ...(over.mqtt?.logs ?? {}) },
      },
      latency_alert: { ...base.latency_alert, ...(over.latency_alert ?? {}) },
      features: { ...base.features, ...(over.features ?? {}) },
    };
  }

  private writeDiskConfig(name: string, disk: DiskConfig): void {
    const file = this.configPath(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, yaml.dump(disk, { lineWidth: 120 }), {
      encoding: 'utf8',
      mode: 0o644,
    });
  }

  /**
   * Apply a resolved (camelCase) AppConfig patch onto the on-disk snake_case
   * representation. Secret values (s3.accessKey/secretKey) are NOT stored in
   * the yaml: they are written to data/secrets.json under the `*_env` refs.
   */
  private applyResolvedPatch(disk: DiskConfig, patch?: Partial<AppConfig>): void {
    if (!patch) return;
    if (patch.displayName !== undefined) disk.display_name = patch.displayName;
    if (patch.roomPrefix !== undefined) {
      disk.room_prefix = patch.roomPrefix.toLowerCase();
    }
    if (patch.recording) {
      const r = patch.recording;
      if (r.enabled !== undefined) disk.recording.enabled = r.enabled;
      if (r.mode !== undefined) disk.recording.mode = r.mode;
      if (r.layout !== undefined) disk.recording.layout = r.layout;
      if (r.localDir !== undefined) disk.recording.local_dir = r.localDir;
      if (r.deleteLocalAfterUpload !== undefined) {
        disk.recording.delete_local_after_upload = r.deleteLocalAfterUpload;
      }
      if (r.splitMinutes !== undefined) {
        disk.recording.split_minutes = r.splitMinutes;
      }
      if (r.snapshotSeconds !== undefined) {
        disk.recording.snapshot_seconds = r.snapshotSeconds;
      }
    }
    if (patch.s3) {
      const s = patch.s3;
      if (s.provider !== undefined) disk.s3.provider = s.provider;
      if (s.bucket !== undefined) disk.s3.bucket = s.bucket;
      if (s.region !== undefined) disk.s3.region = s.region;
      if (s.endpoint !== undefined) disk.s3.endpoint = s.endpoint;
      if (s.forcePathStyle !== undefined) {
        disk.s3.force_path_style = s.forcePathStyle;
      }
      if (s.prefix !== undefined) disk.s3.prefix = s.prefix;
      if (s.publicUrl !== undefined) {
        disk.s3.public_url = (s.publicUrl || '').replace(/\/+$/, '');
      }
      // Secrets → out of the yaml, into data/secrets.json.
      if (s.accessKey) this.writeSecret(disk.s3.access_key_env, s.accessKey);
      if (s.secretKey) this.writeSecret(disk.s3.secret_key_env, s.secretKey);
    }
    if (patch.webrtc) {
      if (patch.webrtc.adaptive !== undefined) {
        disk.webrtc.adaptive = patch.webrtc.adaptive;
      }
      if (Array.isArray(patch.webrtc.layers) && patch.webrtc.layers.length) {
        disk.webrtc.layers = patch.webrtc.layers;
      }
    }
    if (patch.rtmp) {
      if (patch.rtmp.enabled !== undefined) disk.rtmp.enabled = patch.rtmp.enabled;
      if (patch.rtmp.transcode !== undefined) {
        disk.rtmp.transcode = patch.rtmp.transcode;
      }
    }
    if (patch.transcoding) {
      const t = patch.transcoding;
      if (t.enabled !== undefined) disk.transcoding.enabled = t.enabled;
      if (t.encoding !== undefined) disk.transcoding.encoding = t.encoding;
      if (t.vodAdaptive !== undefined) {
        disk.transcoding.vod_adaptive = t.vodAdaptive;
      }
      if (Array.isArray(t.vodRenditions)) {
        disk.transcoding.vod_renditions = t.vodRenditions.map((r) => ({
          height: r.height,
          bitrate_kbps: r.bitrateKbps,
        }));
      }
    }
    if (patch.callbacks) {
      if (patch.callbacks.url !== undefined) {
        disk.callbacks.url = patch.callbacks.url;
      }
      if (patch.callbacks.secret !== undefined) {
        disk.callbacks.secret = patch.callbacks.secret;
      }
    }
    if (patch.mqtt) {
      const m = patch.mqtt;
      if (m.enabled !== undefined) disk.mqtt.enabled = m.enabled;
      if (m.url !== undefined) disk.mqtt.url = m.url.trim();
      if (m.username !== undefined) disk.mqtt.username = m.username;
      if (m.topicPrefix !== undefined) {
        disk.mqtt.topic_prefix = m.topicPrefix.trim();
      }
      if (m.qos !== undefined) disk.mqtt.qos = m.qos;
      if (m.tls !== undefined) disk.mqtt.tls = m.tls;
      if (Array.isArray(m.events)) disk.mqtt.events = m.events;
      if (m.logs) {
        if (m.logs.enabled !== undefined) {
          disk.mqtt.logs.enabled = m.logs.enabled;
        }
        if (m.logs.level !== undefined) disk.mqtt.logs.level = m.logs.level;
      }
      // Secret → out of the yaml, into data/secrets.json (empty keeps stored).
      if (m.password) this.writeSecret(disk.mqtt.password_env, m.password);
    }
    if (patch.latencyAlert) {
      const la = patch.latencyAlert;
      if (la.enabled !== undefined) disk.latency_alert.enabled = la.enabled;
      if (la.thresholdMs !== undefined) {
        disk.latency_alert.threshold_ms = la.thresholdMs;
      }
      if (la.cooldownSeconds !== undefined) {
        disk.latency_alert.cooldown_seconds = la.cooldownSeconds;
      }
      if (la.intervalSeconds !== undefined) {
        disk.latency_alert.interval_seconds = la.intervalSeconds;
      }
    }
    if (patch.features) {
      const f = patch.features;
      if (f.rtmpPassword !== undefined) disk.features.rtmp_password = f.rtmpPassword;
      if (f.viewerCounter !== undefined) {
        disk.features.viewer_counter = f.viewerCounter;
      }
      if (f.chat !== undefined) disk.features.chat = f.chat;
      if (f.reactions !== undefined) disk.features.reactions = f.reactions;
      if (f.hiddenQc !== undefined) disk.features.hidden_qc = f.hiddenQc;
      if (f.adaptivePlayer !== undefined) {
        disk.features.adaptive_player = f.adaptivePlayer;
      }
      if (f.publicPlayback !== undefined) {
        disk.features.public_playback = f.publicPlayback;
      }
      if (f.wsIngest !== undefined) {
        disk.features.ws_ingest = {
          enabled: f.wsIngest.enabled,
          max_cameras: f.wsIngest.maxCameras,
          max_fps: f.wsIngest.maxFps,
          max_frame_kb: f.wsIngest.maxFrameKb,
        };
      }
    }
  }

  /** Resolve the on-disk config into the cross-module AppConfig (creds resolved). */
  private toResolvedConfig(disk: DiskConfig): AppConfig {
    const s3: S3Config = {
      provider: disk.s3.provider,
      bucket: disk.s3.bucket,
      region: disk.s3.region,
      endpoint: disk.s3.endpoint || undefined,
      forcePathStyle: !!disk.s3.force_path_style,
      prefix: disk.s3.prefix,
      publicUrl: disk.s3.public_url || undefined,
      accessKey: this.resolveSecret(disk.s3.access_key_env),
      secretKey: this.resolveSecret(disk.s3.secret_key_env),
    };
    return {
      name: disk.name,
      displayName: disk.display_name,
      roomPrefix: disk.room_prefix,
      recording: {
        enabled: disk.recording.enabled,
        mode: disk.recording.mode,
        layout: disk.recording.layout,
        localDir: disk.recording.local_dir,
        deleteLocalAfterUpload: disk.recording.delete_local_after_upload,
        splitMinutes: Number(disk.recording.split_minutes ?? 0) || 0,
        snapshotSeconds: Number(disk.recording.snapshot_seconds ?? 0) || 0,
      },
      s3,
      webrtc: { adaptive: disk.webrtc.adaptive, layers: disk.webrtc.layers },
      rtmp: { enabled: disk.rtmp.enabled, transcode: disk.rtmp.transcode },
      transcoding: this.resolveTranscoding(disk),
      callbacks: { url: disk.callbacks.url, secret: disk.callbacks.secret },
      mqtt: this.resolveMqtt(disk),
      latencyAlert: AppsService.resolveLatencyAlert(disk.latency_alert),
      features: {
        rtmpPassword: !!disk.features.rtmp_password,
        viewerCounter: !!disk.features.viewer_counter,
        chat: !!disk.features.chat,
        reactions: !!disk.features.reactions,
        hiddenQc: !!disk.features.hidden_qc,
        adaptivePlayer: !!disk.features.adaptive_player,
        // Default ON: only an explicit `public_playback: false` disables it.
        publicPlayback: disk.features.public_playback !== false,
        wsIngest: AppsService.resolveWsIngest(disk.features.ws_ingest),
      },
    };
  }

  /**
   * Resolve the `features.ws_ingest` block (ESP32 direct WS ingest — see
   * streamhub-docs/integrations/ESP32-WS-INGEST.md). Defaults: enabled, no
   * camera cap, 15 fps, 256 KB/frame. Only an explicit `enabled: false`
   * turns the gateway off for the app.
   */
  private static resolveWsIngest(
    disk: DiskFeatures['ws_ingest'],
  ): NonNullable<AppConfig['features']['wsIngest']> {
    const num = (v: unknown, fallback: number): number => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    return {
      enabled: disk?.enabled !== false,
      maxCameras: num(disk?.max_cameras, 0),
      maxFps: num(disk?.max_fps, 15) || 15,
      maxFrameKb: num(disk?.max_frame_kb, 256) || 256,
    };
  }

  /**
   * Resolve + sanitize the on-disk `transcoding:` block: unknown encodings fall
   * back to `h264`, invalid renditions (bad height/bitrate) are dropped and the
   * ladder is deduped by height + sorted descending (highest quality first).
   */
  private resolveTranscoding(
    disk: DiskConfig,
  ): NonNullable<AppConfig['transcoding']> {
    const t = disk.transcoding;
    const encoding: TranscodingEncoding =
      String(t.encoding || 'h264').toLowerCase() === 'h264+vp8'
        ? 'h264+vp8'
        : 'h264';
    const seen = new Set<number>();
    const vodRenditions: VodRendition[] = (
      Array.isArray(t.vod_renditions) ? t.vod_renditions : []
    )
      .map((r) => ({
        height: Math.floor(Number(r?.height)),
        bitrateKbps: Math.floor(Number(r?.bitrate_kbps)),
      }))
      .filter(
        (r) =>
          Number.isFinite(r.height) &&
          r.height >= 144 &&
          r.height <= 4320 &&
          Number.isFinite(r.bitrateKbps) &&
          r.bitrateKbps > 0,
      )
      .filter((r) => (seen.has(r.height) ? false : (seen.add(r.height), true)))
      .sort((a, b) => b.height - a.height);
    return {
      enabled: !!t.enabled,
      encoding,
      vodAdaptive: !!t.vod_adaptive,
      vodRenditions,
    };
  }

  /**
   * Resolve + sanitize the on-disk `mqtt:` block: password dereferenced from
   * the secret store (env wins), qos clamped to 0|1|2, events defaulting to
   * ['all'], log level falling back to 'info'.
   */
  private resolveMqtt(disk: DiskConfig): MqttConfig {
    const m = disk.mqtt;
    const qos: MqttQos = m.qos === 1 || m.qos === 2 ? m.qos : 0;
    const events =
      Array.isArray(m.events) && m.events.length
        ? m.events.map((e) => String(e).trim()).filter(Boolean)
        : ['all'];
    const level = MQTT_LOG_LEVELS.has(String(m.logs?.level))
      ? (m.logs.level as LogLevel)
      : 'info';
    return {
      enabled: !!m.enabled,
      url: (m.url || '').trim(),
      username: m.username || '',
      password: this.resolveSecret(m.password_env),
      topicPrefix: (m.topic_prefix || '').trim() || `streamhub/${disk.name}`,
      qos,
      tls: !!m.tls,
      events: events.length ? events : ['all'],
      logs: { enabled: !!m.logs?.enabled, level },
    };
  }

  /** Resolve + sanitize the on-disk `latency_alert:` block (defaults applied). */
  private static resolveLatencyAlert(
    disk: DiskConfig['latency_alert'],
  ): LatencyAlertConfig {
    const num = (v: unknown, fallback: number, min: number): number => {
      const n = Number(v);
      return Number.isFinite(n) && n >= min ? n : fallback;
    };
    return {
      enabled: !!disk?.enabled,
      thresholdMs: num(disk?.threshold_ms, 1000, 1),
      cooldownSeconds: num(disk?.cooldown_seconds, 60, 0),
      intervalSeconds: num(disk?.interval_seconds, 10, 2),
    };
  }

  // --- secrets (data/secrets.json, chmod 600) --------------------------------

  private secretsPath(): string {
    return path.join(this.config.dataDir, 'data', 'secrets.json');
  }

  private readSecrets(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.secretsPath(), 'utf8')) as Record<
        string,
        string
      >;
    } catch {
      return {};
    }
  }

  /** Resolve a secret ref: env wins, then data/secrets.json, else empty. */
  private resolveSecret(ref: string): string {
    if (!ref) return '';
    const fromEnv = this.config.env(ref);
    if (fromEnv) return fromEnv;
    return this.readSecrets()[ref] ?? '';
  }

  private writeSecret(ref: string, value: string): void {
    if (!ref) return;
    const file = this.secretsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const secrets = this.readSecrets();
    secrets[ref] = value;
    fs.writeFileSync(file, JSON.stringify(secrets, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* non-fatal on filesystems without POSIX perms */
    }
  }

  // --- sample pages ----------------------------------------------------------

  /** Public base URL of the deployment (SPEC §1). Env override, sane default. */
  private publicBaseUrl(): string {
    const fromEnv =
      this.config.env('PUBLIC_BASE_URL') || this.config.env('STREAMHUB_PUBLIC_URL');
    if (fromEnv) return fromEnv.replace(/\/+$/, '');
    return 'https://streamhub.example.com';
  }

  private writeSamplePages(name: string, roomName: string): void {
    const base = this.publicBaseUrl();
    const pages = renderSamplePages({
      appName: name,
      roomName,
      publicBaseUrl: base,
      publicWsUrl: this.config.publicWsUrl || 'wss://media.example.com',
      apiBase: `${base}/api/v1`,
    });
    const dir = path.join(this.appDir(name), 'samples');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'publish.html'), pages.publish, 'utf8');
    fs.writeFileSync(path.join(dir, 'play.html'), pages.play, 'utf8');
    fs.writeFileSync(path.join(dir, 'embed.html'), pages.embed, 'utf8');
  }
}
