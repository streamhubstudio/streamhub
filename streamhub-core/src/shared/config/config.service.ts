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
   * TLS-terminated RTMP ingest (RTMPS). When on, the ingress endpoints surface
   * an `rtmps_url` alongside `rtmp_url`. Off by default (backward-compat): the
   * operator must also start the `rtmps` compose profile (stunnel front on
   * :rtmpsPort → the plaintext ingress on :1935). See deploy/rtmps/.
   */
  readonly rtmpsEnable: boolean;
  /** Port the RTMPS TLS front listens on (default 1936). */
  readonly rtmpsPort: number;
  /** Public host for the rtmps:// URL. Empty → falls back to rtmpPublicHost. */
  readonly rtmpsPublicHost: string;
  /**
   * RTMP→HLS passthrough (remux, no transcode). Master switch for the embedded
   * passthrough RTMP front (a per-ingress `ffmpeg -listen 1 -c copy` acceptor,
   * see modules/passthrough). OFF by default — additive/opt-in, and it NEVER
   * touches LiveKit's :1935 or the transcode path. See features/rtmp-passthrough.md.
   */
  readonly rtmpPassthroughEnable: boolean;
  /** Base TCP port the passthrough RTMP front binds (default 1937; NOT :1935). */
  readonly rtmpPassthroughPort: number;
  /**
   * Single-port :1935 RTMP switch via MediaMTX (features/rtmp-single-port.md).
   * When ON, a front MediaMTX owns the public :1935 and routes by path: `live/*`
   * → LiveKit ingress (moved to :11935), everything else (`<app>/<key>`) →
   * passthrough. The passthrough plane then arms its remux in PULL mode (ffmpeg
   * pulls `rtmp://127.0.0.1:<mediamtxRtmpPort>/<app>/<key>` from MediaMTX) driven
   * by the MediaMTX ready/notready hooks — it NEVER binds the per-ingress 1937+
   * listeners. OFF by default: the shipped multi-port plane is byte-for-byte
   * unchanged. Read at boot → restart to apply; flipping OFF is the rollback.
   */
  readonly mediamtxEnable: boolean;
  /** Public RTMP port MediaMTX owns (the pull source port). Default 1935. */
  readonly mediamtxRtmpPort: number;
  /**
   * MediaMTX control API base URL (localhost). On core boot, the pull remuxes +
   * LiveKit forwards are child processes that died with the previous core, but
   * MediaMTX still holds the publishers (its `runOnReady` only fires on publish
   * START). So boot re-arm queries `<mediamtxApiUrl>/v3/paths/list` and re-arms
   * every already-`ready` path — otherwise a deploy would blackout live channels
   * until each encoder reconnected. Default `http://127.0.0.1:9997`.
   */
  readonly mediamtxApiUrl: string;
  /**
   * Where the LiveKit RTMP ingress listens once MediaMTX takes over :1935. The
   * core owns ALL routing (MediaMTX has no path regexes), so a `live/<key>`
   * publish is forwarded by the core: it pulls off MediaMTX and pushes `-c copy`
   * to `rtmp://127.0.0.1:<livekitIngressRtmpPort>/live/<key>`. Default 11935.
   */
  readonly livekitIngressRtmpPort: number;
  /**
   * Shared secret the MediaMTX auth/ready/notready hooks must present (header
   * `X-MediaMTX-Secret`) to reach the loopback-only internal controller. Empty =
   * the internal hook routes are disabled (403) — a secret MUST be configured
   * alongside `mediamtxEnable`. Never logged.
   */
  readonly mediamtxHookSecret: string;
  /**
   * Ingest ENCODING profile for the LiveKit-transcoded ingress — the global
   * switch for the (experimental) efficient-transcode feature:
   *  - 'livekit' (DEFAULT — stable): StreamHub attaches NO encoding opinions
   *    at all and LiveKit decides everything (the long-standing pre-2.7.1
   *    behaviour). New installs always start here.
   *  - 'efficient' (opt-in): StreamHub attaches an explicit single-layer
   *    preset (or a capped 3-layer preset when the app opts into adaptive) so
   *    LiveKit's CPU-heavy default 3-layer simulcast can never leak through
   *    (measured: 3×1080p ≈ 100% → ~24% of an 8-core box).
   * Server-wide (per node in a cluster); read at boot → restart to apply.
   * Flipping back to 'livekit' is the instant rollback.
   */
  readonly ingestProfile: 'efficient' | 'livekit';
  /**
   * Public base URL of this core (e.g. https://streamhub.digitalhub.com.ar), used
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

  /**
   * Global notifier fan-out defaults (Vision-Edge §H). Per-app `notifications:`
   * config blocks override these; empty = that channel is off unless an app
   * configures its own. Never logged.
   *  - Discord: an incoming-webhook URL (POST {content/embeds}).
   *  - Telegram: a bot token + a default chat id (sendMessage API).
   */
  readonly notifyDiscordWebhook: string;
  readonly notifyTelegramBotToken: string;
  readonly notifyTelegramChatId: string;

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
    this.rtmpsEnable = this.bool('STREAMHUB_RTMPS_ENABLE', false);
    this.rtmpsPort = this.int('STREAMHUB_RTMPS_PORT', 1936);
    this.rtmpsPublicHost = this.str('RTMPS_PUBLIC_HOST', '');
    this.rtmpPassthroughEnable = this.bool('STREAMHUB_RTMP_PASSTHROUGH_ENABLE', false);
    this.rtmpPassthroughPort = this.int('STREAMHUB_RTMP_PASSTHROUGH_PORT', 1937);
    this.mediamtxEnable = this.bool('STREAMHUB_MEDIAMTX_ENABLE', false);
    this.mediamtxRtmpPort = this.int('STREAMHUB_MEDIAMTX_RTMP_PORT', 1935);
    this.mediamtxApiUrl = this.str('STREAMHUB_MEDIAMTX_API_URL', 'http://127.0.0.1:9997');
    this.livekitIngressRtmpPort = this.int('STREAMHUB_LIVEKIT_INGRESS_RTMP_PORT', 11935);
    this.mediamtxHookSecret = this.str('STREAMHUB_MEDIAMTX_HOOK_SECRET', '');
    this.ingestProfile =
      this.str('STREAMHUB_INGEST_PROFILE', 'livekit').trim().toLowerCase() ===
      'efficient'
        ? 'efficient'
        : 'livekit';
    this.publicBaseUrl = this.str('PUBLIC_BASE_URL', '');

    this.redisUrl = this.str('REDIS_URL', 'redis://localhost:6379');
    this.jwtSecret = this.str('STREAMHUB_JWT_SECRET', '');

    this.clusterToken = this.str('STREAMHUB_CLUSTER_TOKEN', '');
    this.clusterRedisUrl = this.str('STREAMHUB_CLUSTER_REDIS_URL', '');

    this.adminUser = this.str('ADMIN_USER', '');
    this.adminPass = this.str('ADMIN_PASS', '');

    this.dataDir = this.str('DATA_DIR', process.cwd());

    this.logRetentionDays = Math.max(this.int('LOG_RETENTION_DAYS', 30), 0);

    // Notifier fan-out defaults (Vision-Edge §H) — additive, single-purpose.
    this.notifyDiscordWebhook = this.str('STREAMHUB_NOTIFY_DISCORD_WEBHOOK', '');
    this.notifyTelegramBotToken = this.str(
      'STREAMHUB_NOTIFY_TELEGRAM_BOT_TOKEN',
      '',
    );
    this.notifyTelegramChatId = this.str('STREAMHUB_NOTIFY_TELEGRAM_CHAT_ID', '');
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

  /** Truthy env: 1/true/on/yes (case-insensitive); everything else is false. */
  private bool(name: string, fallback: boolean): boolean {
    const v = process.env[name];
    if (v === undefined || v === '') return fallback;
    return /^(1|true|on|yes)$/i.test(v.trim());
  }
}
