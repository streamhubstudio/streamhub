import { Injectable, Logger } from '@nestjs/common';
import * as os from 'os';
import * as fs from 'fs';
import {
  EgressClient,
  EgressStatus,
  IngressClient,
  RoomServiceClient,
} from 'livekit-server-sdk';
import { ConfigService } from '../../shared/config/config.service';
import { DbService } from '../../shared/db/db.service';
import { DbSizesService } from '../../shared/db/db-sizes.service';

export interface HealthStatus {
  status: 'ok';
  up: true;
  version: string;
  /** ISO-8601 timestamp of the response. */
  ts: string;
  uptimeSeconds: number;
}

export interface DiskStats {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
}

export interface EndpointStatus {
  /** Whether the LiveKit endpoint responded. */
  reachable: boolean;
  /** Count of currently active sessions (publishing/recording). */
  active: number;
  /** Total sessions returned (active + recently finished still listed). */
  total: number;
}

/** DB + VOD storage footprint surfaced on /stats (drives the Dashboard). */
export interface StorageStats {
  /** Global registry DB — data/streamhub.db (+ sidecars). */
  dbSizeBytes: number;
  /** Sum of every per-app app.db (+ sidecars). */
  appsDbSizeBytes: number;
  /** dbSizeBytes + appsDbSizeBytes — every SQLite file StreamHub owns. */
  totalDbSizeBytes: number;
  /** Sum of `size_bytes` across all VODs of every app. */
  vodTotalBytes: number;
  /** Total number of VOD rows server-wide. */
  vodCount: number;
}

export interface ServerStats {
  ts: string;
  uptimeSeconds: number;
  version: string;
  cpu: { loadAvg: number[]; cores: number };
  memory: { totalBytes: number; freeBytes: number; usedBytes: number };
  disk: DiskStats | null;
  livekitReachable: boolean;
  counts: { apps: number; rooms: number; activeStreams: number };
  egress: EndpointStatus;
  ingress: EndpointStatus;
  storage: StorageStats;
}

/**
 * Health/stats (SPEC §5 health, §6).
 * - health(): liveness, no auth — up/version/ts.
 * - stats(): CPU/mem/disk, uptime, version, livekit reachable, counts of
 *   apps/rooms/active streams, and egress/ingress status.
 *
 * LiveKit is queried via the server SDK directly (decoupled from the livekit
 * module stub) and every external call is wrapped so the endpoint never throws.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startedAt = Date.now();

  private readonly roomClient?: RoomServiceClient;
  private readonly egressClient?: EgressClient;
  private readonly ingressClient?: IngressClient;

  constructor(
    private readonly config: ConfigService,
    private readonly db: DbService,
    private readonly sizes: DbSizesService,
  ) {
    const host = HealthService.httpUrl(this.config.livekitUrl);
    const key = this.config.livekitApiKey;
    const secret = this.config.livekitApiSecret;
    // Only build clients when minimally configured; otherwise leave undefined so
    // stats() reports livekitReachable=false instead of throwing.
    if (host && key && secret) {
      try {
        this.roomClient = new RoomServiceClient(host, key, secret);
        this.egressClient = new EgressClient(host, key, secret);
        this.ingressClient = new IngressClient(host, key, secret);
      } catch (err) {
        this.logger.warn(`livekit clients init failed: ${String(err)}`);
      }
    }
  }

  /** ws:// → http://, wss:// → https:// (SDK expects an http(s) host). */
  private static httpUrl(u: string): string {
    if (!u) return u;
    return u.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
  }

  private get version(): string {
    return process.env.npm_package_version ?? '0.1.0';
  }

  health(): HealthStatus {
    return {
      status: 'ok',
      up: true,
      version: this.version,
      ts: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  async stats(): Promise<ServerStats> {
    const [rooms, egress, ingress] = await Promise.all([
      this.listRooms(),
      this.egressStatus(),
      this.ingressStatus(),
    ]);

    const counts = this.dbCounts();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    return {
      ts: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      version: this.version,
      cpu: { loadAvg: os.loadavg(), cores: os.cpus().length },
      memory: {
        totalBytes: totalMem,
        freeBytes: freeMem,
        usedBytes: totalMem - freeMem,
      },
      disk: this.diskStats(),
      livekitReachable: rooms !== null,
      counts: {
        apps: counts.apps,
        rooms: rooms?.length ?? 0,
        activeStreams: counts.activeStreams,
      },
      egress,
      ingress,
      storage: this.storageStats(),
    };
  }

  /** DB + VOD footprint. Defensive: never lets a size scan break /stats. */
  private storageStats(): StorageStats {
    try {
      const s = this.sizes.serverSizes();
      return {
        dbSizeBytes: s.dbSizeBytes,
        appsDbSizeBytes: s.appsDbSizeBytes,
        totalDbSizeBytes: s.totalDbSizeBytes,
        vodTotalBytes: s.vodTotalBytes,
        vodCount: s.vodCount,
      };
    } catch (err) {
      this.logger.debug(`storage stats unavailable: ${String(err)}`);
      return {
        dbSizeBytes: 0,
        appsDbSizeBytes: 0,
        totalDbSizeBytes: 0,
        vodTotalBytes: 0,
        vodCount: 0,
      };
    }
  }

  /** Disk usage of the data dir. Returns null if statfs unsupported/errors. */
  private diskStats(): DiskStats | null {
    try {
      // fs.statfsSync exists on Node >=18.15. Guard for older runtimes.
      const statfs = (fs as unknown as { statfsSync?: typeof fs.statfsSync })
        .statfsSync;
      if (typeof statfs !== 'function') return null;
      const s = statfs(this.config.dataDir);
      const total = s.bsize * s.blocks;
      const free = s.bsize * s.bavail;
      return { totalBytes: total, freeBytes: free, usedBytes: total - free };
    } catch (err) {
      this.logger.debug(`disk stats unavailable: ${String(err)}`);
      return null;
    }
  }

  /** App count (global db) + active stream count across every app's vods.db. */
  private dbCounts(): { apps: number; activeStreams: number } {
    let apps = 0;
    let activeStreams = 0;
    try {
      const gdb = this.db.global();
      const names = gdb
        .prepare('SELECT name FROM apps')
        .all() as { name: string }[];
      apps = names.length;
      for (const { name } of names) {
        try {
          const adb = this.db.appDb(name);
          const row = adb
            .prepare("SELECT COUNT(*) AS n FROM streams WHERE status = 'active'")
            .get() as { n: number };
          activeStreams += row?.n ?? 0;
        } catch (err) {
          this.logger.debug(`stream count failed for ${name}: ${String(err)}`);
        }
      }
    } catch (err) {
      this.logger.warn(`db counts failed: ${String(err)}`);
    }
    return { apps, activeStreams };
  }

  private async listRooms(): Promise<{ length: number }[] | null> {
    if (!this.roomClient) return null;
    try {
      return (await this.roomClient.listRooms()) as unknown as {
        length: number;
      }[];
    } catch (err) {
      this.logger.debug(`listRooms failed: ${String(err)}`);
      return null;
    }
  }

  private async egressStatus(): Promise<EndpointStatus> {
    if (!this.egressClient) return { reachable: false, active: 0, total: 0 };
    try {
      const list = await this.egressClient.listEgress({});
      const activeStates = new Set<number>([
        EgressStatus.EGRESS_STARTING,
        EgressStatus.EGRESS_ACTIVE,
        EgressStatus.EGRESS_ENDING,
      ]);
      const active = list.filter((e) => activeStates.has(e.status)).length;
      return { reachable: true, active, total: list.length };
    } catch (err) {
      this.logger.debug(`listEgress failed: ${String(err)}`);
      return { reachable: false, active: 0, total: 0 };
    }
  }

  private async ingressStatus(): Promise<EndpointStatus> {
    if (!this.ingressClient) return { reachable: false, active: 0, total: 0 };
    try {
      const list = await this.ingressClient.listIngress();
      // IngressState_Status.ENDPOINT_PUBLISHING === 2 → actively receiving media.
      const active = list.filter((i) => i.state?.status === 2).length;
      return { reachable: true, active, total: list.length };
    } catch (err) {
      this.logger.debug(`listIngress failed: ${String(err)}`);
      return { reachable: false, active: 0, total: 0 };
    }
  }
}
