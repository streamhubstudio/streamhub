import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

import { ConfigService } from '../../shared/config/config.service';
import { DbService } from '../../shared/db/db.service';
import { AppConfig } from '../../shared/contracts';
import { AppsService } from '../apps/apps.service';
import { AppPluginsRepository } from '../plugins/app-plugins.repository';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import type { PluginCategory, PluginKind } from '../plugins/plugin.contract';
import { HwAccelService } from '../system/hwaccel.service';
import type { HwaccelMode } from '../system/gpu.types';
import { VisionAppService } from '../vision-apps/vision.service';
import { NotifierService } from '../notifications/notifier.service';
import { NetMetricsService } from '../net-metrics/net-metrics.service';
import { PassthroughService } from '../passthrough/passthrough.service';

/**
 * Ingest node kinds of the resolved pipeline. NOTE: `url` is part of the wire
 * contract but the shipped topology folds URL pull into the `rtsp` node — the
 * LiveKit URL ingress (`inputType: url`, rtsp/http/srt sources) records its
 * live streams as `type: 'rtsp'`, so one node carries both the capability and
 * the live hint (two nodes would double-animate a single media path). `srt` is
 * the passthrough-plane SRT front (remux, no transcode) — enabled only when the
 * RTMP/SRT passthrough plane is on.
 */
export type PipelineIngestType =
  | 'rtmp'
  | 'rtmps'
  | 'whip'
  | 'webrtc'
  | 'rtsp'
  | 'url'
  | 'ws-mjpeg'
  | 'srt'
  | 'mpegts';

/** Transports the remux/`-c copy` passthrough plane can accept. */
export type PassthroughTransport = 'rtmp' | 'srt' | 'mpegts';

export type PipelineDeliveryType = 'webrtc' | 'hls' | 'cdn' | 'restream';

/** One ingest/delivery endpoint of the flow diagram. */
export interface PipelineEndpoint<T extends string = string> {
  type: T;
  /** Capability is switched on (config.yaml / env). */
  enabled: boolean;
  /** A live media flow is riding this endpoint right now (lightweight hint). */
  active: boolean;
  /** Human node label for the diagram. */
  label: string;
  /** Optional secondary line (never a secret/credential). */
  detail?: string;
}

/**
 * Resolved media-pipeline topology of one app
 * (`GET /apps/:app/pipeline`) — config.yaml is the source of truth, the
 * per-app `streams` table + on-disk HLS playlists provide the live hints.
 * Shape is a STABLE frontend contract (animated flow diagram): every section
 * is always present, nodes keep a fixed order.
 */
export interface AppPipeline {
  ingest: PipelineEndpoint<PipelineIngestType>[];
  /**
   * Front-door router in front of ingest: the MediaMTX single-port :1935 switch
   * (features/rtmp-single-port). When on, one MediaMTX owns the public RTMP port
   * and routes `live/*` → LiveKit vs `<app>/<key>` → passthrough.
   */
  ingestFront: {
    mediamtx: boolean;
    /** Public RTMP port MediaMTX owns (only meaningful when `mediamtx`). */
    port: number;
  };
  processing: {
    transcoding: {
      enabled: boolean;
      /** Effective encoder after GPU detection (never 'auto'). */
      encoder: 'gpu' | 'cpu';
      /** Configured per-app preference (transcoding.json sidecar / env default). */
      hwaccel: HwaccelMode;
    };
    adaptive: {
      enabled: boolean;
      layers: { name: string; height: number }[];
    };
    /**
     * Remux / `-c copy` plane (no transcode), parallel to transcoding+adaptive:
     * the RTMP/SRT passthrough front. `transports` are the accepted protocols.
     */
    passthrough: {
      enabled: boolean;
      transports: PassthroughTransport[];
    };
  };
  /**
   * Distributed inference fleet (edge/common vision nodes) + the app's ENABLED
   * vision models and their assignment backlog. Sourced from VisionService —
   * empty/idle when the vision plugin is not installed.
   */
  compute: {
    edge: {
      /** Registered inference nodes (common + edge). */
      total: number;
      /** Nodes seen within the heartbeat window. */
      online: number;
    };
    vision: {
      enabled: boolean;
      /** Enabled model ids for this app (e.g. ['object','face']). */
      models: string[];
      assignments: { running: number; pending: number };
    };
  };
  delivery: PipelineEndpoint<PipelineDeliveryType>[];
  storage: {
    recording: {
      enabled: boolean;
      /** Present only when > 0 (recording split into N-minute parts). */
      splitMinutes?: number;
      /** Present only when > 0 (periodic JPEG snapshots). */
      snapshotSeconds?: number;
    };
    s3: {
      /** Real credentials exist (env / data/secrets.json). Values never leak. */
      configured: boolean;
      /** Bucket name when set in config.yaml (name only — no keys/endpoints). */
      bucket?: string;
    };
  };
  /** Installed plugins of the app (app_plugins) with their soft switch + meta. */
  plugins: PipelinePlugin[];
  live: {
    activeStreams: number;
    /** Omitted: a live viewer count needs per-room LiveKit dials (not cheap). */
    viewers?: number;
    /** Distinct tag slugs applied across the app's active streams. */
    tags: string[];
  };
  /**
   * Event fan-out taps. Booleans / presence only — NEVER a url, secret, token or
   * broker host. `log` is always on (every event lands in the app log).
   */
  events: {
    callbacks: { configured: boolean };
    mqtt: { enabled: boolean };
    log: { enabled: boolean };
  };
  /**
   * Resolved notification channels (global defaults merged with the per-app
   * `notifications:` block). Booleans only — never the webhooks/tokens/addresses.
   */
  notifications: { email: boolean; discord: boolean; telegram: boolean };
  /** Rolling network I/O of the app over `windowSec` seconds (bytes). */
  net: { inBytes: number; outBytes: number; windowSec: number };
}

/** Installed-plugin entry enriched with its registry metadata. */
export interface PipelinePlugin {
  id: string;
  enabled: boolean;
  /** 'app' (Studio App) vs 'plugin' (in-process extension); default 'plugin'. */
  kind: PluginKind;
  /** Grouping category: tool | processor | panel. */
  category: PluginCategory;
}

/** Live-stream hints read straight from the app db (no LiveKit dials). */
interface LiveHints {
  total: number;
  byType: Record<string, number>;
  /** Distinct rooms with at least one active stream. */
  rooms: string[];
  /** Distinct tag slugs across active streams. */
  tags: string[];
}

const NO_HINTS: LiveHints = { total: 0, byType: {}, rooms: [], tags: [] };

/**
 * Resolves an app's media-pipeline topology (feature `pipeline`).
 *
 * Sources, in order of authority:
 *  - `AppsService.getConfig` — the resolved config.yaml (rtmp/webrtc/
 *    transcoding/recording/s3/features blocks). Unknown app ⇒ 404 from here.
 *  - `HwAccelService` — per-app hwaccel preference + live GPU detection, so
 *    `encoder` reports what the media path will ACTUALLY use (cpu fallback).
 *  - per-app `streams` table — cheap `status='active'` counts per StreamType
 *    drive every `active` flag. No reconcile / LiveKit round-trips: this is a
 *    lightweight hint, not a source of truth.
 *  - on-disk HLS playlists (`apps/<app>/hls/<room>/index.m3u8`) for rooms that
 *    are live right now ⇒ the HLS delivery edge animates.
 *
 * Every live probe is failure-proof: a DB/fs hiccup degrades to inactive
 * hints, never a 500 (config errors still surface — they ARE the contract).
 */
@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly db: DbService,
    private readonly apps: AppsService,
    private readonly hwaccel: HwAccelService,
    private readonly plugins: AppPluginsRepository,
    private readonly registry: PluginRegistryService,
    private readonly vision: VisionAppService,
    private readonly notifier: NotifierService,
    private readonly netMetrics: NetMetricsService,
    private readonly passthrough: PassthroughService,
  ) {}

  /** Resolved pipeline topology for one app. 404s on unknown app. */
  async get(appName: string): Promise<AppPipeline> {
    const cfg = await this.apps.getConfig(appName); // throws 404 when unknown
    const hints = this.liveHints(appName);

    return {
      ingest: this.ingest(cfg, hints),
      ingestFront: {
        mediamtx: this.config.mediamtxEnable,
        port: this.config.mediamtxRtmpPort,
      },
      processing: await this.processing(appName, cfg),
      compute: await this.compute(appName),
      delivery: this.delivery(appName, cfg, hints),
      storage: PipelineService.storage(cfg),
      plugins: this.installedPlugins(appName),
      live: { activeStreams: hints.total, tags: hints.tags },
      events: PipelineService.events(cfg),
      notifications: this.notifier.channelsFor(appName),
      net: this.net(appName),
    };
  }

  // ---------------------------------------------------------------------------
  // Sections
  // ---------------------------------------------------------------------------

  private ingest(
    cfg: AppConfig,
    hints: LiveHints,
  ): PipelineEndpoint<PipelineIngestType>[] {
    const live = (t: string): boolean => (hints.byType[t] ?? 0) > 0;
    const rtmpEnabled = !!cfg.rtmp.enabled;
    // RTMPS is a global TLS front (stunnel → :1935); it only exists when the
    // operator enabled it AND the app accepts RTMP at all.
    const rtmpsEnabled = rtmpEnabled && this.config.rtmpsEnable;
    const rtmpHost = this.config.rtmpPublicHost;
    const rtmpsHost = this.config.rtmpsPublicHost || rtmpHost;
    // ws_ingest resolves with defaults (enabled) — only an explicit false gates.
    const wsEnabled = cfg.features.wsIngest?.enabled !== false;

    return [
      {
        type: 'rtmp',
        enabled: rtmpEnabled,
        active: live('rtmp'),
        label: 'RTMP',
        detail: rtmpHost
          ? `rtmp://${rtmpHost}:1935`
          : 'RTMP ingest on port 1935',
      },
      {
        type: 'rtmps',
        enabled: rtmpsEnabled,
        // RTMPS terminates into the same RTMP ingress, so its streams are
        // recorded as type 'rtmp' — when the TLS front is on, mirror that hint.
        active: rtmpsEnabled && live('rtmp'),
        label: 'RTMPS',
        detail: rtmpsEnabled
          ? `rtmps://${rtmpsHost || '<host>'}:${this.config.rtmpsPort} (TLS front → RTMP :1935)`
          : 'STREAMHUB_RTMPS_ENABLE off',
      },
      {
        type: 'whip',
        enabled: true,
        active: live('whip'),
        label: 'WHIP',
        detail: 'WebRTC-HTTP ingest (port 8080)',
      },
      {
        type: 'webrtc',
        enabled: true,
        active: live('webrtc'),
        label: 'WebRTC publish',
        detail: 'LiveKit SFU (/rtc)',
      },
      {
        type: 'rtsp',
        enabled: true,
        active: live('rtsp'),
        label: 'RTSP / URL pull',
        detail: 'URL ingress — pulls a remote rtsp/http/hls/srt source',
      },
      {
        type: 'ws-mjpeg',
        enabled: wsEnabled,
        active: live('ws-mjpeg'),
        label: 'WS MJPEG (ESP32)',
        detail: '/ingest/ws gateway',
      },
      {
        // SRT rides the remux/`-c copy` passthrough plane — enabled only when
        // that plane is on (global switch). Always present so the array shape
        // stays stable; the frontend renders it only while enabled.
        type: 'srt',
        enabled: this.passthrough.enabled(),
        active: this.passthrough.enabled() && live('srt'),
        label: 'SRT',
        detail: this.passthrough.enabled()
          ? 'SRT passthrough (remux, -c copy)'
          : 'STREAMHUB_RTMP_PASSTHROUGH_ENABLE off',
      },
      {
        // MPEG-TS over UDP (unicast + multicast) PULL — rides the same remux/
        // `-c copy` passthrough plane as SRT (enabled only when it is on). The
        // passthrough sync mirrors these as `rtmp`-typed stream rows, so live is
        // read off the mpegts hint when present.
        type: 'mpegts',
        enabled: this.passthrough.enabled(),
        active: this.passthrough.enabled() && live('mpegts'),
        label: 'MPEG-TS / UDP',
        detail: this.passthrough.enabled()
          ? 'MPEG-TS multicast PULL (remux, -c copy)'
          : 'STREAMHUB_RTMP_PASSTHROUGH_ENABLE off',
      },
    ];
  }

  private async processing(
    appName: string,
    cfg: AppConfig,
  ): Promise<AppPipeline['processing']> {
    // resolve() is failure-proof (CPU fallback) and implements exactly
    // "gpu when hwaccel is gpu/auto AND a GPU is detected, else cpu".
    const decision = await this.hwaccel.resolve(appName);
    return {
      transcoding: {
        // AppsService always resolves the block; keep the legacy mirror as a
        // defensive fallback for contract-typed callers.
        enabled: cfg.transcoding?.enabled ?? !!cfg.rtmp.transcode,
        encoder: decision.effective,
        hwaccel: this.hwaccel.getMode(appName),
      },
      adaptive: {
        enabled: !!cfg.webrtc.adaptive,
        layers: (cfg.webrtc.layers ?? []).map((l) => ({
          name: l.name,
          height: l.height,
        })),
      },
      passthrough: this.passthroughPlane(appName),
    };
  }

  /**
   * Remux / `-c copy` passthrough plane: enabled from the global switch, its
   * accepted transports derived from the app's configured passthrough ingresses
   * (falling back to the plane's full capability set when none exist yet).
   * Failure-proof — a state read hiccup degrades to the capability set.
   */
  private passthroughPlane(appName: string): AppPipeline['processing']['passthrough'] {
    const enabled = this.passthrough.enabled();
    if (!enabled) return { enabled: false, transports: [] };
    const set = new Set<PassthroughTransport>();
    try {
      for (const ig of this.passthrough.list(appName)) {
        if (
          ig.inputType === 'rtmp' ||
          ig.inputType === 'srt' ||
          ig.inputType === 'mpegts'
        ) {
          set.add(ig.inputType);
        }
      }
    } catch (err) {
      this.logger.debug(
        `passthrough list unavailable for "${appName}": ${(err as Error).message}`,
      );
    }
    const transports: PassthroughTransport[] = set.size
      ? [...set].sort()
      : ['mpegts', 'rtmp', 'srt'];
    return { enabled, transports };
  }

  /**
   * Distributed inference fleet + the app's enabled vision models, from
   * VisionAppService.pipelineVision (aggregated across the four vision apps).
   * Failure-proof: an unavailable/uninstalled vision stack degrades to an empty
   * idle compute section (never a 500).
   */
  private async compute(appName: string): Promise<AppPipeline['compute']> {
    try {
      const v = this.vision.pipelineVision(appName);
      return {
        edge: { total: v.edge.total, online: v.edge.online },
        vision: {
          enabled: v.enabledModels.length > 0,
          models: v.enabledModels,
          assignments: {
            running: v.assignments.running,
            pending: v.assignments.pending,
          },
        },
      };
    } catch (err) {
      this.logger.debug(
        `compute overview unavailable for "${appName}": ${(err as Error).message}`,
      );
      return {
        edge: { total: 0, online: 0 },
        vision: { enabled: false, models: [], assignments: { running: 0, pending: 0 } },
      };
    }
  }

  /**
   * Event fan-out taps — booleans/presence only, no url/secret/token ever. `log`
   * is always on (every event lands in the rotated app log).
   */
  private static events(cfg: AppConfig): AppPipeline['events'] {
    return {
      callbacks: { configured: !!(cfg.callbacks?.url ?? '').trim() },
      mqtt: { enabled: !!cfg.mqtt?.enabled },
      log: { enabled: true },
    };
  }

  /**
   * Rolling network I/O of the app over the last hour (bytes in/out), from the
   * per-app `net_samples` hour buckets. Best-effort → zeros on any read error.
   */
  private net(appName: string): AppPipeline['net'] {
    const windowSec = 3600;
    try {
      const buckets = this.netMetrics.history(appName, 1);
      let inBytes = 0;
      let outBytes = 0;
      for (const b of buckets) {
        inBytes += b.in;
        outBytes += b.out;
      }
      return { inBytes, outBytes, windowSec };
    } catch (err) {
      this.logger.debug(
        `net summary unavailable for "${appName}": ${(err as Error).message}`,
      );
      return { inBytes: 0, outBytes: 0, windowSec };
    }
  }

  /**
   * Restream destination counts for the app (config'd = non-stopped, live =
   * starting/active) read straight from the per-app `restream_targets` table.
   * Read via DbService — NOT RestreamModule — to avoid the
   * PipelineModule → RestreamModule → StreamsModule → PipelineModule cycle.
   * Counts only: no URLs/keys/platforms ever leave this method.
   */
  private restreamTargets(appName: string): { configured: number; live: number } {
    try {
      const adb = this.db.appDb(appName);
      const configured =
        (adb
          .prepare(
            "SELECT COUNT(*) AS n FROM restream_targets WHERE status != 'stopped'",
          )
          .get() as { n: number } | undefined)?.n ?? 0;
      const live =
        (adb
          .prepare(
            "SELECT COUNT(*) AS n FROM restream_targets WHERE status IN ('starting','active')",
          )
          .get() as { n: number } | undefined)?.n ?? 0;
      return { configured, live };
    } catch (err) {
      this.logger.debug(
        `restream count unavailable for "${appName}": ${(err as Error).message}`,
      );
      return { configured: 0, live: 0 };
    }
  }

  private delivery(
    appName: string,
    cfg: AppConfig,
    hints: LiveHints,
  ): PipelineEndpoint<PipelineDeliveryType>[] {
    // Two CDN knobs exist: the per-app s3.public_url (VOD/HLS objects served
    // from a public/CDN base instead of presigned URLs) and the global
    // STREAMHUB_HLS_CDN env (CDN-cacheable /hls playlist headers — same truthy
    // grammar as main.ts / ConfigService.bool). Neither set ⇒ disabled.
    const cdnBase = (cfg.s3.publicUrl ?? '').trim();
    const hlsCdn = /^(1|true|on|yes)$/i.test(
      (this.config.env('STREAMHUB_HLS_CDN') ?? '').trim(),
    );
    const hlsLive = this.hlsActive(appName, hints.rooms);
    const cdnDetail = [
      ...(cdnBase ? [cdnBase] : []),
      ...(hlsCdn ? ['CDN-cacheable live HLS (STREAMHUB_HLS_CDN on)'] : []),
    ].join(' + ');
    const restream = this.restreamTargets(appName);
    return [
      {
        type: 'webrtc',
        enabled: true,
        active: hints.total > 0,
        label: 'WebRTC playback',
        detail: 'LiveKit SFU (/rtc)',
      },
      {
        type: 'hls',
        enabled: true,
        active: hlsLive,
        label: 'HLS',
        detail: '/hls/<app>/<room>/index.m3u8 (on-demand live egress)',
      },
      {
        type: 'cdn',
        enabled: hlsCdn || cdnBase.length > 0,
        // Only the HLS edge cache carries a LIVE flow; the s3 public base is a
        // VOD path (no live signal).
        active: hlsCdn && hlsLive,
        label: 'CDN / public URL',
        ...(cdnDetail ? { detail: cdnDetail } : {}),
      },
      {
        // Egress re-push to external RTMP(S)/SRT platforms. Count only — the
        // destination URLs/keys never leave the server. Always present (stable
        // array); enabled only when the app has non-stopped targets.
        type: 'restream',
        enabled: restream.configured > 0,
        active: restream.live > 0,
        label: 'Restream',
        ...(restream.configured > 0
          ? {
              detail: `${restream.configured} ${restream.configured === 1 ? 'target' : 'targets'}`,
            }
          : {}),
      },
    ];
  }

  private static storage(cfg: AppConfig): AppPipeline['storage'] {
    const split = Number(cfg.recording.splitMinutes ?? 0) || 0;
    const snap = Number(cfg.recording.snapshotSeconds ?? 0) || 0;
    const bucket = (cfg.s3.bucket ?? '').trim();
    return {
      recording: {
        enabled: !!cfg.recording.enabled,
        ...(split > 0 ? { splitMinutes: split } : {}),
        ...(snap > 0 ? { snapshotSeconds: snap } : {}),
      },
      s3: {
        // Same semantics as the masked S3 getter: both credentials resolve.
        configured: !!cfg.s3.accessKey && !!cfg.s3.secretKey,
        ...(bucket ? { bucket } : {}),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Live hints (failure-proof)
  // ---------------------------------------------------------------------------

  /** Active-stream counts per type + distinct live rooms, from the app db. */
  private liveHints(appName: string): LiveHints {
    try {
      const rows = this.db
        .appDb(appName)
        .prepare(
          "SELECT type, room, tags FROM streams WHERE status = 'active'",
        )
        .all() as { type: string; room: string | null; tags: string | null }[];
      const byType: Record<string, number> = {};
      const rooms = new Set<string>();
      const tags = new Set<string>();
      for (const r of rows) {
        byType[r.type] = (byType[r.type] ?? 0) + 1;
        if (r.room) rooms.add(r.room);
        // `tags` is a JSON array of tag slugs (streams migration #12).
        if (r.tags) {
          try {
            const arr = JSON.parse(r.tags);
            if (Array.isArray(arr)) {
              for (const s of arr) if (typeof s === 'string' && s) tags.add(s);
            }
          } catch {
            /* malformed tags column → skip this row's tags */
          }
        }
      }
      return { total: rows.length, byType, rooms: [...rooms], tags: [...tags] };
    } catch (err) {
      this.logger.debug(
        `live hints unavailable for "${appName}": ${(err as Error).message}`,
      );
      return NO_HINTS;
    }
  }

  /**
   * Whether a live HLS playlist exists for any room that is active right now
   * (same on-disk layout + slug as HlsService: apps/<app>/hls/<slug>/index.m3u8).
   * Playlists of rooms that are no longer live are treated as stale leftovers.
   */
  private hlsActive(appName: string, rooms: string[]): boolean {
    try {
      const base = path.join(this.apps.appDir(appName), 'hls');
      return rooms.some((room) =>
        fs.existsSync(
          path.join(base, PipelineService.slug(room), 'index.m3u8'),
        ),
      );
    } catch {
      return false;
    }
  }

  /**
   * Installed plugins (id + soft switch) enriched with their registry meta
   * (`kind`, `category`) so the diagram can split Studio Apps from processors/
   * tools. Unknown-to-the-registry ids fall back to plugin/tool defaults.
   * Missing table ⇒ empty list.
   */
  private installedPlugins(appName: string): PipelinePlugin[] {
    try {
      return this.plugins.list(appName).map((p) => {
        const meta = this.registry.getMeta(p.pluginId);
        return {
          id: p.pluginId,
          enabled: p.enabled,
          kind: meta?.kind ?? 'plugin',
          category: meta?.category ?? 'tool',
        };
      });
    } catch (err) {
      this.logger.debug(
        `plugin list unavailable for "${appName}": ${(err as Error).message}`,
      );
      return [];
    }
  }

  /** Filesystem-safe room segment — MUST match HlsService.safe. */
  private static slug(s: string): string {
    return s.replace(/[^a-zA-Z0-9_-]/g, '_');
  }
}
