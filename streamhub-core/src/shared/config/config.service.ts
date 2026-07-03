import { Injectable } from '@nestjs/common';

/**
 * Typed access to streamhub-core environment (SPEC §13). Reads process.env once
 * at construction. No secrets are logged.
 */
@Injectable()
export class ConfigService {
  readonly port: number;
  readonly host: string;
  readonly nodeEnv: string;
  readonly logLevel: string;

  readonly livekitUrl: string;
  readonly livekitApiKey: string;
  readonly livekitApiSecret: string;
  readonly publicWsUrl: string;
  readonly rtmpPublicHost: string;
  /**
   * Public base URL of this core (e.g. https://streamhub.example.com), used
   * to build absolute HLS playlist URLs (wave-3 §1b). Empty = derive from the
   * incoming request host.
   */
  readonly publicBaseUrl: string;

  readonly redisUrl: string;
  readonly jwtSecret: string;

  /**
   * Shared secret an edge node must present (`X-Cluster-Token`) to join the
   * cluster via `POST /cluster/join`. Empty = cluster joining is disabled (503).
   */
  readonly clusterToken: string;
  /**
   * Redis URL handed to a joining edge node so it attaches to the same
   * LiveKit coordination Redis. Empty = returned as `null` in the join payload.
   */
  readonly clusterRedisUrl: string;

  /** UI login credentials (POST /auth/login). Login is disabled if unset. */
  readonly adminUser: string;
  readonly adminPass: string;

  /** Root data dir holding data/streamhub.db, apps/<name>/, logs/. */
  readonly dataDir: string;

  /**
   * Retention window (in days) for operational logs: `server_logs` rows and the
   * rotated log files under `<dataDir>/logs/`. `0` disables age-based purging
   * (the file count cap still applies). Default 30.
   */
  readonly logRetentionDays: number;

  constructor() {
    this.port = this.int('PORT', 3020);
    this.host = this.str('HOST', '127.0.0.1');
    this.nodeEnv = this.str('NODE_ENV', 'development');
    this.logLevel = this.str('LOG_LEVEL', 'info');

    this.livekitUrl = this.str('LIVEKIT_URL', 'ws://127.0.0.1:7880');
    this.livekitApiKey = this.str('LIVEKIT_API_KEY', '');
    this.livekitApiSecret = this.str('LIVEKIT_API_SECRET', '');
    this.publicWsUrl = this.str('PUBLIC_WS_URL', '');
    this.rtmpPublicHost = this.str('RTMP_PUBLIC_HOST', '');
    this.publicBaseUrl = this.str('PUBLIC_BASE_URL', '');

    this.redisUrl = this.str('REDIS_URL', 'redis://localhost:6379');
    this.jwtSecret = this.str('STREAMHUB_JWT_SECRET', '');

    this.clusterToken = this.str('STREAMHUB_CLUSTER_TOKEN', '');
    this.clusterRedisUrl = this.str('STREAMHUB_CLUSTER_REDIS_URL', '');

    this.adminUser = this.str('ADMIN_USER', '');
    this.adminPass = this.str('ADMIN_PASS', '');

    this.dataDir = this.str('DATA_DIR', process.cwd());

    this.logRetentionDays = Math.max(this.int('LOG_RETENTION_DAYS', 30), 0);
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  /** Raw env getter (resolves secret refs like access_key_env). */
  env(name: string): string | undefined {
    return process.env[name];
  }

  private str(name: string, fallback: string): string {
    const v = process.env[name];
    return v === undefined || v === '' ? fallback : v;
  }

  private int(name: string, fallback: number): number {
    const v = process.env[name];
    if (v === undefined || v === '') return fallback;
    const n = Number.parseInt(v, 10);
    return Number.isNaN(n) ? fallback : n;
  }
}
