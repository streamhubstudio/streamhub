/**
 * Unit specs for TranscriptionService + controller wiring (module
 * transcription). NO network, NO real ffmpeg/whisper: the shell-out runner
 * and the OpenAI fetch are injected fakes, S3/Apps/Logs are the contract
 * mocks, and the local-provider "worker" is the test writing the result file.
 *
 * Covers: trigger guards (install/enable/404/409 + already-running), the
 * openai flow end-to-end (extract → API → SRT → S3 upload next to the VOD →
 * row ready → VOD metatags tagged), the local worker file exchange
 * (job drop → result poll), per-track speaker attribution (multi-stream +
 * track-mode recordings), failure paths, the auto-trigger (onVodReady)
 * gating, the RecordingService vod_ready hook, and the RBAC metadata on
 * every route.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Reflector } from '@nestjs/core';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { REQUIRE_PERMISSION_KEY } from '../authz/permission.decorator';
import { AppPluginsRepository } from '../plugins/app-plugins.repository';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import { defaultConfig } from '../plugins/plugin-config.util';
import { VodsRepository } from '../recording/vods.repository';
import { VodVariantsRepository } from '../recording/vod-variants.repository';
import { RecordingService } from '../recording/recording.service';
import { TranscriptsRepository } from './transcripts.repository';
import { TranscriptionController } from './transcription.controller';
import {
  TRANSCRIPTION_PLUGIN_ID,
  TranscriptionService,
} from './transcription.service';
import type { CommandRunner } from './transcription.util';

const APP = 'live';

// `transcription` is a DECOUPLED app now (its meta lives in its own repo, only
// discovered when composed). This core module resolves the plugin config via
// registry.getMeta('transcription'), so the hermetic unit tests discover the
// synthetic `transcription` fixture (test/fixtures/plugins/) as a stable stand-in.
const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', '..', 'test', 'fixtures', 'plugins');
const prevFixtureRoot = process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT;
beforeAll(() => {
  process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT = FIXTURE_ROOT;
});
afterAll(() => {
  if (prevFixtureRoot === undefined) delete process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT;
  else process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT = prevFixtureRoot;
});

/** Fake runner: ffprobe → n audio streams; ffmpeg → writes the out file. */
function fakeRunner(audioStreams = 1): jest.MockedFunction<CommandRunner> {
  return jest.fn(async (bin: string, args: string[]) => {
    if (bin === 'ffprobe') {
      return JSON.stringify({
        streams: Array.from({ length: audioStreams }, (_, i) => ({ index: i })),
      });
    }
    // ffmpeg extract: last arg is the output path.
    fs.writeFileSync(args[args.length - 1], 'mp3-bytes');
    return '';
  });
}

/** fetch fake answering the OpenAI transcriptions endpoint. */
function fakeOpenAi(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

/** Wait until the transcript row reaches a terminal state (ready/failed). */
async function waitForDone(
  transcripts: TranscriptsRepository,
  vodId: number,
  timeoutMs = 5000,
): Promise<ReturnType<TranscriptsRepository['getByVod']>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = transcripts.getByVod(APP, vodId);
    if (row && (row.status === 'ready' || row.status === 'failed')) return row;
    if (Date.now() > deadline) return row;
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('TranscriptionService', () => {
  let ctx: UnitContext;
  let transcripts: TranscriptsRepository;
  let vods: VodsRepository;
  let appPlugins: AppPluginsRepository;
  let registry: PluginRegistryService;
  let service: TranscriptionService;
  let appDir: string;

  let seedSeq = 0;

  /** Insert a ready VOD whose localPath is a real dummy file. */
  function seedVod(over: {
    metatags?: Record<string, unknown>;
    fileKey?: string | null;
    streamId?: string | null;
  } = {}): number {
    seedSeq += 1;
    const localPath = path.join(appDir, 'recordings', `rec-${seedSeq}.mp4`);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, 'mp4');
    const id = vods.insert(APP, {
      appId: 1,
      streamId: over.streamId === undefined ? 'stream-a' : over.streamId,
      room: 'main',
      name: path.basename(localPath),
      status: 'recording',
      localPath,
      startedAt: new Date().toISOString(),
      metatagsJson: JSON.stringify(
        over.metatags ?? { egressId: 'EG_1', mode: 'room-composite' },
      ),
    });
    vods.update(APP, id, {
      status: 'ready',
      fileKey: over.fileKey === undefined ? 'rec-1.mp4' : over.fileKey,
      durationS: 12.5,
    });
    return id;
  }

  /** Install (and enable) the plugin with config over defaults. */
  function installPlugin(over: Record<string, unknown> = {}, enabled = true) {
    const meta = registry.getMeta(TRANSCRIPTION_PLUGIN_ID)!;
    appPlugins.install(APP, TRANSCRIPTION_PLUGIN_ID, {
      ...defaultConfig(meta),
      ...over,
    });
    appPlugins.update(APP, TRANSCRIPTION_PLUGIN_ID, { enabled });
  }

  beforeEach(() => {
    ctx = makeUnitContext();
    appDir = path.join(ctx.dataDir, 'apps', APP);
    fs.mkdirSync(appDir, { recursive: true });
    transcripts = new TranscriptsRepository(ctx.db);
    vods = new VodsRepository(ctx.db);
    appPlugins = new AppPluginsRepository(ctx.db);
    registry = new PluginRegistryService();
    registry.discover();
    ctx.mocks.apps.get.mockResolvedValue({ id: 1, name: APP });
    ctx.mocks.apps.appDir.mockImplementation(() => appDir);
    ctx.mocks.apps.getConfig.mockResolvedValue({
      s3: { provider: 'minio', bucket: 'b', accessKey: 'k', secretKey: 's' },
      recording: { enabled: true },
    });
    service = ctx.newService(
      TranscriptionService,
      transcripts,
      vods,
      appPlugins,
      registry,
      ctx.mocks.apps,
      ctx.mocks.s3,
      ctx.mocks.logs,
    );
    service.runner = fakeRunner();
    service.pollIntervalMs = 10;
    service.pollTimeoutMs = 2000;
  });

  afterEach(() => ctx.cleanup());

  // -------------------------------------------------------------------------
  // trigger guards
  // -------------------------------------------------------------------------

  describe('trigger guards', () => {
    it('400s when the plugin is not installed / not enabled', async () => {
      const vodId = seedVod();
      await expect(service.trigger(APP, vodId)).rejects.toThrow(
        BadRequestException,
      );
      installPlugin({}, false);
      await expect(service.trigger(APP, vodId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('404s on a missing vod, 409s when the vod is not ready', async () => {
      installPlugin();
      await expect(service.trigger(APP, 999)).rejects.toThrow(
        NotFoundException,
      );
      const localPath = path.join(appDir, 'recordings', 'inflight.mp4');
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, 'x');
      const inflight = vods.insert(APP, {
        appId: 1,
        streamId: 's',
        room: 'main',
        name: 'inflight.mp4',
        status: 'recording',
        localPath,
        startedAt: new Date().toISOString(),
        metatagsJson: null,
      });
      await expect(service.trigger(APP, inflight)).rejects.toThrow(
        ConflictException,
      );
    });

    it('409s when a transcription of the same vod is already running', async () => {
      // local provider with NO worker answering → the first run keeps polling.
      installPlugin({ provider: 'local' });
      const vodId = seedVod();
      service.pollTimeoutMs = 300;
      await service.trigger(APP, vodId);
      await expect(service.trigger(APP, vodId)).rejects.toThrow(
        ConflictException,
      );
      const row = await waitForDone(transcripts, vodId);
      expect(row?.status).toBe('failed'); // timed out, job never picked up
      expect(row?.error).toContain('worker');
    });

    it('404s for an unknown app', async () => {
      ctx.mocks.apps.get.mockResolvedValue(null);
      await expect(service.trigger('ghost', 1)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // -------------------------------------------------------------------------
  // openai provider flow
  // -------------------------------------------------------------------------

  describe('openai flow', () => {
    it('extracts mp3, transcribes, uploads the SRT next to the VOD and stores the transcript', async () => {
      installPlugin({ provider: 'openai', apiKey: 'sk-test' });
      const vodId = seedVod({ fileKey: 'streamhub/live/rec-1.mp4' });
      service.fetchImpl = fakeOpenAi({
        text: 'hola mundo',
        language: 'es',
        segments: [
          { start: 0, end: 1.5, text: 'hola' },
          { start: 1.5, end: 3, text: 'mundo' },
        ],
      });

      const queued = await service.trigger(APP, vodId);
      expect(queued.status).toBe('queued');

      const row = await waitForDone(transcripts, vodId);
      expect(row?.status).toBe('ready');
      expect(row?.language).toBe('es');
      expect(row?.text).toBe('hola\nmundo');
      expect(JSON.parse(row?.segmentsJson ?? '[]')).toHaveLength(2);

      // SRT upload path: NEXT to the VOD (fileKey with .srt), subrip type.
      expect(ctx.mocks.s3.upload).toHaveBeenCalledWith(
        expect.objectContaining({ bucket: 'b' }),
        expect.stringContaining(`vod-${vodId}.srt`),
        'streamhub/live/rec-1.srt',
        'application/x-subrip',
      );
      expect(row?.srtKey).toBe('streamhub/live/rec-1.srt');

      // The VOD record carries the transcript pointer in metatags.
      const vod = vods.findById(APP, vodId);
      const tags = JSON.parse(vod?.metatagsJson ?? '{}');
      expect(tags.transcript).toMatchObject({
        srtKey: 'streamhub/live/rec-1.srt',
        language: 'es',
      });

      // The mp3-extract went through the injected runner (no real spawn).
      const ffmpegCalls = (service.runner as jest.Mock).mock.calls.filter(
        (c) => c[0] === 'ffmpeg',
      );
      expect(ffmpegCalls).toHaveLength(1);
      expect(ffmpegCalls[0][1]).toContain('0:a:0');
    });

    it('splits speakers per audio track on multi-stream recordings', async () => {
      installPlugin({ provider: 'openai', apiKey: 'sk-test' });
      const vodId = seedVod();
      service.runner = fakeRunner(2); // two audio streams
      let call = 0;
      service.fetchImpl = (async () => {
        call += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            text: `speech ${call}`,
            language: 'en',
            segments: [{ start: call, end: call + 1, text: `speech ${call}` }],
          }),
          text: async () => '',
        };
      }) as unknown as typeof fetch;

      await service.trigger(APP, vodId);
      const row = await waitForDone(transcripts, vodId);
      expect(row?.status).toBe('ready');
      expect(JSON.parse(row?.speakersJson ?? '[]')).toEqual([
        'track-1',
        'track-2',
      ]);
      const segments = JSON.parse(row?.segmentsJson ?? '[]');
      expect(segments.map((s: { speaker: string }) => s.speaker)).toEqual([
        'track-1',
        'track-2',
      ]);
      // One extraction per stream, each mapped to its own stream index.
      const ffmpegCalls = (service.runner as jest.Mock).mock.calls.filter(
        (c) => c[0] === 'ffmpeg',
      );
      expect(ffmpegCalls.map((c) => c[1].join(' '))).toEqual([
        expect.stringContaining('0:a:0'),
        expect.stringContaining('0:a:1'),
      ]);
    });

    it('attributes single-track TRACK-mode recordings to the publisher (streamId)', async () => {
      installPlugin({ provider: 'openai', apiKey: 'sk-test' });
      const vodId = seedVod({
        metatags: { egressId: 'EG_1', mode: 'track' },
        streamId: 'cam-entrance',
      });
      service.fetchImpl = fakeOpenAi({
        text: 'one publisher',
        language: 'en',
        segments: [{ start: 0, end: 1, text: 'one publisher' }],
      });
      await service.trigger(APP, vodId);
      const row = await waitForDone(transcripts, vodId);
      expect(row?.status).toBe('ready');
      expect(JSON.parse(row?.speakersJson ?? '[]')).toEqual(['cam-entrance']);
      expect(row?.text).toBe('[cam-entrance] one publisher');
    });

    it('synthesizes one full-length segment for models without timestamps', async () => {
      installPlugin({
        provider: 'openai',
        apiKey: 'sk-test',
        openaiModel: 'gpt-4o-transcribe',
      });
      const vodId = seedVod();
      service.fetchImpl = fakeOpenAi({ text: 'plain text only' }); // no segments
      await service.trigger(APP, vodId);
      const row = await waitForDone(transcripts, vodId);
      expect(row?.status).toBe('ready');
      const segments = JSON.parse(row?.segmentsJson ?? '[]');
      expect(segments).toHaveLength(1);
      expect(segments[0]).toMatchObject({
        start: 0,
        end: 12.5,
        text: 'plain text only',
      });
    });

    it('fails cleanly without an API key (row failed, nothing uploaded)', async () => {
      installPlugin({ provider: 'openai', apiKey: '' });
      const vodId = seedVod();
      await service.trigger(APP, vodId);
      const row = await waitForDone(transcripts, vodId);
      expect(row?.status).toBe('failed');
      expect(row?.error).toContain('API key');
      expect(ctx.mocks.s3.upload).not.toHaveBeenCalled();
    });

    it('keeps the transcript (ready, srtKey null) when the S3 upload fails', async () => {
      installPlugin({ provider: 'openai', apiKey: 'sk-test' });
      const vodId = seedVod();
      service.fetchImpl = fakeOpenAi({
        text: 'ok',
        language: 'en',
        segments: [{ start: 0, end: 1, text: 'ok' }],
      });
      ctx.mocks.s3.upload.mockRejectedValue(new Error('bucket down'));
      await service.trigger(APP, vodId);
      const row = await waitForDone(transcripts, vodId);
      expect(row?.status).toBe('ready');
      expect(row?.srtKey).toBeNull();
      expect(row?.text).toBe('ok');
    });
  });

  // -------------------------------------------------------------------------
  // local provider flow (file exchange with the python worker)
  // -------------------------------------------------------------------------

  describe('local worker flow', () => {
    it('drops a job file and consumes the worker result into transcript + SRT', async () => {
      installPlugin({ provider: 'local', model: 'small', language: 'auto' });
      const vodId = seedVod();

      await service.trigger(APP, vodId);

      // The core dropped the job for the worker.
      const jobPath = path.join(appDir, 'transcripts', 'jobs', `vod-${vodId}.json`);
      const deadline = Date.now() + 2000;
      while (!fs.existsSync(jobPath) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
      expect(job).toMatchObject({ vodId, app: APP, model: 'small' });
      expect(job.tracks).toHaveLength(1);
      expect(job.tracks[0].path).toMatch(/vod-\d+-a0\.mp3$/);

      // Play the worker: claim the job and write the result.
      fs.renameSync(jobPath, `${jobPath}.working`);
      const resultPath = path.join(
        appDir,
        'transcripts',
        'results',
        `vod-${vodId}.json`,
      );
      fs.mkdirSync(path.dirname(resultPath), { recursive: true });
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          ok: true,
          vodId,
          language: 'en',
          tracks: [
            {
              segments: [
                { start: 0, end: 2, text: 'local whisper' },
                { start: 2, end: 4, text: 'works offline' },
              ],
            },
          ],
        }),
      );

      const row = await waitForDone(transcripts, vodId);
      expect(row?.status).toBe('ready');
      expect(row?.provider).toBe('local');
      expect(row?.language).toBe('en');
      expect(row?.text).toBe('local whisper\nworks offline');
      expect(ctx.mocks.s3.upload).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        'rec-1.srt',
        'application/x-subrip',
      );
      // Job/result files are cleaned up after completion.
      expect(fs.existsSync(resultPath)).toBe(false);
      expect(fs.existsSync(`${jobPath}.working`)).toBe(false);
    });

    it('fails the row when the worker reports an error', async () => {
      installPlugin({ provider: 'local' });
      const vodId = seedVod();
      await service.trigger(APP, vodId);
      // Wait for the job drop first — a result written earlier would be
      // discarded as stale by the service.
      const jobPath = path.join(appDir, 'transcripts', 'jobs', `vod-${vodId}.json`);
      const deadline = Date.now() + 2000;
      while (!fs.existsSync(jobPath) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const resultPath = path.join(
        appDir,
        'transcripts',
        'results',
        `vod-${vodId}.json`,
      );
      fs.mkdirSync(path.dirname(resultPath), { recursive: true });
      fs.writeFileSync(
        resultPath,
        JSON.stringify({ ok: false, error: 'model download failed' }),
      );
      const row = await waitForDone(transcripts, vodId);
      expect(row?.status).toBe('failed');
      expect(row?.error).toBe('model download failed');
    });
  });

  // -------------------------------------------------------------------------
  // failures + reads
  // -------------------------------------------------------------------------

  it('fails the row when ffmpeg extraction fails', async () => {
    installPlugin({ provider: 'openai', apiKey: 'sk-test' });
    const vodId = seedVod();
    service.runner = jest.fn(async (bin: string) => {
      if (bin === 'ffprobe') return JSON.stringify({ streams: [{}] });
      throw new Error('ffmpeg exploded');
    });
    await service.trigger(APP, vodId);
    const row = await waitForDone(transcripts, vodId);
    expect(row?.status).toBe('failed');
    expect(row?.error).toContain('audio extraction failed');
    expect(ctx.mocks.s3.upload).not.toHaveBeenCalled();
  });

  it('fails the row when the source has no audio stream', async () => {
    installPlugin({ provider: 'openai', apiKey: 'sk-test' });
    const vodId = seedVod();
    service.runner = jest.fn(async () => JSON.stringify({ streams: [] }));
    await service.trigger(APP, vodId);
    const row = await waitForDone(transcripts, vodId);
    expect(row?.status).toBe('failed');
    expect(row?.error).toContain('no audio track');
  });

  describe('reads', () => {
    it('getTranscript 404s when never transcribed, else returns the view + presigned srtUrl', async () => {
      await expect(service.getTranscript(APP, 12345)).rejects.toThrow(
        NotFoundException,
      );
      transcripts.begin(APP, 7, 'local', 'small');
      transcripts.patch(APP, 7, {
        status: 'ready',
        text: 'hi',
        segmentsJson: '[{"start":0,"end":1,"text":"hi"}]',
        speakersJson: '[]',
        srtKey: 'rec.srt',
      });
      const view = await service.getTranscript(APP, 7);
      expect(view.status).toBe('ready');
      expect(view.segments).toHaveLength(1);
      expect(view.srtUrl).toBe('https://s3.test/rec.srt?sig=test');
    });

    it('getSrt rebuilds the SubRip document from the stored segments', async () => {
      transcripts.begin(APP, 8, 'local', 'small');
      transcripts.patch(APP, 8, {
        status: 'ready',
        segmentsJson: JSON.stringify([
          { start: 0, end: 1, text: 'uno', speaker: 'a' },
        ]),
      });
      const { filename, content } = await service.getSrt(APP, 8);
      expect(filename).toBe('vod-8.srt');
      expect(content).toBe('1\n00:00:00,000 --> 00:00:01,000\n[a] uno\n');
    });

    it('getSrt 409s while the transcript is not ready', async () => {
      transcripts.begin(APP, 9, 'local', 'small');
      await expect(service.getSrt(APP, 9)).rejects.toThrow(ConflictException);
    });
  });

  // -------------------------------------------------------------------------
  // auto-trigger wiring
  // -------------------------------------------------------------------------

  describe('onVodReady (auto-transcribe gating)', () => {
    it('does nothing when the plugin is not installed or disabled', async () => {
      const vodId = seedVod();
      service.onVodReady(APP, vodId);
      installPlugin({}, false);
      service.onVodReady(APP, vodId);
      await new Promise((r) => setTimeout(r, 50));
      expect(transcripts.getByVod(APP, vodId)).toBeNull();
    });

    it('does nothing when autoTranscribe is off', async () => {
      installPlugin({ autoTranscribe: false });
      const vodId = seedVod();
      service.onVodReady(APP, vodId);
      await new Promise((r) => setTimeout(r, 50));
      expect(transcripts.getByVod(APP, vodId)).toBeNull();
    });

    it('transcribes automatically when enabled + autoTranscribe', async () => {
      installPlugin({
        provider: 'openai',
        apiKey: 'sk-test',
        autoTranscribe: true,
      });
      const vodId = seedVod();
      service.fetchImpl = fakeOpenAi({
        text: 'auto',
        language: 'en',
        segments: [{ start: 0, end: 1, text: 'auto' }],
      });
      service.onVodReady(APP, vodId);
      const row = await waitForDone(transcripts, vodId);
      expect(row?.status).toBe('ready');
      expect(row?.text).toBe('auto');
    });

    it('never throws into the caller (recording flow safety)', () => {
      ctx.mocks.apps.appDir.mockImplementation(() => {
        throw new Error('disk gone');
      });
      installPlugin();
      expect(() => service.onVodReady(APP, seedVodSafe())).not.toThrow();
    });

    function seedVodSafe(): number {
      // appDir mock throws — build the row via the repository directly.
      return vods.insert(APP, {
        appId: 1,
        streamId: 's',
        room: 'main',
        name: 'x.mp4',
        status: 'recording',
        localPath: null,
        startedAt: new Date().toISOString(),
        metatagsJson: null,
      });
    }
  });

  describe('RecordingService → transcription hook', () => {
    it('pings onVodReady after the upload flow marks the VOD ready', async () => {
      const vodsRepo = new VodsRepository(ctx.db);
      const variants = new VodVariantsRepository(ctx.db);
      const hook = { onVodReady: jest.fn() };
      const recording = new RecordingService(
        ctx.config,
        ctx.db,
        vodsRepo,
        variants,
        ctx.mocks.apps,
        ctx.mocks.livekit,
        ctx.mocks.s3,
        ctx.mocks.logs,
        ctx.mocks.callbacks,
        undefined, // metrics
        undefined, // vodTranscode
        undefined, // livekitTrack
        hook as unknown as TranscriptionService,
      );
      const vodId = seedVod();
      await (
        recording as unknown as {
          processUploadJob(d: { appName: string; vodId: number }): Promise<void>;
        }
      ).processUploadJob({ appName: APP, vodId });
      expect(hook.onVodReady).toHaveBeenCalledWith(APP, vodId);
    });
  });
});

// -----------------------------------------------------------------------------
// Controller wiring — RBAC permissions (the guard enforces; here we lock the
// declared metadata so a refactor can't silently drop the gate).
// -----------------------------------------------------------------------------

describe('TranscriptionController — permissions', () => {
  const reflector = new Reflector();

  it("POST vods/:id/transcribe declares 'vod:write'", () => {
    expect(
      reflector.get(
        REQUIRE_PERMISSION_KEY,
        TranscriptionController.prototype.transcribe,
      ),
    ).toEqual({ resource: 'vod', action: 'write' });
  });

  it("GET vods/:id/transcript declares 'vod:read'", () => {
    expect(
      reflector.get(
        REQUIRE_PERMISSION_KEY,
        TranscriptionController.prototype.transcript,
      ),
    ).toEqual({ resource: 'vod', action: 'read' });
  });

  it("GET vods/:id/transcript.srt declares 'vod:read'", () => {
    expect(
      reflector.get(
        REQUIRE_PERMISSION_KEY,
        TranscriptionController.prototype.transcriptSrt,
      ),
    ).toEqual({ resource: 'vod', action: 'read' });
  });
});
