/**
 * VOD transcription orchestration (transcription plugin backend).
 *
 * Flow (per VOD):
 *   trigger (auto on vod_ready via RecordingService hook, or on-demand API)
 *     → resolve the media source (local MP4 if still on disk, else a
 *       presigned S3 URL — ffmpeg/ffprobe read http(s))
 *     → ffmpeg-extract one 16 kHz mono MP3 PER AUDIO STREAM
 *     → transcribe:
 *         provider 'local'  → hand the job to the plugin's Python worker
 *                             (faster-whisper) via a file-based job/result
 *                             exchange under apps/<app>/transcripts/
 *         provider 'openai' → POST the mp3(s) to the OpenAI transcription API
 *     → merge per-track segments (speaker labels), build the SRT, upload it
 *       to the app's S3 NEXT TO the VOD (<fileKey minus ext>.srt)
 *     → persist transcript row (vod_transcripts) + a transcript pointer in
 *       the VOD's metatags_json.
 *
 * Speaker split: one speaker label per AUDIO TRACK. Multi-audio-stream MP4s
 * get `track-N` labels; single-track VODs recorded in `track`/`audio`/
 * `participant` mode (ONE publisher) are attributed to that publisher's
 * stream id. Room-composite recordings carry ONE mixed track — no diarization
 * is attempted (documented limitation; see features/plugins.md).
 *
 * Everything long-running executes in a fire-and-forget background task that
 * NEVER throws into the recording flow; failures land on the transcript row
 * (`status: failed` + error) and in the plugin logs.
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

import {
  APPS_SERVICE,
  AppConfig,
  AppsServiceContract,
  LOGS_SERVICE,
  LogsServiceContract,
  S3_SERVICE,
  S3ServiceContract,
  VodRecord,
} from '../../shared/contracts';
import { AppPluginsRepository } from '../plugins/app-plugins.repository';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import { validateConfig } from '../plugins/plugin-config.util';
import { VodsRepository } from '../recording/vods.repository';
import {
  TranscriptRecord,
  TranscriptsRepository,
} from './transcripts.repository';
import { transcribeViaOpenAi } from './openai.client';
import {
  CommandRunner,
  TrackTranscript,
  TranscriptSegment,
  buildSrt,
  collectSpeakers,
  defaultRunner,
  extractMp3Track,
  mergeTrackSegments,
  plainTranscriptText,
  probeAudioStreamCount,
  srtKeyForVod,
} from './transcription.util';

/** The plugin id this module backs (src/plugins/transcription). */
export const TRANSCRIPTION_PLUGIN_ID = 'transcription';

/** Transcript row + parsed fields + a fresh presigned SRT URL. */
export interface TranscriptView {
  vodId: number;
  status: TranscriptRecord['status'];
  provider: string | null;
  model: string | null;
  language: string | null;
  text: string | null;
  segments: TranscriptSegment[];
  speakers: string[];
  srtKey: string | null;
  /** Short-lived presigned URL of the uploaded SRT (null when unavailable). */
  srtUrl: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One extracted audio track handed to a transcription engine. */
interface AudioTrack {
  path: string;
  speaker: string | null;
}

/** Result JSON the local Python worker writes per job. */
interface WorkerResult {
  ok: boolean;
  error?: string;
  language?: string | null;
  tracks?: { speaker?: string | null; segments?: TranscriptSegment[] }[];
}

const SRT_PRESIGN_TTL_S = 3600;

@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);
  /** In-flight jobs (`app:vodId`) — a second trigger while running is a 409. */
  private readonly running = new Set<string>();

  // ---- test seams (overridden by unit specs; defaults are the real thing) --
  /** Shell-out runner for ffmpeg/ffprobe. */
  runner: CommandRunner = defaultRunner;
  /** fetch used by the OpenAI client. */
  fetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) =>
    fetch(...args);
  /** Local-worker result polling cadence/budget. */
  pollIntervalMs = 2000;
  pollTimeoutMs = 30 * 60_000;

  constructor(
    private readonly transcripts: TranscriptsRepository,
    private readonly vods: VodsRepository,
    private readonly appPlugins: AppPluginsRepository,
    private readonly registry: PluginRegistryService,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
    @Inject(S3_SERVICE) private readonly s3: S3ServiceContract,
    @Inject(LOGS_SERVICE) private readonly logs: LogsServiceContract,
  ) {}

  // -------------------------------------------------------------------------
  // Triggers
  // -------------------------------------------------------------------------

  /**
   * Recording hook: called (fire-and-forget) by RecordingService right after a
   * VOD reaches `ready`. Transcribes only when the plugin is installed +
   * enabled for the app AND `autoTranscribe` is on. NEVER throws.
   */
  onVodReady(app: string, vodId: number): void {
    try {
      const config = this.enabledConfig(app);
      if (!config || config.autoTranscribe !== true) return;
      this.transcripts.begin(app, vodId, this.provider(config), this.model(config));
      void this.execute(app, vodId, config).catch((e) =>
        this.logger.warn(`auto-transcribe ${app}/${vodId}: ${(e as Error).message}`),
      );
    } catch (e) {
      // The recording flow must never be affected by transcription problems.
      this.logger.warn(`onVodReady ${app}/${vodId}: ${(e as Error).message}`);
    }
  }

  /** On-demand trigger (POST /apps/:app/vods/:id/transcribe). */
  async trigger(app: string, vodId: number): Promise<TranscriptView> {
    await this.requireApp(app);
    const meta = this.registry.getMeta(TRANSCRIPTION_PLUGIN_ID);
    if (!meta) {
      throw new NotFoundException('transcription plugin is not available');
    }
    const row = this.appPlugins.get(app, TRANSCRIPTION_PLUGIN_ID);
    if (!row) {
      throw new BadRequestException(
        `plugin '${TRANSCRIPTION_PLUGIN_ID}' is not installed in app '${app}'`,
      );
    }
    if (!row.enabled) {
      throw new BadRequestException(
        `plugin '${TRANSCRIPTION_PLUGIN_ID}' is not enabled in app '${app}'`,
      );
    }
    const vod = this.vods.findById(app, vodId);
    if (!vod) throw new NotFoundException(`vod ${vodId} not found`);
    if (vod.status !== 'ready') {
      throw new ConflictException(
        `vod ${vodId} is not ready (status: ${vod.status})`,
      );
    }
    if (this.running.has(this.key(app, vodId))) {
      throw new ConflictException(
        `transcription of vod ${vodId} is already in progress`,
      );
    }
    const config = validateConfig(meta, row.config, false);
    this.transcripts.begin(app, vodId, this.provider(config), this.model(config));
    // Snapshot the queued view FIRST so the API response reflects `queued`,
    // then kick the background pipeline.
    const view = await this.getTranscript(app, vodId);
    void this.execute(app, vodId, config).catch((e) =>
      this.logger.warn(`transcribe ${app}/${vodId}: ${(e as Error).message}`),
    );
    return view;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Transcript view for a VOD (404 when none was ever produced/queued). */
  async getTranscript(app: string, vodId: number): Promise<TranscriptView> {
    await this.requireApp(app);
    const row = this.transcripts.getByVod(app, vodId);
    if (!row) {
      throw new NotFoundException(
        `vod ${vodId} has no transcript — trigger one with POST /vods/${vodId}/transcribe`,
      );
    }
    let srtUrl: string | null = null;
    if (row.srtKey) {
      try {
        const cfg = await this.apps.getConfig(app);
        srtUrl = await this.s3.presignGet(cfg.s3, row.srtKey, SRT_PRESIGN_TTL_S);
      } catch (e) {
        this.logger.warn(`srt presign failed: ${(e as Error).message}`);
      }
    }
    return {
      vodId: row.vodId,
      status: row.status,
      provider: row.provider,
      model: row.model,
      language: row.language,
      text: row.text,
      segments: this.parseSegments(row.segmentsJson),
      speakers: this.parseSpeakers(row.speakersJson),
      srtKey: row.srtKey,
      srtUrl,
      error: row.error,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * SRT document for a VOD, rebuilt from the stored segments (works even when
   * the S3 upload failed). 404 without a transcript, 409 while not ready.
   */
  async getSrt(
    app: string,
    vodId: number,
  ): Promise<{ filename: string; content: string }> {
    await this.requireApp(app);
    const row = this.transcripts.getByVod(app, vodId);
    if (!row) {
      throw new NotFoundException(`vod ${vodId} has no transcript`);
    }
    if (row.status !== 'ready') {
      throw new ConflictException(
        `transcript of vod ${vodId} is not ready (status: ${row.status})`,
      );
    }
    const segments = this.parseSegments(row.segmentsJson);
    const vod = this.vods.findById(app, vodId);
    const stem = (vod?.name ?? `vod`).replace(/\.[^./\\]+$/, '');
    const safe =
      stem.replace(/[\\/"'\r\n\t]+/g, '_').replace(/[^\w.\-]+/g, '-') || 'vod';
    return { filename: `${safe}-${vodId}.srt`, content: buildSrt(segments) };
  }

  // -------------------------------------------------------------------------
  // Pipeline
  // -------------------------------------------------------------------------

  private async execute(
    app: string,
    vodId: number,
    config: Record<string, unknown>,
  ): Promise<void> {
    const key = this.key(app, vodId);
    if (this.running.has(key)) return;
    this.running.add(key);
    const cleanupPaths: string[] = [];
    try {
      this.transcripts.patch(app, vodId, { status: 'processing' });

      const vod = this.vods.findById(app, vodId);
      if (!vod) throw new Error(`vod ${vodId} disappeared`);
      const cfg = await this.apps.getConfig(app);
      const source = await this.resolveSource(app, vod, cfg);

      // 1. audio extraction: one mp3 per audio stream.
      const tracks = await this.extractTracks(app, vod, source, cleanupPaths);

      // 2. transcription (provider-specific), per track.
      const provider = this.provider(config);
      const engine =
        provider === 'openai'
          ? await this.transcribeOpenAi(tracks, config, vod)
          : await this.transcribeLocal(app, vodId, tracks, config, cleanupPaths);

      // 3. merge tracks → transcript + SRT.
      const merged = mergeTrackSegments(engine.tracks);
      if (merged.length === 0) {
        throw new Error('transcription produced no segments');
      }
      const text = plainTranscriptText(merged);
      const speakers = collectSpeakers(merged);
      const srt = buildSrt(merged);

      // 4. upload the SRT next to the VOD in the app's S3 (best-effort: an
      //    upload failure keeps the transcript, minus the S3 copy).
      let srtKey: string | null = null;
      const srtLocal = path.join(
        this.workDir(app),
        `vod-${vodId}.srt`,
      );
      try {
        fs.mkdirSync(path.dirname(srtLocal), { recursive: true });
        fs.writeFileSync(srtLocal, srt, 'utf8');
        cleanupPaths.push(srtLocal);
        const uploaded = await this.s3.upload(
          cfg.s3,
          srtLocal,
          srtKeyForVod(vod.fileKey, vodId),
          'application/x-subrip',
        );
        srtKey = uploaded.key;
      } catch (e) {
        this.logs.write(
          'warn',
          `plugin:${TRANSCRIPTION_PLUGIN_ID}`,
          'SRT upload to S3 failed — transcript kept without S3 copy',
          { app, vodId, error: (e as Error).message },
        );
      }

      // 5. persist: transcript row → ready, + a pointer in the VOD metatags.
      this.transcripts.patch(app, vodId, {
        status: 'ready',
        language: engine.language ?? null,
        text,
        segmentsJson: JSON.stringify(merged),
        speakersJson: JSON.stringify(speakers),
        srtKey,
        error: null,
      });
      this.tagVod(app, vodId, srtKey, engine.language ?? null);

      this.logs.write(
        'info',
        `plugin:${TRANSCRIPTION_PLUGIN_ID}`,
        'vod transcribed',
        {
          app,
          vodId,
          provider,
          language: engine.language ?? null,
          segments: merged.length,
          speakers,
          srtKey,
        },
      );
    } catch (e) {
      const message = (e as Error).message || 'transcription failed';
      this.transcripts.patch(app, vodId, { status: 'failed', error: message });
      this.logs.write(
        'error',
        `plugin:${TRANSCRIPTION_PLUGIN_ID}`,
        'transcription failed',
        { app, vodId, error: message },
      );
    } finally {
      this.running.delete(key);
      for (const p of cleanupPaths) {
        try {
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch {
          /* best-effort */
        }
      }
    }
  }

  /** Media source: local file when still on disk, else a presigned S3 URL. */
  private async resolveSource(
    app: string,
    vod: VodRecord,
    cfg: AppConfig,
  ): Promise<string> {
    if (vod.localPath && fs.existsSync(vod.localPath)) return vod.localPath;
    if (vod.fileKey) {
      return this.s3.presignGet(cfg.s3, vod.fileKey, 600);
    }
    throw new Error(
      `vod ${vod.id} has no media to transcribe (no local file and no S3 object)`,
    );
  }

  /**
   * Probe the audio streams and ffmpeg-extract one mono 16 kHz MP3 per
   * stream, deriving the speaker label per track (see class doc).
   */
  private async extractTracks(
    app: string,
    vod: VodRecord,
    source: string,
    cleanupPaths: string[],
  ): Promise<AudioTrack[]> {
    const count = await probeAudioStreamCount(source, this.runner);
    if (count === 0) {
      throw new Error(`vod ${vod.id} has no audio track`);
    }
    const n = count ?? 1; // probe failure → assume one track
    const meta = this.parseMeta(vod.metatagsJson);
    const mode = String(meta.mode ?? '');
    const singleSpeaker =
      mode === 'track' || mode === 'audio' || mode === 'participant'
        ? (vod.streamId ?? null)
        : null;

    const tmpDir = path.join(this.workDir(app), 'tmp');
    const tracks: AudioTrack[] = [];
    for (let i = 0; i < n; i++) {
      const outPath = path.join(tmpDir, `vod-${vod.id}-a${i}.mp3`);
      const ok = await extractMp3Track(source, outPath, i, this.runner);
      if (!ok) {
        throw new Error(
          `audio extraction failed (ffmpeg, stream ${i} of ${n})`,
        );
      }
      cleanupPaths.push(outPath);
      tracks.push({
        path: outPath,
        speaker: n > 1 ? `track-${i + 1}` : singleSpeaker,
      });
    }
    return tracks;
  }

  /** provider 'openai': call the API once per track. */
  private async transcribeOpenAi(
    tracks: AudioTrack[],
    config: Record<string, unknown>,
    vod: VodRecord,
  ): Promise<{ language: string | null; tracks: TrackTranscript[] }> {
    const apiKey = String(config.apiKey ?? '').trim();
    if (!apiKey) {
      throw new Error(
        "provider 'openai' needs the API key config (plugin field 'apiKey')",
      );
    }
    const model = String(config.openaiModel ?? 'whisper-1');
    const language = String(config.language ?? 'auto');
    let detected: string | null = null;
    const out: TrackTranscript[] = [];
    for (const track of tracks) {
      const res = await transcribeViaOpenAi({
        apiKey,
        model,
        language,
        filePath: track.path,
        fetchImpl: this.fetchImpl,
      });
      detected = detected ?? res.language;
      const segments =
        res.segments && res.segments.length > 0
          ? res.segments
          : // Models without segment timing → one full-length segment.
            [{ start: 0, end: vod.durationS ?? 0, text: res.text }];
      out.push({ speaker: track.speaker, segments });
    }
    return { language: detected, tracks: out };
  }

  /**
   * provider 'local': hand the job to the plugin's Python worker
   * (faster-whisper) via the file exchange under apps/<app>/transcripts/
   * (jobs/vod-<id>.json → results/vod-<id>.json) and await the result.
   */
  private async transcribeLocal(
    app: string,
    vodId: number,
    tracks: AudioTrack[],
    config: Record<string, unknown>,
    cleanupPaths: string[],
  ): Promise<{ language: string | null; tracks: TrackTranscript[] }> {
    const jobsDir = path.join(this.workDir(app), 'jobs');
    const resultsDir = path.join(this.workDir(app), 'results');
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.mkdirSync(resultsDir, { recursive: true });

    const jobPath = path.join(jobsDir, `vod-${vodId}.json`);
    const resultPath = path.join(resultsDir, `vod-${vodId}.json`);
    try {
      if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath); // stale result
    } catch {
      /* best-effort */
    }
    const job = {
      vodId,
      app,
      language: String(config.language ?? 'auto'),
      model: String(config.model ?? 'small'),
      tracks: tracks.map((t) => ({ path: t.path, speaker: t.speaker })),
    };
    // Atomic drop so the worker never reads a half-written job.
    const tmp = `${jobPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(job), 'utf8');
    fs.renameSync(tmp, jobPath);
    cleanupPaths.push(jobPath, `${jobPath}.working`, resultPath);

    const deadline = Date.now() + this.pollTimeoutMs;
    while (!fs.existsSync(resultPath)) {
      if (Date.now() >= deadline) {
        const untouched = fs.existsSync(jobPath);
        throw new Error(
          untouched
            ? 'transcription worker never picked up the job — is the plugin worker running? (check GET plugins/transcription/worker/status)'
            : 'transcription worker timed out producing a result',
        );
      }
      await this.sleep(this.pollIntervalMs);
    }

    let result: WorkerResult;
    try {
      result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as WorkerResult;
    } catch (e) {
      throw new Error(`unreadable worker result: ${(e as Error).message}`);
    }
    if (!result.ok) {
      throw new Error(result.error || 'transcription worker reported failure');
    }
    const trackResults = Array.isArray(result.tracks) ? result.tracks : [];
    return {
      language: result.language ?? null,
      tracks: trackResults.map((t, i) => ({
        // Speaker attribution is OURS (by track index); the worker echo is a
        // fallback for forward-compat.
        speaker: tracks[i]?.speaker ?? t.speaker ?? null,
        segments: Array.isArray(t.segments) ? t.segments : [],
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Resolved plugin config when installed + enabled, else null. */
  private enabledConfig(app: string): Record<string, unknown> | null {
    const meta = this.registry.getMeta(TRANSCRIPTION_PLUGIN_ID);
    if (!meta) return null;
    const row = this.appPlugins.get(app, TRANSCRIPTION_PLUGIN_ID);
    if (!row || !row.enabled) return null;
    return validateConfig(meta, row.config, false);
  }

  /** Record the transcript pointer on the VOD row (metatags_json). */
  private tagVod(
    app: string,
    vodId: number,
    srtKey: string | null,
    language: string | null,
  ): void {
    try {
      const vod = this.vods.findById(app, vodId);
      if (!vod) return;
      const tags = this.parseMeta(vod.metatagsJson);
      tags.transcript = {
        srtKey,
        language,
        generatedAt: new Date().toISOString(),
      };
      this.vods.update(app, vodId, { metatagsJson: JSON.stringify(tags) });
    } catch (e) {
      this.logger.warn(`could not tag vod metatags: ${(e as Error).message}`);
    }
  }

  private async requireApp(app: string): Promise<void> {
    const rec = await this.apps.get(app);
    if (!rec) throw new NotFoundException(`app '${app}' not found`);
  }

  private workDir(app: string): string {
    return path.join(this.apps.appDir(app), 'transcripts');
  }

  private provider(config: Record<string, unknown>): string {
    return String(config.provider ?? 'local') === 'openai' ? 'openai' : 'local';
  }

  private model(config: Record<string, unknown>): string {
    return this.provider(config) === 'openai'
      ? String(config.openaiModel ?? 'whisper-1')
      : String(config.model ?? 'small');
  }

  private key(app: string, vodId: number): string {
    return `${app}:${vodId}`;
  }

  private parseSegments(json: string | null): TranscriptSegment[] {
    if (!json) return [];
    try {
      const v = JSON.parse(json);
      return Array.isArray(v) ? (v as TranscriptSegment[]) : [];
    } catch {
      return [];
    }
  }

  private parseSpeakers(json: string | null): string[] {
    if (!json) return [];
    try {
      const v = JSON.parse(json);
      return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
    } catch {
      return [];
    }
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
