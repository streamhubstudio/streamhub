/**
 * PASSTHROUGH RTMP FRONT — the self-attaching lifecycle piece of the RTMP→HLS
 * passthrough plane, env-gated OFF by default
 * (`STREAMHUB_RTMP_PASSTHROUGH_ENABLE`). Modeled on
 * {@link ../ws-ingest/ws-ingest.gateway WsIngestGateway}: it hooks
 * OnApplicationBootstrap → arm and OnApplicationShutdown → stop, so NO main.ts
 * edit is needed and every other ingest plane is left byte-for-byte untouched.
 *
 * RTMP acceptance itself is delegated to per-ingress `ffmpeg -listen 1` acceptors
 * owned by {@link RemuxManager} (there is no separate pure-JS RTMP server — see
 * features/rtmp-passthrough.md for the node-media-server evaluation). This class
 * therefore does two things when the feature is enabled:
 *   1. on boot, best-effort RE-ARM every persisted passthrough ingress across
 *      all apps (so listeners survive a core restart), and
 *   2. on shutdown, stop every remux (belt-and-braces alongside
 *      {@link RemuxManager.onModuleDestroy}).
 *
 * Under the MediaMTX single-port switch the boot re-arm is DIFFERENT: the pull
 * remuxes + LiveKit forwards are core child processes that died with the previous
 * core, but MediaMTX still holds the publishers (`runOnReady` only fires on
 * publish START). So instead of pre-arming `-listen` acceptors we query the
 * MediaMTX API for the currently-`ready` paths and re-arm each (pull remux for a
 * passthrough path, forward for a `live/` path). SRT keeps its own listener and
 * is re-armed the classic way.
 */
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';

import { APPS_SERVICE, AppsServiceContract } from '../../shared/contracts';
import { ConfigService } from '../../shared/config/config.service';
import {
  IngressAuthService,
  passthroughTransportOf,
} from '../livekit/ingress-auth.service';
import { classifyMediamtxPath } from './mediamtx-path.util';
import { PassthroughService } from './passthrough.service';
import { RemuxManager } from './remux.manager';

/** Abort the MediaMTX API probe after this long so a down API never blocks boot. */
const MEDIAMTX_API_TIMEOUT_MS = 3000;
/** Defensive cap on API pages walked (v3 `/v3/paths/list` is paginated). */
const MEDIAMTX_API_MAX_PAGES = 100;

/** One entry of the MediaMTX `/v3/paths/list` response we care about. */
interface MediamtxPathItem {
  name?: string;
  ready?: boolean;
}
interface MediamtxPathsPage {
  pageCount?: number;
  items?: MediamtxPathItem[];
}

@Injectable()
export class PassthroughRtmpServer
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(PassthroughRtmpServer.name);

  constructor(
    private readonly config: ConfigService,
    private readonly passthrough: PassthroughService,
    private readonly ingressAuth: IngressAuthService,
    private readonly remux: RemuxManager,
    @Optional()
    @Inject(APPS_SERVICE)
    private readonly apps?: AppsServiceContract,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.rtmpPassthroughEnable) {
      this.logger.log(
        'RTMP passthrough front is OFF (STREAMHUB_RTMP_PASSTHROUGH_ENABLE unset)',
      );
      return;
    }
    if (this.config.mediamtxEnable) {
      // Single-port switch: a front MediaMTX owns :1935 and drives RTMP arming
      // via its ready/notready hooks (pull mode). We do NOT pre-arm `-listen`
      // acceptors on boot for RTMP ingresses — rearmAll skips them; SRT
      // ingresses (own listener, MediaMTX-free) are still re-armed.
      this.logger.log(
        `RTMP passthrough front ON — MediaMTX single-port on :${this.config.mediamtxRtmpPort} ` +
          '(RTMP arming driven by MediaMTX hooks; SRT keeps its own listener)',
      );
      void this.rearmAll(); // SRT listeners (RTMP is skipped inside)
      void this.rearmFromMediamtx(); // re-arm pull remuxes + forwards already live
      return;
    }
    this.logger.log(
      `RTMP passthrough front ON — base port ${this.config.rtmpPassthroughPort} (remux, no transcode)`,
    );
    void this.rearmAll();
  }

  onApplicationShutdown(): void {
    // RemuxManager also SIGTERMs on its own OnModuleDestroy; this is idempotent.
    for (const app of this.armedApps) {
      for (const info of this.safeList(app)) {
        try {
          this.remux.stop(info.ingressId);
        } catch {
          /* shutting down */
        }
      }
    }
  }

  /** Apps we touched on boot, so shutdown can enumerate their ingresses. */
  private armedApps: string[] = [];

  /**
   * Best-effort: re-arm every persisted passthrough ingress across all apps so
   * `ffmpeg -listen` acceptors come back after a restart. Never throws.
   */
  private async rearmAll(): Promise<void> {
    if (!this.apps) return;
    let apps: { name: string }[] = [];
    try {
      apps = await this.apps.list();
    } catch (err) {
      this.logger.warn(`passthrough re-arm skipped: ${(err as Error).message}`);
      return;
    }
    this.armedApps = apps.map((a) => a.name);
    let armed = 0;
    for (const a of apps) {
      for (const row of this.safeListAuth(a.name)) {
        if (!row.streamKey) continue;
        // Under the MediaMTX single-port switch, RTMP ingresses are armed on
        // demand by the MediaMTX `ready` hook (pull mode); pre-arming them on
        // boot would spawn a pull ffmpeg against an idle MediaMTX path (nothing
        // publishing yet) and crash-loop. Skip them; SRT re-arms as before.
        if (
          this.config.mediamtxEnable &&
          passthroughTransportOf(row.ingressId) === 'rtmp'
        ) {
          continue;
        }
        try {
          const res = this.passthrough.handlePublish(a.name, row.streamKey);
          if (res.accepted) armed += 1;
        } catch (err) {
          this.logger.warn(
            `re-arm ${a.name}/${row.ingressId} failed: ${(err as Error).message}`,
          );
        }
      }
    }
    if (armed > 0) {
      this.logger.log(`re-armed ${armed} passthrough ingress(es) on boot`);
    }
  }

  /**
   * MediaMTX single-port boot re-arm: ask the MediaMTX API which paths are
   * already publishing (`ready`) and re-arm each — a pull remux for a passthrough
   * path, a forward for a `live/` path. This is what keeps live channels up
   * across a core restart (the child processes died, MediaMTX kept the
   * publishers). Best-effort: a down/slow API warns and continues (never blocks
   * boot, never throws). SRT is handled by {@link rearmAll}.
   */
  private async rearmFromMediamtx(): Promise<void> {
    let items: MediamtxPathItem[];
    try {
      items = await this.fetchMediamtxPaths();
    } catch (err) {
      this.logger.warn(
        `MediaMTX boot re-arm skipped (API ${this.config.mediamtxApiUrl} unreachable): ${(err as Error).message}`,
      );
      return;
    }
    let pull = 0;
    let fwd = 0;
    for (const item of items) {
      if (!item?.ready || !item.name) continue;
      const cls = classifyMediamtxPath(item.name);
      try {
        if (cls.kind === 'passthrough') {
          if (this.passthrough.handlePublish(cls.app, cls.key).accepted) pull += 1;
        } else if (cls.kind === 'livekit') {
          this.passthrough.handleForwardPublish(cls.key);
          fwd += 1;
        }
      } catch (err) {
        this.logger.warn(
          `MediaMTX re-arm of "${item.name}" failed: ${(err as Error).message}`,
        );
      }
    }
    if (pull > 0 || fwd > 0) {
      this.logger.log(
        `re-armed ${pull} pull remux(es) + ${fwd} forward(s) from MediaMTX`,
      );
    }
  }

  /** Page through the MediaMTX `/v3/paths/list` API (short timeout per request). */
  private async fetchMediamtxPaths(): Promise<MediamtxPathItem[]> {
    const base = this.config.mediamtxApiUrl.replace(/\/+$/, '');
    const items: MediamtxPathItem[] = [];
    for (let page = 0; page < MEDIAMTX_API_MAX_PAGES; page += 1) {
      const url = `${base}/v3/paths/list?page=${page}&itemsPerPage=100`;
      const body = (await this.getJson(url)) as MediamtxPathsPage;
      for (const it of body?.items ?? []) items.push(it);
      const pageCount =
        typeof body?.pageCount === 'number' ? body.pageCount : 1;
      if (page + 1 >= pageCount) break;
    }
    return items;
  }

  /** GET + JSON-parse with an AbortController timeout. Throws on non-2xx/timeout. */
  private async getJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MEDIAMTX_API_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  private safeListAuth(app: string) {
    try {
      return this.ingressAuth.listPassthrough(app);
    } catch {
      return [];
    }
  }

  private safeList(app: string) {
    try {
      return this.passthrough.list(app);
    } catch {
      return [];
    }
  }
}
