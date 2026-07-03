import { Injectable, Logger } from '@nestjs/common';

import { ConfigService } from '../../shared/config/config.service';
import { DbService } from '../../shared/db/db.service';
import { DbSizesService } from '../../shared/db/db-sizes.service';
import {
  AuthzEnforce,
  ServerSettings,
  SettingGuidance,
  SettingsGuidance,
} from './settings.types';

/** Well-known LiveKit/media ports (host-networked; not individually env-driven). */
const LIVEKIT_SIGNALING_PORT = 7880;
const LIVEKIT_TCP_PORT = 7881;
const LIVEKIT_UDP_PORT = 7882;
const RTMP_PORT = 1935;
const WHIP_PORT = 8080;

/** SMTP host default mirrors EmailService — used only to decide `smtpConfigured`. */
const SMTP_HOST_DEFAULT = 'mail.wipermax.online';
const SUPERADMIN_EMAIL_DEFAULT = 'info@streamhub.studio';

/** Suffix appended to every guidance hint — edit the .env, then restart the core. */
const RESTART_HINT =
  'reiniciá el core: `systemctl restart streamhub-core` (alias en prod: `streamhub-core`).';

/**
 * Read-only "Server settings" reporter (#16).
 *
 * Builds the EFFECTIVE configuration of this core from {@link ConfigService}
 * (+ live DB/runtime probes) with EVERY secret redacted, and a per-group
 * `guidance` block telling the operator which env var to edit and how. It reads
 * only — it never writes config nor executes anything. The redaction contract
 * is enforced here: JWT/API/admin/cluster/SMTP secrets and the Redis password
 * never leave this service; only `…Set` booleans, masks and host:port strings.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly db: DbService,
    private readonly sizes: DbSizesService,
  ) {}

  /** The full, redacted server-settings snapshot. */
  getSettings(): ServerSettings {
    const c = this.config;
    const server = this.sizes.serverSizes();

    return {
      core: {
        nodeEnv: c.nodeEnv,
        port: c.port,
        host: c.host,
        publicBaseUrl: c.publicBaseUrl,
        publicWsUrl: c.publicWsUrl,
        rtmpPublicHost: c.rtmpPublicHost,
        logLevel: c.logLevel,
        logRetentionDays: c.logRetentionDays,
        authzEnforce: this.authzEnforce(),
        redisUrl: this.redisHostPort(c.redisUrl),
        dataDir: c.dataDir,
      },
      auth: {
        adminUser: c.adminUser,
        jwtSecretSet: this.isSet(c.jwtSecret),
        adminPassSet: this.isSet(c.adminPass),
        smtpConfigured: this.smtpConfigured(),
        superadminEmail: this.superadminEmail(),
      },
      livekit: {
        url: c.livekitUrl,
        apiKeySet: this.isSet(c.livekitApiKey),
        apiKeyMasked: this.mask(c.livekitApiKey),
      },
      cluster: {
        enabled: this.isSet(c.clusterToken),
        redisConfigured: this.isSet(c.clusterRedisUrl),
        nodesCount: this.nodesCount(),
      },
      metrics: {
        tokenSet: this.isSet(c.env('METRICS_TOKEN')),
      },
      storage: {
        dataDir: c.dataDir,
        dbSizeBytes: server.dbSizeBytes,
        appsCount: server.apps.length,
      },
      versions: {
        core: this.coreVersion(),
        node: process.version,
      },
      runtime: {
        uptimeSeconds: Math.floor(process.uptime()),
        pid: process.pid,
        platform: process.platform,
        memoryRssBytes: process.memoryUsage().rss,
      },
      ports: {
        core: c.port,
        livekitSignaling: LIVEKIT_SIGNALING_PORT,
        livekitTcp: LIVEKIT_TCP_PORT,
        livekitUdp: LIVEKIT_UDP_PORT,
        rtmp: RTMP_PORT,
        whip: WHIP_PORT,
      },
      guidance: this.guidance(),
    };
  }

  // ---------------------------------------------------------------------------
  // redaction helpers — NEVER return a secret value, only presence/mask/endpoint
  // ---------------------------------------------------------------------------

  /** True when a config value is present (non-empty). */
  private isSet(v: string | undefined | null): boolean {
    return typeof v === 'string' && v.trim().length > 0;
  }

  /** First 6 chars of a key + ellipsis (empty when unset). NOT reversible. */
  private mask(value: string): string {
    if (!this.isSet(value)) return '';
    return `${value.slice(0, 6)}…`;
  }

  /**
   * A Redis URL reduced to `host:port`, dropping any embedded password
   * (`redis://:pass@host:6379` → `host:6379`). Falls back to a manual strip if
   * the URL cannot be parsed, so a password can never leak through this path.
   */
  private redisHostPort(url: string): string {
    if (!this.isSet(url)) return '';
    try {
      const u = new URL(url);
      const port = u.port || '6379';
      return u.hostname ? `${u.hostname}:${port}` : url;
    } catch {
      const noProto = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
      const at = noProto.lastIndexOf('@');
      const hostPart = at >= 0 ? noProto.slice(at + 1) : noProto;
      return hostPart.split('/')[0] || '';
    }
  }

  /** STREAMHUB_AUTHZ_ENFORCE, normalized to off|log|on (default log). Read direct. */
  private authzEnforce(): AuthzEnforce {
    const raw = (this.config.env('STREAMHUB_AUTHZ_ENFORCE') ?? 'log')
      .trim()
      .toLowerCase();
    return raw === 'off' || raw === 'on' ? raw : 'log';
  }

  /** True when SMTP has a usable host + password (mirrors EmailService.isConfigured). */
  private smtpConfigured(): boolean {
    const host = this.config.env('STREAMHUB_SMTP_HOST') || SMTP_HOST_DEFAULT;
    const pass = this.config.env('STREAMHUB_SMTP_PASS') || '';
    return this.isSet(host) && this.isSet(pass);
  }

  /** Configured superadmin email (magic link to this address = superadmin). */
  private superadminEmail(): string {
    const v = this.config.env('STREAMHUB_SUPERADMIN_EMAIL');
    return ((v && v.trim()) || SUPERADMIN_EMAIL_DEFAULT).toLowerCase();
  }

  /** Count rows in the global `nodes` registry (0 on any failure). */
  private nodesCount(): number {
    try {
      const row = this.db
        .global()
        .prepare('SELECT COUNT(*) AS n FROM nodes')
        .get() as { n: number };
      return Number(row?.n) || 0;
    } catch (err) {
      this.logger.debug(`nodes count failed: ${String(err)}`);
      return 0;
    }
  }

  /** Core build version (npm_package_version, else package default). */
  private coreVersion(): string {
    return process.env.npm_package_version ?? '0.1.0';
  }

  // ---------------------------------------------------------------------------
  // operator guidance — how to change each setting (read-only, we NEVER run it)
  // ---------------------------------------------------------------------------

  private hint(setting: string, envVar: string, what: string): SettingGuidance {
    return {
      setting,
      envVar,
      howToChange: `${what} Editá \`${envVar}\` en el archivo \`.env\` del server (p. ej. \`/opt/streamhub-core/.env\`) y ${RESTART_HINT}`,
    };
  }

  private guidance(): SettingsGuidance {
    return {
      core: [
        this.hint('Puerto / host de bind', 'PORT', 'El core escucha en 127.0.0.1:PORT detrás de Caddy/nginx.'),
        this.hint('URL pública base', 'PUBLIC_BASE_URL', 'Base absoluta para armar URLs de HLS/reproducción.'),
        this.hint('URL pública de WebSocket', 'PUBLIC_WS_URL', 'wss:// público de LiveKit que reciben los clientes.'),
        this.hint('Host público de RTMP', 'RTMP_PUBLIC_HOST', 'Host que se publica para ingesta RTMP.'),
        this.hint('Nivel de log', 'LOG_LEVEL', 'Verbosidad del logger (trace|debug|info|warn|error).'),
        this.hint('Retención de logs (días)', 'LOG_RETENTION_DAYS', '0 desactiva la purga por antigüedad.'),
        this.hint('Enforcement de permisos', 'STREAMHUB_AUTHZ_ENFORCE', 'off = sin checks; log = solo audita; on = aplica RBAC/quotas. Poné `on` en producción.'),
        this.hint('URL de Redis', 'REDIS_URL', 'Coordinación de LiveKit/colas. La contraseña nunca se muestra acá.'),
        this.hint('Directorio de datos', 'DATA_DIR', 'Raíz de data/streamhub.db, apps/<name>/ y logs/.'),
      ],
      auth: [
        this.hint('Usuario admin (break-glass)', 'ADMIN_USER', 'Login de emergencia del panel.'),
        this.hint('Contraseña admin (break-glass)', 'ADMIN_PASS', 'Secreto: solo se informa si está seteado.'),
        this.hint('Secreto JWT de sesión', 'STREAMHUB_JWT_SECRET', 'Firma los JWT del panel. Secreto: solo se informa si está seteado.'),
        this.hint('Email de superadmin', 'STREAMHUB_SUPERADMIN_EMAIL', 'El magic-link a esta dirección obtiene rol superadmin.'),
        this.hint('SMTP (envío de mails)', 'STREAMHUB_SMTP_PASS', 'Requiere host + password. La contraseña nunca se muestra.'),
      ],
      livekit: [
        this.hint('URL de LiveKit', 'LIVEKIT_URL', 'ws:// del SFU LiveKit que usa el core.'),
        this.hint('API key de LiveKit', 'LIVEKIT_API_KEY', 'Identificador de credencial (se muestra enmascarado).'),
        this.hint('API secret de LiveKit', 'LIVEKIT_API_SECRET', 'Secreto: nunca se devuelve, solo si está seteado.'),
      ],
      cluster: [
        this.hint('Token de cluster', 'STREAMHUB_CLUSTER_TOKEN', 'Habilita el join de nodos edge. Secreto: solo se informa si está seteado.'),
        this.hint('Redis del cluster', 'STREAMHUB_CLUSTER_REDIS_URL', 'Redis compartido que se entrega a los nodos que se unen.'),
      ],
      metrics: [
        this.hint('Token de /metrics', 'METRICS_TOKEN', 'Protege el endpoint Prometheus. Secreto: solo se informa si está seteado.'),
      ],
      storage: [
        this.hint('Directorio de datos', 'DATA_DIR', 'Cambia dónde viven las DBs, grabaciones y snapshots.'),
      ],
    };
  }
}
