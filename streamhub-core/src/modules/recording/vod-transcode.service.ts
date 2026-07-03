import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { Job, Queue, Worker } from 'bullmq';

import { ConfigService } from '../../shared/config/config.service';
import {
  APPS_SERVICE,
  AppConfig,
  AppsServiceContract,
  CALLBACKS_SERVICE,
  CallbacksServiceContract,
  LOGS_SERVICE,
  LogsServiceContract,
  S3_SERVICE,
  S3ServiceContract,
  VodRendition,
} from '../../shared/contracts';
import { VodsRepository } from './vods.repository';
import {
  VodVariantRecord,
  VodVariantsRepository,
} from './vod-variants.repository';
import { probeMedia } from './media.util';
import {
  bitrateForHeight,
  buildMasterPlaylist,
  hlsContentType,
  resolveVodRenditions,
  transcodeHlsRendition,
  transcodeWebmVp8,
  widthForHeight,
} from './vod-transcode.util';
import { bullConnectionOptions } from './bull-conn.util';

// BullMQ v5 forbids ':' in queue names.
const QUEUE_NAME = 'streamhub-vod-transcode';
const TRANSCODE_JOB = 'transcode-vod';

/** What the app config asks the pipeline to produce for a recording. */
export interface TranscodePlan {
  /** HLS ladder (adaptive VOD). Empty = no HLS post-transcode. */
  renditions: VodRendition[];
  /** Whether to also generate a WebM/VP8 alternate (encoding h264+vp8). */
  webm: boolean;
}

/** Payload enqueued after the source MP4 finished uploading to S3. */
export interface TranscodeJobData {
  appName: string;
  vodId: number;
  /** Local path of the source MP4 the egress produced. */
  sourcePath: string;
  /**
   * Honor recording.delete_local_after_upload: the upload job DEFERS the local
   * delete to this job (the transcode needs the source), so when true the
   * source is removed — and vods.local_path nulled — once variants are done.
   */
  deleteSourceAfter: boolean;
}

/**
 * VOD post-transcode pipeline (ffmpeg, BullMQ queue `streamhub-vod-transcode`).
 *
 * The LiveKit egress natively produces ONE MP4/H.264 file per recording — it
 * cannot emit VP8/WebM nor a multi-rendition ladder. Everything beyond that
 * single MP4 is generated here, server-side, from the local source file:
 *
 *  - `transcoding.vod_adaptive` → one HLS rendition per ladder step
 *    (`hls/<base>/<height>p/index.m3u8` + segments) plus a master playlist
 *    (`hls/<base>/master.m3u8`), all uploaded to the app's S3 and registered
 *    as `vod_variants` rows (kinds rendition/master).
 *  - `transcoding.encoding: h264+vp8` → a `<base>.webm` (VP8/Opus) alternate
 *    (kind alternate).
 *
 * Variants are strictly best-effort: the base MP4 VOD is already `ready` when
 * this runs, and a transcode failure NEVER degrades it (logged + recorded in
 * metatags instead). Fires `vod_variants_ready` when at least one variant
 * landed.
 */
@Injectable()
export class VodTranscodeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VodTranscodeService.name);
  private queue?: Queue<TranscodeJobData>;
  private worker?: Worker<TranscodeJobData>;

  constructor(
    private readonly config: ConfigService,
    private readonly vods: VodsRepository,
    private readonly variants: VodVariantsRepository,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
    @Inject(S3_SERVICE) private readonly s3: S3ServiceContract,
    @Inject(LOGS_SERVICE) private readonly logs: LogsServiceContract,
    @Inject(CALLBACKS_SERVICE)
    private readonly callbacks: CallbacksServiceContract,
  ) {}

  onModuleInit(): void {
    try {
      const connection = bullConnectionOptions(this.config.redisUrl);
      const queue = new Queue<TranscodeJobData>(QUEUE_NAME, {
        connection,
        defaultJobOptions: { attempts: 1, removeOnComplete: 200, removeOnFail: 500 },
      });
      queue.on('error', (e) =>
        this.logger.warn(`transcode queue error: ${e.message}`),
      );
      const worker = new Worker<TranscodeJobData>(
        QUEUE_NAME,
        async (job: Job<TranscodeJobData>) => this.processJob(job.data),
        {
          connection: bullConnectionOptions(this.config.redisUrl),
          // ffmpeg is CPU-heavy — never transcode two VODs concurrently.
          concurrency: 1,
        },
      );
      worker.on('error', (e) =>
        this.logger.warn(`transcode worker error: ${e.message}`),
      );
      worker.on('failed', (job, e) =>
        this.logger.error(
          `transcode job ${job?.id ?? '?'} failed: ${e?.message ?? e}`,
        ),
      );
      this.queue = queue;
      this.worker = worker;
      this.logger.log(`vod transcode queue ready (${QUEUE_NAME})`);
    } catch (e) {
      // Never crash on boot — recordings still work; variants just won't run.
      this.logger.error(
        `failed to init vod transcode queue: ${(e as Error).message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.safeClose(() => this.worker?.close());
    await this.safeClose(() => this.queue?.close());
  }

  // ---- plan --------------------------------------------------------------

  /**
   * Resolve the transcode plan for an app config. Everything is gated on the
   * `transcoding.enabled` master switch (default false = passthrough).
   */
  planFor(cfg: AppConfig): TranscodePlan {
    const t = cfg.transcoding;
    if (!t?.enabled) return { renditions: [], webm: false };
    return {
      renditions: t.vodAdaptive ? resolveVodRenditions(cfg) : [],
      webm: t.encoding === 'h264+vp8',
    };
  }

  /** Whether the app config requires any post-transcode work at all. */
  needed(cfg: AppConfig): boolean {
    const plan = this.planFor(cfg);
    return plan.renditions.length > 0 || plan.webm;
  }

  // ---- queue -------------------------------------------------------------

  /** Enqueue a transcode job (falls back to inline when the queue is down). */
  async enqueue(data: TranscodeJobData): Promise<void> {
    if (!this.queue) {
      this.logger.warn('transcode queue unavailable; processing inline');
      await this.processJob(data);
      return;
    }
    try {
      await this.queue.add(TRANSCODE_JOB, data, {
        jobId: `vod-variants-${data.appName}-${data.vodId}`,
      });
      this.logs.write('info', 'recording', 'vod transcode job enqueued', {
        appName: data.appName,
        vodId: data.vodId,
      });
    } catch (e) {
      this.logger.error(
        `transcode enqueue failed, processing inline: ${(e as Error).message}`,
      );
      await this.processJob(data);
    }
  }

  // ---- the job -----------------------------------------------------------

  /** @internal exposed for the worker + inline fallback. */
  async processJob(data: TranscodeJobData): Promise<void> {
    const { appName, vodId, sourcePath, deleteSourceAfter } = data;
    const vod = this.vods.findById(appName, vodId);
    if (!vod) {
      this.logger.warn(`transcode job: vod ${vodId} (${appName}) missing`);
      return;
    }
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      this.logs.write('error', 'recording', 'transcode source missing', {
        appName,
        vodId,
        sourcePath: sourcePath ?? '(null)',
      });
      return;
    }

    let cfg: AppConfig;
    try {
      cfg = await this.apps.getConfig(appName);
    } catch (e) {
      this.logs.write('error', 'recording', 'transcode config load failed', {
        appName,
        vodId,
        error: (e as Error).message,
      });
      return;
    }

    const plan = this.planFor(cfg);
    const base = path.basename(sourcePath, path.extname(sourcePath));
    const workDir = path.join(this.apps.appDir(appName), 'transcode', base);

    try {
      if (plan.renditions.length === 0 && !plan.webm) return;
      fs.mkdirSync(workDir, { recursive: true });
      const media = await probeMedia(sourcePath);

      // --- 1. HLS ladder (adaptive VOD) ---------------------------------
      let masterKey: string | null = null;
      const okRenditions: (VodRendition & { dir: string })[] = [];
      for (const r of plan.renditions) {
        const dir = path.join(workDir, `${r.height}p`);
        const ok = await transcodeHlsRendition(sourcePath, dir, r);
        if (!ok || !fs.existsSync(path.join(dir, 'index.m3u8'))) {
          this.logs.write('warn', 'recording', 'hls rendition failed', {
            appName,
            vodId,
            height: r.height,
          });
          continue;
        }
        okRenditions.push({ ...r, dir });
      }

      for (const r of okRenditions) {
        const files = fs
          .readdirSync(r.dir)
          .filter((f) => f.endsWith('.m3u8') || f.endsWith('.ts'))
          .sort();
        const playlistKey = `hls/${base}/${r.height}p/index.m3u8`;
        const segmentKeys: string[] = [];
        let sizeBytes = 0;
        for (const f of files) {
          const key = `hls/${base}/${r.height}p/${f}`;
          const up = await this.s3.upload(
            cfg.s3,
            path.join(r.dir, f),
            key,
            hlsContentType(f),
          );
          sizeBytes += up.sizeBytes;
          if (key !== playlistKey) segmentKeys.push(key);
        }
        this.variants.insert(appName, {
          vodId,
          kind: 'rendition',
          format: 'hls-h264',
          height: r.height,
          bitrateKbps: r.bitrateKbps,
          fileKey: playlistKey,
          sizeBytes,
          extraJson: JSON.stringify({ segmentKeys }),
        });
      }

      if (okRenditions.length > 0) {
        const master = buildMasterPlaylist(
          okRenditions.map((r) => ({
            uri: `${r.height}p/index.m3u8`,
            height: r.height,
            bitrateKbps: r.bitrateKbps,
            width: widthForHeight(r.height, media.width, media.height),
          })),
        );
        const masterLocal = path.join(workDir, 'master.m3u8');
        fs.writeFileSync(masterLocal, master, 'utf8');
        masterKey = `hls/${base}/master.m3u8`;
        const up = await this.s3.upload(
          cfg.s3,
          masterLocal,
          masterKey,
          'application/vnd.apple.mpegurl',
        );
        this.variants.insert(appName, {
          vodId,
          kind: 'master',
          format: 'hls',
          fileKey: masterKey,
          sizeBytes: up.sizeBytes,
        });
      }

      // --- 2. WebM/VP8 alternate (encoding h264+vp8) ---------------------
      let webmKey: string | null = null;
      if (plan.webm) {
        const webmLocal = path.join(workDir, `${base}.webm`);
        const kbps =
          okRenditions[0]?.bitrateKbps ??
          (media.height ? bitrateForHeight(media.height) : 2500);
        const ok = await transcodeWebmVp8(sourcePath, webmLocal, kbps);
        if (ok && fs.existsSync(webmLocal)) {
          webmKey = `${base}.webm`;
          const up = await this.s3.upload(
            cfg.s3,
            webmLocal,
            webmKey,
            'video/webm',
          );
          this.variants.insert(appName, {
            vodId,
            kind: 'alternate',
            format: 'webm-vp8',
            height: media.height,
            bitrateKbps: kbps,
            fileKey: webmKey,
            sizeBytes: up.sizeBytes,
          });
        } else {
          this.logs.write('warn', 'recording', 'webm/vp8 transcode failed', {
            appName,
            vodId,
          });
        }
      }

      // --- 3. bookkeeping + callback -------------------------------------
      const list = this.variants.listByVod(appName, vodId);
      if (list.length === 0) {
        this.logs.write('error', 'recording', 'vod transcode produced no variants', {
          appName,
          vodId,
        });
        return;
      }
      this.updateMeta(appName, vodId, {
        hlsMasterKey: masterKey ?? undefined,
        variantCount: list.length,
      });
      this.logs.write('info', 'recording', 'vod variants ready', {
        appName,
        vodId,
        masterKey,
        webmKey,
        variants: list.length,
      });
      await this.dispatchVariantsReady(appName, vodId, masterKey, webmKey, list);
    } catch (e) {
      // Best-effort: the base MP4 VOD stays `ready`; record the failure only.
      this.logs.write('error', 'recording', 'vod transcode failed', {
        appName,
        vodId,
        error: (e as Error).message,
      });
      this.updateMeta(appName, vodId, {
        variantsError: (e as Error).message,
      });
    } finally {
      this.removeDir(workDir);
      if (deleteSourceAfter) {
        this.removeLocal(sourcePath);
        try {
          this.vods.update(appName, vodId, { localPath: null });
        } catch {
          /* non-fatal */
        }
      }
    }
  }

  // ---- helpers -----------------------------------------------------------

  private async dispatchVariantsReady(
    appName: string,
    vodId: number,
    masterKey: string | null,
    webmKey: string | null,
    list: VodVariantRecord[],
  ): Promise<void> {
    const vod = this.vods.findById(appName, vodId);
    try {
      await this.callbacks.dispatch(appName, 'vod_variants_ready', {
        vodId,
        app: appName,
        room: vod?.room ?? null,
        streamId: vod?.streamId ?? null,
        masterKey,
        webmKey,
        variants: list.map((v) => ({
          kind: v.kind,
          format: v.format,
          height: v.height,
          bitrateKbps: v.bitrateKbps,
          key: v.fileKey,
          sizeBytes: v.sizeBytes,
        })),
      });
    } catch (e) {
      this.logger.warn(
        `callback vod_variants_ready failed: ${(e as Error).message}`,
      );
    }
  }

  /** Merge keys into the VOD's metatags_json (best-effort). */
  private updateMeta(
    appName: string,
    vodId: number,
    patch: Record<string, unknown>,
  ): void {
    try {
      const vod = this.vods.findById(appName, vodId);
      if (!vod) return;
      let meta: Record<string, unknown> = {};
      try {
        const parsed = vod.metatagsJson ? JSON.parse(vod.metatagsJson) : {};
        meta = parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        meta = {};
      }
      this.vods.update(appName, vodId, {
        metatagsJson: JSON.stringify({ ...meta, ...patch }),
      });
    } catch (e) {
      this.logger.warn(`metatags update failed: ${(e as Error).message}`);
    }
  }

  private removeDir(dir: string): void {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      this.logger.warn(`could not clean ${dir}: ${(e as Error).message}`);
    }
  }

  private removeLocal(p: string | null | undefined): void {
    if (!p) return;
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {
      this.logger.warn(`could not delete local ${p}: ${(e as Error).message}`);
    }
  }

  private async safeClose(fn: () => unknown | Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.logger.warn(`shutdown cleanup error: ${(e as Error).message}`);
    }
  }
}
