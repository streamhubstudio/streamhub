import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionOptions, Queue, Worker, Job } from 'bullmq';

import { ConfigService } from '../../shared/config/config.service';
import { DbService } from '../../shared/db/db.service';
import {
  APPS_SERVICE,
  AppConfig,
  AppsServiceContract,
  CALLBACKS_SERVICE,
  CallbackEvent,
  CallbacksServiceContract,
  LIVEKIT_SERVICE,
  LiveKitServiceContract,
  LOGS_SERVICE,
  LogsServiceContract,
  RecordingHandle,
  RecordingServiceContract,
  S3_SERVICE,
  S3ServiceContract,
  StartRecordingInput,
  VodRecord,
  VodStatus,
} from '../../shared/contracts';
import {
  SortDir,
  VodInsert,
  VodListOptions,
  VodOrderField,
  VodPatch,
  VodsRepository,
} from './vods.repository';
import {
  VodVariantKind,
  VodVariantsRepository,
} from './vod-variants.repository';
import { VodTranscodeService } from './vod-transcode.service';
import { extractSnapshot, probeMedia } from './media.util';
import { bullConnectionOptions } from './bull-conn.util';
import { MetricsService } from '../metrics/metrics.service';

// NOTE: BullMQ v5 forbids ':' in queue names (it is the redis key separator).
const QUEUE_NAME = 'streamhub-recording-upload';
const UPLOAD_JOB = 'upload-vod';
const PRESIGN_TTL_S = 7 * 24 * 3600; // 7 days
/** Download presigned-URL lifetime — short-lived (1h) attachment links. */
const DOWNLOAD_TTL_S = 3600;

/** Query accepted by {@link RecordingService.listVods} (see ListVodsDto). */
export interface ListVodsQuery {
  room?: string;
  status?: VodStatus;
  since?: string;
  until?: string;
  order?: VodOrderField;
  dir?: SortDir;
  all?: boolean;
  limit?: number;
  offset?: number;
}

/** Paginated VOD listing envelope (data + total/limit/offset). */
export interface VodPage {
  data: VodRecord[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Result of resolving a VOD download. `s3` carries a ready-to-use presigned
 * attachment URL; `local` signals the caller to serve the file via the raw
 * streaming endpoint.
 */
export type VodDownload =
  | { source: 's3'; url: string; filename: string; expiresInSeconds: number }
  | { source: 'local'; filename: string };

/** One VOD variant as exposed by GET /apps/:app/vods/:id. */
export interface VodVariantView {
  id: number;
  kind: VodVariantKind;
  /** 'hls' (master) | 'hls-h264' (rendition) | 'webm-vp8' (alternate). */
  format: string;
  height: number | null;
  bitrateKbps: number | null;
  /** S3 object key (playlist for HLS kinds, file for alternates). */
  key: string | null;
  sizeBytes: number | null;
  /**
   * Playback URL: `<s3.public_url>/<key>` when the app has a public/CDN base
   * (required for real HLS playback — segments are fetched relative to the
   * playlist), else a presigned GET for whole-file kinds, else null.
   */
  url: string | null;
}

/** VOD detail (GET /apps/:app/vods/:id): record + playback URLs + variants. */
export type VodDetail = VodRecord & {
  url: string | null;
  presignedUrl: string | null;
  publicUrl: string | null;
  /** Adaptive entry point when an HLS master playlist exists; null otherwise. */
  adaptive: { masterKey: string; masterUrl: string | null } | null;
  /** Post-transcode variants (master + renditions + alternates). */
  variants: VodVariantView[];
};

/** Payload enqueued on egress completion. */
interface UploadJobData {
  appName: string;
  vodId: number;
}

/** In-memory fast-path map egressId → owning app + vod (+ split session). */
interface EgressRef {
  appName: string;
  vodId: number;
  sessionId?: string;
}

/** Allowed split intervals (minutes) and snapshot intervals (seconds). */
const SPLIT_MINUTES_ALLOWED = new Set([0, 15, 30, 60, 90, 120]);
const SNAPSHOT_SECONDS_ALLOWED = new Set([0, 1, 30, 60, 120, 360]);

/**
 * A live recording session. Tracks the current egress part (for split rotation)
 * and the on-disk snapshot directory (for the snapshot sweeper). One session per
 * `start()`; removed on `stop()` or terminal failure.
 */
interface RecordingSession {
  id: string;
  appName: string;
  roomName: string;
  mode: 'room-composite' | 'participant';
  participantIdentity?: string;
  layout?: string;
  streamId: string;
  baseSlug: string;
  splitMinutes: number;
  snapshotSeconds: number;
  partIndex: number;
  currentVodId: number;
  currentEgressId: string;
  splitTimer?: ReturnType<typeof setInterval>;
  snapshotTimer?: ReturnType<typeof setInterval>;
  /** Local dir the egress ImageOutput writes JPEGs to. */
  snapsDir?: string;
  /** Per-part local filename prefixes used by ImageOutput. */
  snapPrefixes: string[];
  /** Snapshot basenames already uploaded (dedupe across sweeps). */
  uploadedSnaps: Set<string>;
}

/**
 * Recording orchestration (SPEC §5 recording, §8 flow).
 *
 * start → egress to local file (apps/<app>/recordings/) + VOD row `recording`.
 * egress complete webhook → onEgressEvent → mark `uploading` + enqueue job.
 * job (BullMQ) → upload mp4 to app S3 → snapshot → delete local (if configured)
 *   → VOD `ready` + metatags → callback `vod_ready`.
 * failure → VOD `failed`, local kept, log + callback `recording_failed`.
 */
@Injectable()
export class RecordingService
  implements RecordingServiceContract, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RecordingService.name);
  private queue?: Queue<UploadJobData>;
  private worker?: Worker<UploadJobData>;
  private readonly egressMap = new Map<string, EgressRef>();
  /** Active split/snapshot sessions keyed by session id. */
  private readonly sessions = new Map<string, RecordingSession>();

  constructor(
    private readonly config: ConfigService,
    private readonly db: DbService,
    private readonly vods: VodsRepository,
    private readonly vodVariants: VodVariantsRepository,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
    @Inject(LIVEKIT_SERVICE) private readonly livekit: LiveKitServiceContract,
    @Inject(S3_SERVICE) private readonly s3: S3ServiceContract,
    @Inject(LOGS_SERVICE) private readonly logs: LogsServiceContract,
    @Inject(CALLBACKS_SERVICE)
    private readonly callbacks: CallbacksServiceContract,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly vodTranscode?: VodTranscodeService,
  ) {}

  // ---- lifecycle: BullMQ wiring ----------------------------------------

  onModuleInit(): void {
    try {
      const connection = this.buildConn();
      const queue = new Queue<UploadJobData>(QUEUE_NAME, {
        connection,
        defaultJobOptions: {
          attempts: 1,
          removeOnComplete: 500,
          removeOnFail: 1000,
        },
      });
      queue.on('error', (e) =>
        this.logger.warn(`upload queue error: ${e.message}`),
      );
      const worker = new Worker<UploadJobData>(
        QUEUE_NAME,
        async (job: Job<UploadJobData>) => this.processUploadJob(job.data),
        { connection: this.buildConn(), concurrency: 2 },
      );
      worker.on('error', (e) =>
        this.logger.warn(`upload worker error: ${e.message}`),
      );
      worker.on('failed', (job, e) =>
        this.logger.error(
          `upload job ${job?.id ?? '?'} failed: ${e?.message ?? e}`,
        ),
      );
      this.queue = queue;
      this.worker = worker;
      this.logger.log(`recording upload queue ready (${QUEUE_NAME})`);
    } catch (e) {
      // Never crash on boot — recording start still works; jobs just won't run.
      this.logger.error(
        `failed to init recording queue: ${(e as Error).message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.clearSession(id);
    await this.safeClose(() => this.worker?.close());
    await this.safeClose(() => this.queue?.close());
  }

  /** BullMQ connection options from REDIS_URL (shared with VodTranscodeService). */
  private buildConn(): ConnectionOptions {
    return bullConnectionOptions(this.config.redisUrl);
  }

  private async safeClose(fn: () => unknown | Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.logger.warn(`shutdown cleanup error: ${(e as Error).message}`);
    }
  }

  // ---- public API (RecordingServiceContract) ---------------------------

  async start(input: StartRecordingInput): Promise<RecordingHandle> {
    const { appName, roomName } = input;
    if (!roomName) {
      throw new BadRequestException('roomName is required');
    }

    const config = await this.loadConfig(appName);
    if (!config.recording?.enabled) {
      throw new BadRequestException(
        `recording is disabled for app '${appName}'`,
      );
    }

    const mode = config.recording.mode ?? 'room-composite';
    const streamId = input.streamId?.trim() || roomName;
    // StartRecordingInput carries no participant identity; in participant mode
    // we egress the participant whose identity == streamId (fallback room).
    const participantIdentity =
      mode === 'participant' ? streamId : undefined;

    const splitMinutes = this.normalize(
      config.recording.splitMinutes,
      SPLIT_MINUTES_ALLOWED,
    );
    const snapshotSeconds = this.normalize(
      config.recording.snapshotSeconds,
      SNAPSHOT_SECONDS_ALLOWED,
    );

    // Build the session shell first; the (first) egress part is launched into it.
    const baseSlug = `${this.slug(streamId)}-${Date.now()}`;
    const session: RecordingSession = {
      id: `${appName}:${baseSlug}`,
      appName,
      roomName,
      mode,
      participantIdentity,
      layout: config.recording.layout,
      streamId,
      baseSlug,
      splitMinutes,
      snapshotSeconds,
      partIndex: 0,
      currentVodId: 0,
      currentEgressId: '',
      snapsDir: snapshotSeconds > 0
        ? path.join(this.apps.appDir(appName), 'snapshots')
        : undefined,
      snapPrefixes: [],
      uploadedSnaps: new Set<string>(),
    };

    const part = await this.launchEgressPart(session, config);
    session.currentVodId = part.vodId;
    session.currentEgressId = part.egressId;
    this.egressMap.set(part.egressId, {
      appName,
      vodId: part.vodId,
      sessionId: session.id,
    });

    // Only retain the session when it needs ongoing work (split or snapshots).
    if (splitMinutes > 0 || snapshotSeconds > 0) {
      this.sessions.set(session.id, session);
      if (splitMinutes > 0) {
        session.splitTimer = setInterval(
          () => void this.rotate(session.id),
          splitMinutes * 60_000,
        );
      }
      if (snapshotSeconds > 0) {
        // Sweep a bit faster than the capture interval so JPEGs surface live.
        const sweepMs = Math.max(2_000, Math.min(snapshotSeconds, 30) * 1_000);
        session.snapshotTimer = setInterval(
          () => void this.sweepSnapshots(session.id),
          sweepMs,
        );
      }
    }

    this.logs.write('info', 'recording', 'recording started', {
      appName,
      vodId: part.vodId,
      egressId: part.egressId,
      room: roomName,
      mode,
      splitMinutes,
      snapshotSeconds,
    });
    this.metrics?.recordingStarted(appName);

    // Business callback: recording_started (wave-3 §4).
    await this.dispatch(appName, 'recording_started', {
      vodId: part.vodId,
      egressId: part.egressId,
      app: appName,
      room: roomName,
      streamId,
      mode,
      splitMinutes,
      snapshotSeconds,
    });

    return { vodId: part.vodId, egressId: part.egressId, status: 'recording' };
  }

  /**
   * Start one egress "part" (a single MP4) into `session` and persist its VOD
   * row. Used both for the first part and for each split rotation. Does NOT
   * register the egress→session map entry or mutate session.current* (callers
   * do, so they control ordering). Returns the new vod + egress ids.
   */
  private async launchEgressPart(
    session: RecordingSession,
    config: AppConfig,
  ): Promise<{ vodId: number; egressId: string; filename: string }> {
    const { appName, roomName, mode, participantIdentity } = session;
    const localDir = config.recording.localDir || 'recordings';
    const recordingsDir = path.join(this.apps.appDir(appName), localDir);
    const splitting = session.splitMinutes > 0;
    const partTag = splitting
      ? `-p${String(session.partIndex).padStart(3, '0')}`
      : '';
    const filename = `${session.baseSlug}${partTag}.mp4`;
    const outputFilepath = path.join(recordingsDir, filename);

    try {
      fs.mkdirSync(recordingsDir, { recursive: true });
    } catch (e) {
      throw new InternalServerErrorException(
        `cannot create recordings dir: ${(e as Error).message}`,
      );
    }

    // Snapshot ImageOutput prefix for this part (local files the egress writes).
    let snapshotFilePrefix: string | undefined;
    if (session.snapshotSeconds > 0 && session.snapsDir) {
      try {
        fs.mkdirSync(session.snapsDir, { recursive: true });
      } catch (e) {
        this.logger.warn(`cannot create snapshots dir: ${(e as Error).message}`);
      }
      const base = path.basename(filename, path.extname(filename));
      snapshotFilePrefix = path.join(session.snapsDir, `${base}_`);
      session.snapPrefixes.push(`${base}_`);
    }

    let egress;
    try {
      egress = await this.livekit.startEgress({
        appName,
        roomName,
        mode,
        participantIdentity,
        layout: config.recording.layout,
        outputFilepath,
        snapshotIntervalS:
          session.snapshotSeconds > 0 ? session.snapshotSeconds : undefined,
        snapshotFilePrefix,
      });
    } catch (e) {
      this.logs.write('error', 'recording', 'startEgress failed', {
        appName,
        roomName,
        error: (e as Error).message,
      });
      throw new InternalServerErrorException(
        `failed to start egress: ${(e as Error).message}`,
      );
    }

    const appId = await this.resolveAppId(appName);
    const startedAt = new Date().toISOString();
    const metatags = {
      egressId: egress.egressId,
      mode,
      room: roomName,
      app: appName,
      sessionId: session.id || `${appName}:pending`,
      splitMinutes: session.splitMinutes,
      snapshotSeconds: session.snapshotSeconds,
      partIndex: session.partIndex,
      isPart: splitting,
      snapshotPrefix: snapshotFilePrefix
        ? path.basename(snapshotFilePrefix)
        : undefined,
    };
    const insert: VodInsert = {
      appId,
      streamId: session.streamId,
      room: roomName,
      name: filename,
      status: 'recording',
      localPath: outputFilepath,
      startedAt,
      metatagsJson: JSON.stringify(metatags),
    };

    let vodId: number;
    try {
      vodId = this.vods.insert(appName, insert);
    } catch (e) {
      this.logs.write('error', 'recording', 'vod insert failed', {
        appName,
        egressId: egress.egressId,
        error: (e as Error).message,
      });
      await this.safeStopEgress(egress.egressId);
      throw new InternalServerErrorException(
        `failed to persist recording: ${(e as Error).message}`,
      );
    }

    // Backfill the real sessionId now that we have the first vodId.
    if (session.id) {
      try {
        this.vods.update(appName, vodId, {
          metatagsJson: JSON.stringify({ ...metatags, sessionId: session.id }),
        });
      } catch {
        /* non-fatal */
      }
    }

    return { vodId, egressId: egress.egressId, filename };
  }

  /**
   * Split rotation (wave-3 §3): stop the current part (its egress_ended drives
   * the upload + recording_part_ready) and start a fresh part in the same room.
   */
  private async rotate(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const previousEgressId = session.currentEgressId;
    try {
      let config: AppConfig;
      try {
        config = await this.loadConfig(session.appName);
      } catch (e) {
        this.logger.warn(`rotate: config load failed: ${(e as Error).message}`);
        return;
      }
      // Stop the in-flight part → upload flow runs on egress_ended.
      await this.safeStopEgress(previousEgressId);

      // Start the next part.
      session.partIndex += 1;
      const part = await this.launchEgressPart(session, config);
      session.currentVodId = part.vodId;
      session.currentEgressId = part.egressId;
      this.egressMap.set(part.egressId, {
        appName: session.appName,
        vodId: part.vodId,
        sessionId,
      });
      this.logs.write('info', 'recording', 'recording split rotated', {
        appName: session.appName,
        sessionId,
        partIndex: session.partIndex,
        vodId: part.vodId,
        egressId: part.egressId,
      });
    } catch (e) {
      this.logger.error(`rotate ${sessionId} failed: ${(e as Error).message}`);
    }
  }

  async stop(appName: string, recordingId: string): Promise<RecordingHandle> {
    const { vod, egressId } = await this.resolveRecording(appName, recordingId);

    // If this recording belongs to a live split/snapshot session, tear the
    // session down first (stops rotation, final snapshot sweep) and stop the
    // CURRENT egress part rather than a stale one.
    const sessionId =
      (this.parseMeta(vod.metatagsJson).sessionId as string | undefined) ??
      undefined;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    const liveEgressId = session?.currentEgressId || egressId;
    const liveVodId = session?.currentVodId ?? vod.id;
    if (session) {
      await this.clearSession(sessionId as string);
    }

    try {
      await this.livekit.stopEgress(liveEgressId);
    } catch (e) {
      this.logs.write('error', 'recording', 'stopEgress failed', {
        appName,
        egressId: liveEgressId,
        error: (e as Error).message,
      });
      throw new InternalServerErrorException(
        `failed to stop egress: ${(e as Error).message}`,
      );
    }

    this.logs.write('info', 'recording', 'recording stop requested', {
      appName,
      vodId: liveVodId,
      egressId: liveEgressId,
    });
    // The egress_ended webhook drives the upload flow; status unchanged here.
    return { vodId: liveVodId, egressId: liveEgressId, status: vod.status };
  }

  /**
   * Start recording for a live stream id (POST /apps/:app/streams/:id/record/start).
   * Resolves the stream's room and reuses the standard start() flow.
   */
  async startForStream(
    appName: string,
    streamId: string,
    roomName: string,
  ): Promise<RecordingHandle> {
    return this.start({ appName, roomName, streamId });
  }

  /**
   * Stop the in-progress recording of a live stream id
   * (POST /apps/:app/streams/:id/record/stop).
   */
  async stopForStream(
    appName: string,
    streamId: string,
  ): Promise<RecordingHandle> {
    const vod = this.vods.findActiveByStream(appName, streamId);
    if (!vod) {
      throw new NotFoundException(
        `no in-progress recording for stream '${streamId}'`,
      );
    }
    return this.stop(appName, String(vod.id));
  }

  /** Clamp a configured interval to its allowed set (else 0). */
  private normalize(value: number | undefined, allowed: Set<number>): number {
    const n = Number(value ?? 0) || 0;
    return allowed.has(n) ? n : 0;
  }

  /** Tear down a session: stop timers + final snapshot sweep + drop it. */
  private async clearSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.splitTimer) clearInterval(session.splitTimer);
    if (session.snapshotTimer) clearInterval(session.snapshotTimer);
    // Remove from the map BEFORE the final sweep so processUploadJob sees the
    // session as ended (→ recording_ready for the last part).
    this.sessions.delete(sessionId);
    try {
      await this.sweepSnapshots(sessionId, session);
    } catch (e) {
      this.logger.warn(`final snapshot sweep failed: ${(e as Error).message}`);
    }
  }

  /**
   * Upload any new JPEGs the egress ImageOutput wrote for a session and fire a
   * `snapshot_taken` callback per file. Best-effort; never throws.
   */
  private async sweepSnapshots(
    sessionId: string,
    sessionOverride?: RecordingSession,
  ): Promise<void> {
    const session = sessionOverride ?? this.sessions.get(sessionId);
    if (!session || !session.snapsDir || session.snapshotSeconds <= 0) return;
    let entries: string[];
    try {
      entries = fs.readdirSync(session.snapsDir);
    } catch {
      return;
    }
    const matches = entries.filter(
      (f) =>
        /\.(jpe?g)$/i.test(f) &&
        session.snapPrefixes.some((p) => f.startsWith(p)) &&
        !session.uploadedSnaps.has(f),
    );
    if (!matches.length) return;

    let cfg: AppConfig;
    try {
      cfg = await this.loadConfig(session.appName);
    } catch (e) {
      this.logger.warn(`snapshot sweep: config load failed: ${(e as Error).message}`);
      return;
    }

    for (const file of matches.sort()) {
      const local = path.join(session.snapsDir, file);
      session.uploadedSnaps.add(file); // mark first to avoid double-upload races
      try {
        const stat = fs.statSync(local);
        if (!stat.isFile() || stat.size === 0) {
          session.uploadedSnaps.delete(file);
          continue;
        }
        const uploaded = await this.s3.upload(
          cfg.s3,
          local,
          `snapshots/${file}`,
          'image/jpeg',
        );
        let url = uploaded.url;
        try {
          url = await this.s3.presignGet(cfg.s3, uploaded.key, PRESIGN_TTL_S);
        } catch {
          /* fall back to canonical url */
        }
        if (cfg.recording.deleteLocalAfterUpload) this.removeLocal(local);
        this.logs.write('info', 'recording', 'snapshot taken', {
          appName: session.appName,
          sessionId,
          key: uploaded.key,
        });
        await this.dispatch(session.appName, 'snapshot_taken', {
          app: session.appName,
          room: session.roomName,
          streamId: session.streamId,
          vodId: session.currentVodId,
          key: uploaded.key,
          url,
          sizeBytes: uploaded.sizeBytes,
        });
      } catch (e) {
        session.uploadedSnaps.delete(file); // allow a retry next sweep
        this.logger.warn(`snapshot upload ${file} failed: ${(e as Error).message}`);
      }
    }
  }

  /** Called by the livekit webhook handler on egress_updated/egress_ended. */
  async onEgressEvent(
    egressId: string,
    status: string,
    payload: unknown,
  ): Promise<void> {
    const phase = this.classifyEgressStatus(status);
    if (phase === 'progress') return; // starting/active — nothing to do yet

    const ref = await this.locate(egressId);
    if (!ref) {
      this.logger.warn(`egress event for unknown egress ${egressId}`);
      return;
    }
    const { appName, vodId } = ref;

    if (phase === 'failed') {
      await this.markFailed(
        appName,
        vodId,
        `egress ${status}`,
        this.extractEgressError(payload),
      );
      this.egressMap.delete(egressId);
      return;
    }

    // phase === 'complete'
    try {
      this.vods.update(appName, vodId, {
        status: 'uploading',
        endedAt: new Date().toISOString(),
      });
    } catch (e) {
      this.logger.warn(`could not mark uploading: ${(e as Error).message}`);
    }

    if (!this.queue) {
      // No queue (redis down at boot) — process inline so the flow still works.
      this.logger.warn('upload queue unavailable; processing inline');
      await this.processUploadJob({ appName, vodId });
      this.egressMap.delete(egressId);
      return;
    }

    try {
      await this.queue.add(
        UPLOAD_JOB,
        { appName, vodId },
        { jobId: `vod-${appName}-${vodId}` },
      );
      this.logs.write('info', 'recording', 'upload job enqueued', {
        appName,
        vodId,
        egressId,
      });
    } catch (e) {
      this.logger.error(`enqueue failed, processing inline: ${(e as Error).message}`);
      await this.processUploadJob({ appName, vodId });
    }
    this.egressMap.delete(egressId);
  }

  // ---- VOD query/maintenance (used by controller) ----------------------

  /**
   * List VODs with optional filters/ordering/paging, plus the total row count
   * of the (filtered) set. `all` returns every matching row (limit/offset
   * ignored). limit is clamped to 1..1000 (default 200), offset to >= 0.
   */
  listVods(appName: string, query: ListVodsQuery = {}): VodPage {
    const all = query.all === true;
    const limit = this.clampInt(query.limit, 200, 1, 1000);
    const offset = this.clampInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const filters = {
      room: query.room,
      status: query.status,
      since: query.since,
      until: query.until,
    };
    const listOpts: VodListOptions = {
      ...filters,
      order: query.order,
      dir: query.dir,
      all,
      limit,
      offset,
    };
    const data = this.vods.list(appName, listOpts);
    const total = this.vods.count(appName, filters);
    return {
      data,
      total,
      limit: all ? data.length : limit,
      offset: all ? 0 : offset,
    };
  }

  /**
   * Resolve a VOD download (GET /apps/:app/vods/:id/download).
   *  - 404 when the VOD row is missing.
   *  - 409 when it is not `ready`.
   *  - S3-backed (has fileKey) → a presigned attachment URL.
   *  - local-only with the file still on disk → `local` (serve via /raw).
   *  - otherwise 404 (no S3 object and no local file).
   */
  async getDownload(appName: string, id: number): Promise<VodDownload> {
    const vod = this.vods.findById(appName, id);
    if (!vod) throw new NotFoundException(`vod ${id} not found`);
    if (vod.status !== 'ready') {
      throw new ConflictException(
        `vod ${id} is not ready (status: ${vod.status})`,
      );
    }
    const filename = this.downloadFilename(vod, id);

    if (vod.fileKey) {
      const cfg = await this.loadConfig(appName);
      const url = await this.s3.presignGet(cfg.s3, vod.fileKey, DOWNLOAD_TTL_S, {
        responseContentDisposition: `attachment; filename="${filename}"`,
      });
      return { source: 's3', url, filename, expiresInSeconds: DOWNLOAD_TTL_S };
    }

    if (vod.localPath && fs.existsSync(vod.localPath)) {
      return { source: 'local', filename };
    }

    throw new NotFoundException(
      `vod ${id} has no downloadable file (no S3 object and no local recording present)`,
    );
  }

  /**
   * Descriptor for streaming a local VOD file as an attachment
   * (GET /apps/:app/vods/:id/raw). 404 when missing/absent, 409 when not ready.
   */
  openLocalRaw(
    appName: string,
    id: number,
  ): { localPath: string; filename: string; contentType: string } {
    const vod = this.vods.findById(appName, id);
    if (!vod) throw new NotFoundException(`vod ${id} not found`);
    if (vod.status !== 'ready') {
      throw new ConflictException(
        `vod ${id} is not ready (status: ${vod.status})`,
      );
    }
    if (!vod.localPath || !fs.existsSync(vod.localPath)) {
      throw new NotFoundException(`vod ${id} has no local file to stream`);
    }
    return {
      localPath: vod.localPath,
      filename: this.downloadFilename(vod, id),
      contentType: this.rawContentType(vod.localPath),
    };
  }

  /** Clamp an optional integer to [min,max], falling back when absent/NaN. */
  private clampInt(
    raw: number | undefined,
    fallback: number,
    min: number,
    max: number,
  ): number {
    if (raw === undefined || raw === null || Number.isNaN(raw)) return fallback;
    return Math.min(Math.max(Math.floor(raw), min), max);
  }

  /**
   * Build the download filename `<name|room>-<id>.<ext>`. The extension is the
   * real container extension carried by `name` (VODs are named `<slug>.mp4`),
   * falling back to `format` then `mp4`. Sanitized for filesystem/header safety.
   */
  private downloadFilename(vod: VodRecord, id: number): string {
    const rawStem =
      (vod.name && vod.name.trim()) || (vod.room && vod.room.trim()) || 'vod';
    const stem = rawStem.replace(/\.[^./\\]+$/, '');
    const extFromName = vod.name
      ? path.extname(vod.name).replace(/^\./, '')
      : '';
    const ext = (extFromName || vod.format || 'mp4').toLowerCase();
    return this.sanitizeFilename(`${stem}-${id}.${ext}`);
  }

  /** Keep a filename filesystem- and header-safe (no separators/quotes/CTRL). */
  private sanitizeFilename(name: string): string {
    return (
      name
        .replace(/[\\/"'\r\n\t]+/g, '_')
        .replace(/[^\w.\-]+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '') || 'vod'
    );
  }

  /** Best-effort content-type for a local recording file by extension. */
  private rawContentType(localPath: string): string {
    switch (path.extname(localPath).toLowerCase()) {
      case '.mp4':
        return 'video/mp4';
      case '.webm':
        return 'video/webm';
      case '.mkv':
        return 'video/x-matroska';
      case '.mov':
        return 'video/quicktime';
      default:
        return 'application/octet-stream';
    }
  }

  /**
   * VOD detail with playback URLs (wave-4 §2) + post-transcode variants:
   *  - `publicUrl`: `<s3.public_url>/<objectKey>` when the app has a public/CDN
   *    base configured (deterministic, no expiry),
   *  - `presignedUrl`: a fresh presigned GET (when the object exists),
   *  - `url`: the preferred URL = publicUrl when set, else presignedUrl,
   *  - `adaptive`: the HLS master playlist entry point (when generated),
   *  - `variants`: every generated variant (master/renditions/alternates).
   */
  async getVod(appName: string, id: number): Promise<VodDetail> {
    const vod = this.vods.findById(appName, id);
    if (!vod) throw new NotFoundException(`vod ${id} not found`);

    const variantRows = this.vodVariants.listByVod(appName, id);

    let cfg: AppConfig | null = null;
    if (vod.status === 'ready' && (vod.fileKey || variantRows.length > 0)) {
      try {
        cfg = await this.loadConfig(appName);
      } catch (e) {
        this.logger.warn(`config load failed: ${(e as Error).message}`);
      }
    }

    let presignedUrl: string | null = null;
    let publicUrl: string | null = null;
    if (cfg && vod.fileKey && vod.status === 'ready') {
      if (cfg.s3.publicUrl) {
        publicUrl = this.joinPublicUrl(cfg.s3.publicUrl, vod.fileKey);
      }
      try {
        presignedUrl = await this.s3.presignGet(
          cfg.s3,
          vod.fileKey,
          PRESIGN_TTL_S,
        );
      } catch (e) {
        this.logger.warn(`presign failed: ${(e as Error).message}`);
      }
    }
    const url = publicUrl ?? presignedUrl;

    const variants: VodVariantView[] = [];
    for (const v of variantRows) {
      variants.push({
        id: v.id,
        kind: v.kind,
        format: v.format,
        height: v.height,
        bitrateKbps: v.bitrateKbps,
        key: v.fileKey,
        sizeBytes: v.sizeBytes,
        url: await this.variantUrl(cfg, v.kind, v.fileKey),
      });
    }
    const master = variants.find((v) => v.kind === 'master' && v.key);
    const adaptive = master
      ? { masterKey: master.key as string, masterUrl: master.url }
      : null;

    return { ...vod, url, presignedUrl, publicUrl, adaptive, variants };
  }

  /**
   * Playback URL for a variant. HLS playback needs a public/CDN base (segments
   * resolve relative to the playlist, so presigned playlist URLs don't work for
   * renditions); whole-file kinds (master pointer aside, e.g. WebM alternates)
   * fall back to a presigned GET.
   */
  private async variantUrl(
    cfg: AppConfig | null,
    kind: VodVariantKind,
    fileKey: string | null,
  ): Promise<string | null> {
    if (!cfg || !fileKey) return null;
    if (cfg.s3.publicUrl) return this.joinPublicUrl(cfg.s3.publicUrl, fileKey);
    if (kind === 'rendition') return null;
    try {
      return await this.s3.presignGet(cfg.s3, fileKey, PRESIGN_TTL_S);
    } catch (e) {
      this.logger.warn(`variant presign failed: ${(e as Error).message}`);
      return null;
    }
  }

  /** Join a public/CDN base with an object key (URL-encoding path segments). */
  private joinPublicUrl(base: string, objectKey: string): string {
    const cleanBase = base.replace(/\/+$/, '');
    const encoded = String(objectKey)
      .replace(/^\/+/, '')
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/');
    return `${cleanBase}/${encoded}`;
  }

  /**
   * Backfill media metadata for a VOD (POST /apps/:app/vods/:id/probe).
   *
   * Legacy VODs recorded before the metadata pipeline have no duration_s /
   * dimensions. This runs ffprobe over the best available source — the local
   * file when it still exists, else a short-lived presigned S3 URL (ffprobe
   * reads http(s)) — and persists whatever it could determine. Best-effort:
   * probe failures return `probed: false` with the row untouched; only a VOD
   * with NO media at all (no local file and no S3 object) is a 404.
   */
  async probeVod(
    appName: string,
    id: number,
  ): Promise<VodRecord & { probed: boolean }> {
    const vod = this.vods.findById(appName, id);
    if (!vod) throw new NotFoundException(`vod ${id} not found`);

    let source: string | null = null;
    if (vod.localPath && fs.existsSync(vod.localPath)) {
      source = vod.localPath;
    } else if (vod.fileKey) {
      try {
        const cfg = await this.loadConfig(appName);
        source = await this.s3.presignGet(cfg.s3, vod.fileKey, 600);
      } catch (e) {
        this.logger.warn(`probe presign failed: ${(e as Error).message}`);
      }
    }
    if (!source) {
      throw new NotFoundException(
        `vod ${id} has no media to probe (no local file and no S3 object)`,
      );
    }

    const media = await probeMedia(source);
    const patch: VodPatch = {};
    if (media.durationS != null) patch.durationS = media.durationS;
    if (media.width != null) patch.width = media.width;
    if (media.height != null) patch.height = media.height;
    if (media.format != null && !vod.format) patch.format = media.format;

    const probed = Object.keys(patch).length > 0;
    if (probed) {
      this.vods.update(appName, id, patch);
      this.logs.write('info', 'recording', 'vod probed', {
        appName,
        vodId: id,
        durationS: media.durationS,
        width: media.width,
        height: media.height,
      });
    }
    const updated = this.vods.findById(appName, id) ?? vod;
    return { ...updated, probed };
  }

  /**
   * Delete a VOD with full cascade: (a) the app.db row, (b) its S3 objects
   * (recording file + snapshot), (c) the local recording file + local snapshot
   * if they still exist. Returns per-side counters so callers/UX can report
   * exactly what was reclaimed. Missing S3 objects / files are treated as a
   * no-op (idempotent). Throws NotFound when the VOD row does not exist.
   */
  async deleteVod(
    appName: string,
    id: number,
  ): Promise<{ deleted: true; s3Deleted: number; localDeleted: boolean }> {
    const vod = this.vods.findById(appName, id);
    if (!vod) throw new NotFoundException(`vod ${id} not found`);

    let cfg: AppConfig | null = null;
    try {
      cfg = await this.loadConfig(appName);
    } catch (e) {
      this.logger.warn(`config load on delete failed: ${(e as Error).message}`);
    }

    // (b) S3 objects: the recording, its snapshot, and every variant object
    //     (master/rendition playlists, HLS segments, WebM alternates).
    let s3Deleted = 0;
    if (cfg) {
      const keys: string[] = [];
      for (const key of [vod.fileKey, vod.snapshotKey]) if (key) keys.push(key);
      for (const variant of this.vodVariants.listByVod(appName, id)) {
        if (variant.fileKey) keys.push(variant.fileKey);
        keys.push(...this.variantExtraKeys(variant.extraJson));
      }
      for (const key of keys) {
        try {
          await this.s3.delete(cfg.s3, key);
          s3Deleted += 1;
        } catch (e) {
          this.logger.warn(
            `s3 delete ${key} failed: ${(e as Error).message}`,
          );
        }
      }
    }

    // (c) local recording file + a local snapshot sibling (<base>.jpg) if present.
    const localDeleted = this.removeLocalCascade(appName, vod.localPath);

    // (a) the DB rows (variants first, then the vod itself).
    this.vodVariants.deleteByVod(appName, id);
    this.vods.delete(appName, id);
    this.logs.write('info', 'recording', 'vod deleted', {
      appName,
      vodId: id,
      s3Deleted,
      localDeleted,
    });
    return { deleted: true, s3Deleted, localDeleted };
  }

  /** Segment object keys stored in a variant's extra_json ({ segmentKeys }). */
  private variantExtraKeys(extraJson: string | null): string[] {
    if (!extraJson) return [];
    try {
      const parsed = JSON.parse(extraJson) as { segmentKeys?: unknown };
      return Array.isArray(parsed?.segmentKeys)
        ? parsed.segmentKeys.filter((k): k is string => typeof k === 'string')
        : [];
    } catch {
      return [];
    }
  }

  /**
   * Remove a VOD's local recording file and (best-effort) the co-located
   * snapshot JPEG the upload flow writes next to it (apps/<app>/snapshots/
   * <base>.jpg). Returns true if at least one local file was removed.
   */
  private removeLocalCascade(
    appName: string,
    localPath: string | null | undefined,
  ): boolean {
    let removed = false;
    if (localPath && fs.existsSync(localPath)) {
      this.removeLocal(localPath);
      removed = true;
    }
    if (localPath) {
      try {
        const base = path.basename(localPath, path.extname(localPath));
        const snapLocal = path.join(
          this.apps.appDir(appName),
          'snapshots',
          `${base}.jpg`,
        );
        if (fs.existsSync(snapLocal)) {
          this.removeLocal(snapLocal);
          removed = true;
        }
      } catch (e) {
        this.logger.warn(
          `local snapshot cleanup failed: ${(e as Error).message}`,
        );
      }
    }
    return removed;
  }

  // ---- upload job (the critical flow, SPEC §8.3/§8.4) ------------------

  private async processUploadJob(data: UploadJobData): Promise<void> {
    const { appName, vodId } = data;
    const vod = this.vods.findById(appName, vodId);
    if (!vod) {
      this.logger.warn(`upload job: vod ${vodId} (${appName}) missing`);
      return;
    }
    const localPath = vod.localPath;
    if (!localPath || !fs.existsSync(localPath)) {
      await this.markFailed(
        appName,
        vodId,
        'local recording file missing',
        localPath ?? '(null)',
      );
      return;
    }

    let cfg: AppConfig;
    try {
      cfg = await this.loadConfig(appName);
    } catch (e) {
      await this.markFailed(
        appName,
        vodId,
        'config load failed',
        (e as Error).message,
      );
      return;
    }

    try {
      // 1. probe metadata (best-effort)
      const media = await probeMedia(localPath);

      // 2. snapshot from the LOCAL file BEFORE any deletion (needs a source).
      const snapshot = await this.buildSnapshot(appName, cfg, vod, localPath);

      // 3. upload the recording to the app's S3.
      const fileKey = path.basename(localPath);
      const uploaded = await this.s3.upload(
        cfg.s3,
        localPath,
        fileKey,
        'video/mp4',
      );

      // 4. presigned (or canonical) public URL.
      let publicUrl = uploaded.url;
      try {
        publicUrl = await this.s3.presignGet(
          cfg.s3,
          uploaded.key,
          PRESIGN_TTL_S,
        );
      } catch (e) {
        this.logger.warn(`presign failed: ${(e as Error).message}`);
      }

      // 5. delete local (only after a successful upload) if configured. When
      //    the app wants post-transcode variants (adaptive HLS / WebM), the
      //    source MP4 must survive until the transcode job runs — the delete
      //    is deferred to that job (deleteSourceAfter).
      const wantsVariants = !!this.vodTranscode?.needed(cfg);
      if (cfg.recording.deleteLocalAfterUpload) {
        if (!wantsVariants) this.removeLocal(localPath);
        this.removeLocal(snapshot?.localPath);
      }

      // 6. persist VOD ready + metatags.
      const metatags = {
        ...this.parseMeta(vod.metatagsJson),
        room: vod.room,
        app: appName,
        durationS: media.durationS,
        width: media.width,
        height: media.height,
        codec: media.format,
      };
      this.vods.update(appName, vodId, {
        status: 'ready',
        fileKey: uploaded.key,
        s3Url: uploaded.url,
        publicUrl,
        sizeBytes: uploaded.sizeBytes,
        durationS: media.durationS,
        width: media.width,
        height: media.height,
        format: media.format,
        snapshotKey: snapshot?.key ?? null,
        localPath:
          cfg.recording.deleteLocalAfterUpload && !wantsVariants
            ? null
            : localPath,
        metatagsJson: JSON.stringify(metatags),
      });

      this.logs.write('info', 'recording', 'vod ready', {
        appName,
        vodId,
        fileKey: uploaded.key,
        sizeBytes: uploaded.sizeBytes,
      });
      this.metrics?.vodGenerated(appName);

      // 7. callbacks. vod_ready always; plus the split/whole-recording events
      //    (wave-3 §4). A part fires recording_part_ready; the final piece
      //    (non-split, or the last part once its session has ended) fires
      //    recording_ready.
      const meta = this.parseMeta(vod.metatagsJson);
      const isPart = !!meta.isPart;
      const partIndex = Number(meta.partIndex ?? 0) || 0;
      const sessionId = meta.sessionId as string | undefined;
      const sessionEnded = !sessionId || !this.sessions.has(sessionId);

      const readyPayload = {
        vodId,
        app: appName,
        room: vod.room,
        streamId: vod.streamId,
        fileKey: uploaded.key,
        s3Url: uploaded.url,
        publicUrl,
        snapshotKey: snapshot?.key ?? null,
        sizeBytes: uploaded.sizeBytes,
        durationS: media.durationS,
        width: media.width,
        height: media.height,
        format: media.format,
      };

      await this.dispatch(appName, 'vod_ready', readyPayload);

      if (isPart) {
        await this.dispatch(appName, 'recording_part_ready', {
          ...readyPayload,
          partIndex,
          sessionId,
        });
      }
      // Final recording: a non-split single file, or the last part of a split
      // session (its session has already been torn down by stop()).
      if (!isPart || sessionEnded) {
        await this.dispatch(appName, 'recording_ready', {
          ...readyPayload,
          partIndex,
          sessionId,
          split: isPart,
        });
      }

      // 8. post-transcode variants (adaptive HLS ladder / WebM alternate).
      //    Strictly best-effort AFTER the VOD is ready — the base MP4 flow
      //    never depends on ffmpeg succeeding.
      if (wantsVariants) {
        await this.vodTranscode!.enqueue({
          appName,
          vodId,
          sourcePath: localPath,
          deleteSourceAfter: cfg.recording.deleteLocalAfterUpload,
        });
      }
    } catch (e) {
      // SPEC §8.4: upload failure → failed, DO NOT delete local, log + callback.
      await this.markFailed(
        appName,
        vodId,
        'upload flow failed',
        (e as Error).message,
      );
    }
  }

  /** Generate + upload a snapshot. Best-effort: returns null on any failure. */
  private async buildSnapshot(
    appName: string,
    cfg: AppConfig,
    vod: VodRecord,
    localPath: string,
  ): Promise<{ key: string; localPath: string } | null> {
    try {
      const snapsDir = path.join(this.apps.appDir(appName), 'snapshots');
      fs.mkdirSync(snapsDir, { recursive: true });
      const base = path.basename(localPath, path.extname(localPath));
      const snapLocal = path.join(snapsDir, `${base}.jpg`);
      const ok = await extractSnapshot(localPath, snapLocal, 1);
      if (!ok || !fs.existsSync(snapLocal)) return null;
      const snapKey = `${base}.jpg`;
      const res = await this.s3.upload(
        cfg.s3,
        snapLocal,
        snapKey,
        'image/jpeg',
      );
      return { key: res.key, localPath: snapLocal };
    } catch (e) {
      this.logger.warn(`snapshot failed: ${(e as Error).message}`);
      return null;
    }
  }

  // ---- helpers ---------------------------------------------------------

  private async markFailed(
    appName: string,
    vodId: number,
    reason: string,
    detail: string,
  ): Promise<void> {
    try {
      this.vods.update(appName, vodId, { status: 'failed' });
    } catch (e) {
      this.logger.error(`could not mark vod failed: ${(e as Error).message}`);
    }
    this.logs.write('error', 'recording', reason, { appName, vodId, detail });
    this.metrics?.recordingFailed(appName, reason);
    const vod = this.safeFind(appName, vodId);
    await this.dispatch(appName, 'recording_failed', {
      vodId,
      app: appName,
      room: vod?.room ?? null,
      streamId: vod?.streamId ?? null,
      reason,
      detail,
    });
  }

  private async dispatch(
    appName: string,
    event: CallbackEvent,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.callbacks.dispatch(appName, event, payload);
    } catch (e) {
      this.logger.warn(`callback ${event} failed: ${(e as Error).message}`);
    }
  }

  private async loadConfig(appName: string): Promise<AppConfig> {
    try {
      return await this.apps.getConfig(appName);
    } catch (e) {
      throw new NotFoundException(
        `app '${appName}' config unavailable: ${(e as Error).message}`,
      );
    }
  }

  private async resolveAppId(appName: string): Promise<number> {
    try {
      const app = await this.apps.get(appName);
      if (app) return app.id;
    } catch {
      /* fall through */
    }
    return 0;
  }

  /** Resolve a recording by numeric vod id or by egress id. */
  private async resolveRecording(
    appName: string,
    recordingId: string,
  ): Promise<{ vod: VodRecord; egressId: string }> {
    let vod: VodRecord | null = null;
    const asNum = Number.parseInt(recordingId, 10);
    if (Number.isInteger(asNum) && String(asNum) === recordingId.trim()) {
      vod = this.vods.findById(appName, asNum);
    }
    if (!vod) vod = this.vods.findByEgressId(appName, recordingId);
    if (!vod) throw new NotFoundException(`recording ${recordingId} not found`);

    // Prefer the egressId stored in metatags; fall back to the raw id if the
    // caller passed an egress id directly.
    const egressId =
      (this.parseMeta(vod.metatagsJson).egressId as string | undefined) ||
      recordingId;
    return { vod, egressId };
  }

  /** Find the app+vod owning an egress: memory first, then scan app DBs. */
  private async locate(egressId: string): Promise<EgressRef | null> {
    const cached = this.egressMap.get(egressId);
    if (cached) return cached;
    let apps;
    try {
      apps = await this.apps.list();
    } catch {
      return null;
    }
    for (const app of apps) {
      try {
        const vod = this.vods.findByEgressId(app.name, egressId);
        if (vod) return { appName: app.name, vodId: vod.id };
      } catch {
        /* skip apps whose db is unavailable */
      }
    }
    return null;
  }

  private classifyEgressStatus(
    status: string,
  ): 'progress' | 'complete' | 'failed' {
    const s = (status || '').toUpperCase();
    if (s.includes('FAIL') || s.includes('ABORT')) return 'failed';
    if (
      s.includes('COMPLETE') ||
      s.includes('ENDED') ||
      s === 'EGRESS_ENDED' ||
      s.includes('LIMIT_REACHED')
    ) {
      return 'complete';
    }
    return 'progress';
  }

  private extractEgressError(payload: unknown): string {
    if (payload && typeof payload === 'object') {
      const p = payload as Record<string, unknown>;
      const egress = (p.egressInfo ?? p.egress ?? p) as Record<string, unknown>;
      const err = egress?.error ?? egress?.errorCode;
      if (typeof err === 'string' && err) return err;
    }
    return 'unknown egress error';
  }

  private parseMeta(json: string | null): Record<string, unknown> {
    if (!json) return {};
    try {
      const v = JSON.parse(json);
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private safeFind(appName: string, id: number): VodRecord | null {
    try {
      return this.vods.findById(appName, id);
    } catch {
      return null;
    }
  }

  private async safeStopEgress(egressId: string): Promise<void> {
    try {
      await this.livekit.stopEgress(egressId);
    } catch (e) {
      this.logger.warn(`cleanup stopEgress failed: ${(e as Error).message}`);
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

  private slug(s: string): string {
    return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'rec';
  }
}
