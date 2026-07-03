/**
 * Unit specs for RecordingService (module recording-s3-vods).
 *
 * Real, isolated per-app SQLite DB (harness makeUnitContext) + a real
 * VodsRepository; every external collaborator is a jest mock: LiveKit egress
 * (EgressClient), S3 client, apps/logs/callbacks. media.util (ffprobe/ffmpeg
 * shell-outs) is mocked so no child process is spawned and probe/snapshot
 * results are deterministic.
 *
 * onModuleInit() is intentionally NOT called: with no BullMQ queue wired, the
 * egress-complete path processes the upload job INLINE (awaited), which makes
 * the whole start → egress_ended → upload → VOD-ready flow deterministic.
 *
 * Coverage:
 *  - start(): guards, room-composite vs participant, streamId default
 *  - split/snapshot config normalization (allowed sets → 0)
 *  - stop() by vod id / egress id, record-live start/stop
 *  - onEgressEvent(): progress/failed/complete + upload flow invariants
 *  - getVod(): public_url vs presigned URL selection + variants/adaptive
 *  - deleteVod(): row + S3 (file + snapshot + variants) + local cleanup
 *  - post-transcode hand-off: enqueue gating (default OFF), deferred local
 *    delete when variants are pending
 */
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import type { AppConfig } from '../../shared/contracts';
import { RecordingService } from './recording.service';
import { VodsRepository, type VodInsert } from './vods.repository';
import { VodVariantsRepository } from './vod-variants.repository';
import type { VodTranscodeService } from './vod-transcode.service';

// media.util spawns ffprobe/ffmpeg — mock it for deterministic, process-free runs.
jest.mock('./media.util', () => ({
  probeMedia: jest.fn(async () => ({
    width: 1920,
    height: 1080,
    durationS: 12.5,
    format: 'h264',
  })),
  extractSnapshot: jest.fn(async (_src: string, out: string) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('fs').writeFileSync(out, 'jpeg-bytes');
    return true;
  }),
}));
import { probeMedia, extractSnapshot } from './media.util';

const APP = 'live';

function makeAppConfig(over: {
  recording?: Partial<AppConfig['recording']>;
  s3?: Partial<AppConfig['s3']>;
  transcoding?: Partial<NonNullable<AppConfig['transcoding']>>;
} = {}): AppConfig {
  return {
    name: APP,
    displayName: 'Live',
    roomPrefix: 'live-',
    recording: {
      enabled: true,
      mode: 'room-composite',
      layout: 'grid',
      localDir: 'recordings',
      deleteLocalAfterUpload: false,
      splitMinutes: 0,
      snapshotSeconds: 0,
      ...over.recording,
    },
    s3: {
      provider: 'aws',
      bucket: 'test-bucket',
      region: 'us-east-1',
      forcePathStyle: false,
      prefix: 'streamhub/live',
      accessKey: 'AK',
      secretKey: 'SK',
      ...over.s3,
    },
    webrtc: { adaptive: false, layers: [] },
    rtmp: { enabled: true, transcode: false },
    // Default = a NEW app: server-side transcoding disabled (passthrough).
    transcoding: {
      enabled: false,
      encoding: 'h264',
      vodAdaptive: false,
      vodRenditions: [],
      ...over.transcoding,
    },
    callbacks: { url: '', secret: '' },
    features: {
      rtmpPassword: false,
      viewerCounter: false,
      chat: false,
      reactions: false,
      hiddenQc: false,
      adaptivePlayer: false,
    },
  };
}

describe('RecordingService', () => {
  let ctx: UnitContext;
  let repo: VodsRepository;
  let variantsRepo: VodVariantsRepository;
  /** Contract mock of the post-transcode pipeline (needed/enqueue only). */
  let vodTranscode: { needed: jest.Mock; enqueue: jest.Mock };
  let svc: RecordingService;
  let appsRoot: string;

  const cfgMock = () => ctx.mocks.apps.getConfig;

  beforeEach(() => {
    ctx = makeUnitContext();
    repo = new VodsRepository(ctx.db);
    variantsRepo = new VodVariantsRepository(ctx.db);
    vodTranscode = {
      needed: jest.fn(() => false),
      enqueue: jest.fn(async () => undefined),
    };
    appsRoot = path.join(ctx.dataDir, 'apps-work');
    ctx.mocks.apps.appDir.mockImplementation((name: string) =>
      path.join(appsRoot, name),
    );
    cfgMock().mockResolvedValue(makeAppConfig());

    (probeMedia as jest.Mock).mockResolvedValue({
      width: 1920,
      height: 1080,
      durationS: 12.5,
      format: 'h264',
    });
    (extractSnapshot as jest.Mock).mockImplementation(
      async (_src: string, out: string) => {
        fs.writeFileSync(out, 'jpeg-bytes');
        return true;
      },
    );

    svc = ctx.newService(
      RecordingService,
      ctx.config,
      ctx.db,
      repo,
      variantsRepo,
      ctx.mocks.apps,
      ctx.mocks.livekit,
      ctx.mocks.s3,
      ctx.mocks.logs,
      ctx.mocks.callbacks,
      undefined,
      vodTranscode as unknown as VodTranscodeService,
    );
  });

  afterEach(async () => {
    await svc.onModuleDestroy(); // clears any live sessions / timers
    ctx.cleanup();
  });

  const dispatched = (event: string) =>
    ctx.mocks.callbacks.dispatch.mock.calls.filter((c) => c[1] === event);
  const meta = (id: number) => JSON.parse(repo.findById(APP, id)!.metatagsJson!);

  /** Materialize the on-disk recording file the upload job expects. */
  function writeLocalFor(vodId: number, bytes = 'mp4-data'): string {
    const vod = repo.findById(APP, vodId)!;
    fs.mkdirSync(path.dirname(vod.localPath!), { recursive: true });
    fs.writeFileSync(vod.localPath!, bytes);
    return vod.localPath!;
  }

  // ---- start() ---------------------------------------------------------
  describe('start()', () => {
    it('rejects when roomName is missing', async () => {
      await expect(
        svc.start({ appName: APP, roomName: '' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when recording is disabled for the app', async () => {
      cfgMock().mockResolvedValue(
        makeAppConfig({ recording: { enabled: false } }),
      );
      await expect(
        svc.start({ appName: APP, roomName: 'room-1' }),
      ).rejects.toThrow(/recording is disabled/);
    });

    it('happy path: launches egress, persists a recording VOD, returns handle', async () => {
      const handle = await svc.start({
        appName: APP,
        roomName: 'room-1',
        streamId: 'stream-1',
      });
      expect(handle).toMatchObject({
        egressId: 'EG_test',
        status: 'recording',
      });
      expect(handle.vodId).toBeGreaterThan(0);

      const vod = repo.findById(APP, handle.vodId)!;
      expect(vod.status).toBe('recording');
      expect(vod.streamId).toBe('stream-1');
      expect(vod.room).toBe('room-1');
      expect(vod.localPath).toContain(
        path.join(appsRoot, APP, 'recordings'),
      );
      expect(vod.localPath!.endsWith('.mp4')).toBe(true);

      const eg = ctx.mocks.livekit.startEgress.mock.calls[0][0];
      expect(eg).toMatchObject({
        appName: APP,
        roomName: 'room-1',
        mode: 'room-composite',
      });
      expect(eg.outputFilepath).toBe(vod.localPath);
      // no snapshots configured → no image output
      expect(eg.snapshotIntervalS).toBeUndefined();

      expect(dispatched('recording_started')).toHaveLength(1);
    });

    it('defaults streamId to roomName when not provided', async () => {
      const handle = await svc.start({ appName: APP, roomName: 'room-x' });
      expect(repo.findById(APP, handle.vodId)!.streamId).toBe('room-x');
    });

    it('participant mode egresses the participant whose identity == streamId', async () => {
      cfgMock().mockResolvedValue(
        makeAppConfig({ recording: { mode: 'participant' } }),
      );
      await svc.start({ appName: APP, roomName: 'room-1', streamId: 'alice' });
      const eg = ctx.mocks.livekit.startEgress.mock.calls[0][0];
      expect(eg.mode).toBe('participant');
      expect(eg.participantIdentity).toBe('alice');
    });

    it('wraps a startEgress failure and persists no VOD', async () => {
      ctx.mocks.livekit.startEgress.mockRejectedValueOnce(
        new Error('egress node down'),
      );
      await expect(
        svc.start({ appName: APP, roomName: 'room-1' }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(repo.list(APP)).toHaveLength(0);
    });
  });

  // ---- split / snapshot config normalization ---------------------------
  describe('split/snapshot config normalization', () => {
    it('keeps an allowed splitMinutes and tags the VOD as a part (p000)', async () => {
      cfgMock().mockResolvedValue(
        makeAppConfig({ recording: { splitMinutes: 30 } }),
      );
      const h = await svc.start({ appName: APP, roomName: 'room-1' });
      const m = meta(h.vodId);
      expect(m.splitMinutes).toBe(30);
      expect(m.isPart).toBe(true);
      expect(m.partIndex).toBe(0);
      expect(repo.findById(APP, h.vodId)!.name).toContain('-p000.mp4');
    });

    it('clamps an out-of-set splitMinutes to 0 (continuous, not a part)', async () => {
      cfgMock().mockResolvedValue(
        makeAppConfig({ recording: { splitMinutes: 45 } }),
      );
      const h = await svc.start({ appName: APP, roomName: 'room-1' });
      const m = meta(h.vodId);
      expect(m.splitMinutes).toBe(0);
      expect(m.isPart).toBe(false);
      expect(repo.findById(APP, h.vodId)!.name).not.toContain('-p');
    });

    it('attaches an image output when snapshotSeconds is in the allowed set', async () => {
      cfgMock().mockResolvedValue(
        makeAppConfig({ recording: { snapshotSeconds: 30 } }),
      );
      const h = await svc.start({ appName: APP, roomName: 'room-1' });
      const eg = ctx.mocks.livekit.startEgress.mock.calls[0][0];
      expect(eg.snapshotIntervalS).toBe(30);
      expect(typeof eg.snapshotFilePrefix).toBe('string');
      expect(meta(h.vodId).snapshotSeconds).toBe(30);
    });

    it('clamps an out-of-set snapshotSeconds to 0 (no image output)', async () => {
      cfgMock().mockResolvedValue(
        makeAppConfig({ recording: { snapshotSeconds: 7 } }),
      );
      const h = await svc.start({ appName: APP, roomName: 'room-1' });
      const eg = ctx.mocks.livekit.startEgress.mock.calls[0][0];
      expect(eg.snapshotIntervalS).toBeUndefined();
      expect(eg.snapshotFilePrefix).toBeUndefined();
      expect(meta(h.vodId).snapshotSeconds).toBe(0);
    });
  });

  // ---- stop() ----------------------------------------------------------
  describe('stop()', () => {
    it('stops egress by numeric vod id (status unchanged, webhook drives upload)', async () => {
      const h = await svc.start({ appName: APP, roomName: 'room-1' });
      const res = await svc.stop(APP, String(h.vodId));
      expect(ctx.mocks.livekit.stopEgress).toHaveBeenCalledWith('EG_test');
      expect(res).toMatchObject({
        vodId: h.vodId,
        egressId: 'EG_test',
        status: 'recording',
      });
    });

    it('stops egress by egress id', async () => {
      await svc.start({ appName: APP, roomName: 'room-1' });
      await svc.stop(APP, 'EG_test');
      expect(ctx.mocks.livekit.stopEgress).toHaveBeenCalledWith('EG_test');
    });

    it('throws NotFound for an unknown recording id', async () => {
      await expect(svc.stop(APP, '99999')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('wraps a stopEgress failure', async () => {
      const h = await svc.start({ appName: APP, roomName: 'room-1' });
      ctx.mocks.livekit.stopEgress.mockRejectedValueOnce(new Error('nope'));
      await expect(svc.stop(APP, String(h.vodId))).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  // ---- record-live (start/stop for a live stream) ----------------------
  describe('record-live', () => {
    it('startForStream records the resolved room and stopForStream stops it', async () => {
      const h = await svc.startForStream(APP, 'streamZ', 'roomZ');
      const vod = repo.findById(APP, h.vodId)!;
      expect(vod.streamId).toBe('streamZ');
      expect(vod.room).toBe('roomZ');

      await svc.stopForStream(APP, 'streamZ');
      expect(ctx.mocks.livekit.stopEgress).toHaveBeenCalledWith('EG_test');
    });

    it('stopForStream throws NotFound when the stream has no in-progress recording', async () => {
      await expect(svc.stopForStream(APP, 'ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ---- onEgressEvent() + upload flow -----------------------------------
  describe('onEgressEvent()', () => {
    it('ignores progress (starting/active) events', async () => {
      const h = await svc.start({ appName: APP, roomName: 'room-1' });
      await svc.onEgressEvent('EG_test', 'EGRESS_ACTIVE', {});
      expect(repo.findById(APP, h.vodId)!.status).toBe('recording');
      expect(dispatched('vod_ready')).toHaveLength(0);
    });

    it('does not throw for an unknown egress id', async () => {
      ctx.mocks.apps.list.mockResolvedValue([]);
      await expect(
        svc.onEgressEvent('EG_unknown', 'EGRESS_ENDED', {}),
      ).resolves.toBeUndefined();
    });

    it('marks the VOD failed on a failed egress and fires recording_failed', async () => {
      const h = await svc.start({ appName: APP, roomName: 'room-1' });
      await svc.onEgressEvent('EG_test', 'EGRESS_FAILED', {
        egressInfo: { error: 'encoder crash' },
      });
      expect(repo.findById(APP, h.vodId)!.status).toBe('failed');
      expect(dispatched('recording_failed')).toHaveLength(1);
    });

    it('complete: uploads mp4 + snapshot, marks ready, fires vod_ready + recording_ready', async () => {
      const h = await svc.start({ appName: APP, roomName: 'room-1' });
      const local = writeLocalFor(h.vodId);
      await svc.onEgressEvent('EG_test', 'EGRESS_ENDED', {});

      const vod = repo.findById(APP, h.vodId)!;
      expect(vod.status).toBe('ready');
      expect(vod.fileKey).toBe(path.basename(local));
      expect(vod.snapshotKey).toBe(
        `${path.basename(local, '.mp4')}.jpg`,
      );
      expect(vod.durationS).toBe(12.5);
      expect(vod.width).toBe(1920);
      expect(vod.format).toBe('h264');

      // both objects uploaded: mp4 (video/mp4) + snapshot (image/jpeg)
      const cts = ctx.mocks.s3.upload.mock.calls.map((c) => c[3]);
      expect(cts).toContain('video/mp4');
      expect(cts).toContain('image/jpeg');

      expect(dispatched('vod_ready')).toHaveLength(1);
      // non-split single file → final recording event
      expect(dispatched('recording_ready')).toHaveLength(1);
      expect(dispatched('recording_part_ready')).toHaveLength(0);
    });

    it('complete: marks failed when the local recording file is missing', async () => {
      const h = await svc.start({ appName: APP, roomName: 'room-1' });
      // note: no writeLocalFor → the file was never produced
      await svc.onEgressEvent('EG_test', 'EGRESS_ENDED', {});
      expect(repo.findById(APP, h.vodId)!.status).toBe('failed');
      expect(dispatched('recording_failed')).toHaveLength(1);
      expect(dispatched('vod_ready')).toHaveLength(0);
    });

    it('complete: an upload failure marks failed and KEEPS the local file (SPEC §8.4)', async () => {
      (extractSnapshot as jest.Mock).mockResolvedValue(false); // isolate the mp4 upload
      const h = await svc.start({ appName: APP, roomName: 'room-1' });
      const local = writeLocalFor(h.vodId);
      ctx.mocks.s3.upload.mockRejectedValue(new Error('s3 500'));

      await svc.onEgressEvent('EG_test', 'EGRESS_ENDED', {});

      expect(repo.findById(APP, h.vodId)!.status).toBe('failed');
      expect(fs.existsSync(local)).toBe(true); // local preserved for retry
      expect(dispatched('recording_failed')).toHaveLength(1);
    });

    it('complete: deletes the local file after a successful upload when configured', async () => {
      (extractSnapshot as jest.Mock).mockResolvedValue(false);
      cfgMock().mockResolvedValue(
        makeAppConfig({ recording: { deleteLocalAfterUpload: true } }),
      );
      const h = await svc.start({ appName: APP, roomName: 'room-1' });
      const local = writeLocalFor(h.vodId);

      await svc.onEgressEvent('EG_test', 'EGRESS_ENDED', {});

      const vod = repo.findById(APP, h.vodId)!;
      expect(vod.status).toBe('ready');
      expect(fs.existsSync(local)).toBe(false);
      expect(vod.localPath).toBeNull();
    });
  });

  // ---- post-transcode hand-off (adaptive VOD / h264+vp8) ----------------
  describe('post-transcode hand-off', () => {
    it('DEFAULT: transcoding disabled → upload flow never enqueues a transcode job', async () => {
      (extractSnapshot as jest.Mock).mockResolvedValue(false);
      cfgMock().mockResolvedValue(
        makeAppConfig({ recording: { deleteLocalAfterUpload: true } }),
      );
      const h = await svc.start({ appName: APP, roomName: 'room-1' });
      const local = writeLocalFor(h.vodId);

      await svc.onEgressEvent('EG_test', 'EGRESS_ENDED', {});

      expect(vodTranscode.enqueue).not.toHaveBeenCalled();
      // default behaviour untouched: local deleted right after the upload
      expect(fs.existsSync(local)).toBe(false);
      expect(repo.findById(APP, h.vodId)!.localPath).toBeNull();
    });

    it('opt-in: enqueues the variants job AFTER ready and DEFERS the local delete', async () => {
      (extractSnapshot as jest.Mock).mockResolvedValue(false);
      const cfg = makeAppConfig({
        recording: { deleteLocalAfterUpload: true },
        transcoding: { enabled: true, encoding: 'h264+vp8', vodAdaptive: true },
      });
      cfgMock().mockResolvedValue(cfg);
      vodTranscode.needed.mockReturnValue(true);

      const h = await svc.start({ appName: APP, roomName: 'room-1' });
      const local = writeLocalFor(h.vodId);

      await svc.onEgressEvent('EG_test', 'EGRESS_ENDED', {});

      const vod = repo.findById(APP, h.vodId)!;
      expect(vod.status).toBe('ready'); // base MP4 flow completed first
      expect(vodTranscode.needed).toHaveBeenCalledWith(cfg);
      expect(vodTranscode.enqueue).toHaveBeenCalledWith({
        appName: APP,
        vodId: h.vodId,
        sourcePath: local,
        deleteSourceAfter: true, // the job owns the deferred delete
      });
      // the source survives for the transcode job (delete deferred)
      expect(fs.existsSync(local)).toBe(true);
      expect(vod.localPath).toBe(local);
    });

    it('opt-in without delete_local_after_upload keeps the source too', async () => {
      (extractSnapshot as jest.Mock).mockResolvedValue(false);
      cfgMock().mockResolvedValue(
        makeAppConfig({
          transcoding: { enabled: true, vodAdaptive: true },
        }),
      );
      vodTranscode.needed.mockReturnValue(true);
      const h = await svc.start({ appName: APP, roomName: 'room-1' });
      const local = writeLocalFor(h.vodId);

      await svc.onEgressEvent('EG_test', 'EGRESS_ENDED', {});

      expect(vodTranscode.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ deleteSourceAfter: false }),
      );
      expect(fs.existsSync(local)).toBe(true);
    });
  });

  // ---- getVod(): public_url vs presigned -------------------------------
  describe('getVod() playback URL selection', () => {
    function seedReadyVod(fileKey = 'streamhub/live/rec.mp4'): number {
      const base: VodInsert = {
        appId: 1,
        streamId: 's',
        room: 'r',
        name: 'rec.mp4',
        status: 'recording',
        localPath: null,
        startedAt: new Date().toISOString(),
        metatagsJson: JSON.stringify({ egressId: 'EG_x' }),
      };
      const id = repo.insert(APP, base);
      repo.update(APP, id, { status: 'ready', fileKey });
      return id;
    }

    it('prefers the deterministic public URL when s3.publicUrl is set', async () => {
      cfgMock().mockResolvedValue(
        makeAppConfig({ s3: { publicUrl: 'https://cdn.example.com' } }),
      );
      const id = seedReadyVod();
      const res = await svc.getVod(APP, id);
      expect(res.publicUrl).toBe(
        'https://cdn.example.com/streamhub/live/rec.mp4',
      );
      expect(res.presignedUrl).toBe(
        'https://s3.test/streamhub/live/rec.mp4?sig=test',
      );
      expect(res.url).toBe(res.publicUrl); // public wins
    });

    it('falls back to the presigned URL when no public base is configured', async () => {
      const id = seedReadyVod();
      const res = await svc.getVod(APP, id);
      expect(res.publicUrl).toBeNull();
      expect(res.presignedUrl).toBe(
        'https://s3.test/streamhub/live/rec.mp4?sig=test',
      );
      expect(res.url).toBe(res.presignedUrl);
    });

    it('exposes no URLs while the VOD is not ready', async () => {
      const id = seedReadyVod();
      repo.update(APP, id, { status: 'uploading' });
      const res = await svc.getVod(APP, id);
      expect(res.url).toBeNull();
      expect(res.presignedUrl).toBeNull();
      expect(res.publicUrl).toBeNull();
      expect(ctx.mocks.s3.presignGet).not.toHaveBeenCalled();
    });

    it('degrades to null URLs when presigning fails (no public base)', async () => {
      ctx.mocks.s3.presignGet.mockRejectedValueOnce(new Error('sig fail'));
      const id = seedReadyVod();
      const res = await svc.getVod(APP, id);
      expect(res.url).toBeNull();
      expect(res.presignedUrl).toBeNull();
    });

    it('throws NotFound for a missing VOD', async () => {
      await expect(svc.getVod(APP, 12345)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('has no variants / adaptive when nothing was transcoded', async () => {
      const id = seedReadyVod();
      const res = await svc.getVod(APP, id);
      expect(res.variants).toEqual([]);
      expect(res.adaptive).toBeNull();
    });

    it('exposes master + renditions + alternates with public-base URLs', async () => {
      cfgMock().mockResolvedValue(
        makeAppConfig({ s3: { publicUrl: 'https://cdn.example.com' } }),
      );
      const id = seedReadyVod();
      variantsRepo.insert(APP, {
        vodId: id,
        kind: 'rendition',
        format: 'hls-h264',
        height: 720,
        bitrateKbps: 2800,
        fileKey: 'hls/rec/720p/index.m3u8',
        extraJson: JSON.stringify({
          segmentKeys: ['hls/rec/720p/seg_0000.ts'],
        }),
      });
      variantsRepo.insert(APP, {
        vodId: id,
        kind: 'master',
        format: 'hls',
        fileKey: 'hls/rec/master.m3u8',
      });
      variantsRepo.insert(APP, {
        vodId: id,
        kind: 'alternate',
        format: 'webm-vp8',
        height: 1080,
        bitrateKbps: 2800,
        fileKey: 'rec.webm',
      });

      const res = await svc.getVod(APP, id);

      // presentation order: master, renditions (height desc), alternates
      expect(res.variants.map((v) => v.kind)).toEqual([
        'master',
        'rendition',
        'alternate',
      ]);
      expect(res.adaptive).toEqual({
        masterKey: 'hls/rec/master.m3u8',
        masterUrl: 'https://cdn.example.com/hls/rec/master.m3u8',
      });
      expect(res.variants[1]).toMatchObject({
        format: 'hls-h264',
        height: 720,
        bitrateKbps: 2800,
        key: 'hls/rec/720p/index.m3u8',
        url: 'https://cdn.example.com/hls/rec/720p/index.m3u8',
      });
      expect(res.variants[2].url).toBe('https://cdn.example.com/rec.webm');
    });

    it('without a public base: master/alternate presigned, renditions urlless', async () => {
      const id = seedReadyVod();
      variantsRepo.insert(APP, {
        vodId: id,
        kind: 'master',
        format: 'hls',
        fileKey: 'hls/rec/master.m3u8',
      });
      variantsRepo.insert(APP, {
        vodId: id,
        kind: 'rendition',
        format: 'hls-h264',
        height: 720,
        bitrateKbps: 2800,
        fileKey: 'hls/rec/720p/index.m3u8',
      });
      variantsRepo.insert(APP, {
        vodId: id,
        kind: 'alternate',
        format: 'webm-vp8',
        fileKey: 'rec.webm',
      });

      const res = await svc.getVod(APP, id);

      expect(res.adaptive!.masterUrl).toBe(
        'https://s3.test/hls/rec/master.m3u8?sig=test',
      );
      const rendition = res.variants.find((v) => v.kind === 'rendition')!;
      // HLS segments resolve relative to the playlist → presigning a rendition
      // playlist is useless without a public base; no URL is exposed.
      expect(rendition.url).toBeNull();
      const alternate = res.variants.find((v) => v.kind === 'alternate')!;
      expect(alternate.url).toBe('https://s3.test/rec.webm?sig=test');
    });
  });

  // ---- deleteVod() -----------------------------------------------------
  describe('deleteVod()', () => {
    it('deletes the row, both S3 objects (file + snapshot) and the local file', async () => {
      const local = path.join(appsRoot, APP, 'recordings', 'del.mp4');
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, 'x');
      const id = repo.insert(APP, {
        appId: 1,
        streamId: 's',
        room: 'r',
        name: 'del.mp4',
        status: 'ready',
        localPath: local,
        startedAt: new Date().toISOString(),
        metatagsJson: '{}',
      });
      repo.update(APP, id, {
        fileKey: 'streamhub/live/del.mp4',
        snapshotKey: 'streamhub/live/del.jpg',
      });

      // A co-located local snapshot (<base>.jpg under snapshots/) is cascaded too.
      const snapLocal = path.join(appsRoot, APP, 'snapshots', 'del.jpg');
      fs.mkdirSync(path.dirname(snapLocal), { recursive: true });
      fs.writeFileSync(snapLocal, 'jpg');

      const res = await svc.deleteVod(APP, id);
      expect(res).toEqual({ deleted: true, s3Deleted: 2, localDeleted: true });

      const deletedKeys = ctx.mocks.s3.delete.mock.calls.map((c) => c[1]);
      expect(deletedKeys).toEqual(
        expect.arrayContaining([
          'streamhub/live/del.mp4',
          'streamhub/live/del.jpg',
        ]),
      );
      expect(fs.existsSync(local)).toBe(false);
      expect(fs.existsSync(snapLocal)).toBe(false);
      expect(repo.findById(APP, id)).toBeNull();
    });

    it('reports s3Deleted=0 / localDeleted=false when the VOD has no objects', async () => {
      const id = repo.insert(APP, {
        appId: 1,
        streamId: 's',
        room: 'r',
        name: 'bare.mp4',
        status: 'failed',
        localPath: null,
        startedAt: new Date().toISOString(),
        metatagsJson: '{}',
      });
      const res = await svc.deleteVod(APP, id);
      expect(res).toEqual({ deleted: true, s3Deleted: 0, localDeleted: false });
      expect(ctx.mocks.s3.delete).not.toHaveBeenCalled();
      expect(repo.findById(APP, id)).toBeNull();
    });

    it('throws NotFound for a missing VOD', async () => {
      await expect(svc.deleteVod(APP, 777)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('cascades variant S3 objects (playlists + segments + webm) and their rows', async () => {
      const id = repo.insert(APP, {
        appId: 1,
        streamId: 's',
        room: 'r',
        name: 'var.mp4',
        status: 'ready',
        localPath: null,
        startedAt: new Date().toISOString(),
        metatagsJson: '{}',
      });
      repo.update(APP, id, { fileKey: 'var.mp4' });
      variantsRepo.insert(APP, {
        vodId: id,
        kind: 'master',
        format: 'hls',
        fileKey: 'hls/var/master.m3u8',
      });
      variantsRepo.insert(APP, {
        vodId: id,
        kind: 'rendition',
        format: 'hls-h264',
        height: 720,
        bitrateKbps: 2800,
        fileKey: 'hls/var/720p/index.m3u8',
        extraJson: JSON.stringify({
          segmentKeys: ['hls/var/720p/seg_0000.ts', 'hls/var/720p/seg_0001.ts'],
        }),
      });
      variantsRepo.insert(APP, {
        vodId: id,
        kind: 'alternate',
        format: 'webm-vp8',
        fileKey: 'var.webm',
      });

      const res = await svc.deleteVod(APP, id);

      // mp4 + master + rendition playlist + 2 segments + webm = 6 objects
      expect(res.s3Deleted).toBe(6);
      const deletedKeys = ctx.mocks.s3.delete.mock.calls.map((c) => c[1]);
      expect(deletedKeys).toEqual(
        expect.arrayContaining([
          'var.mp4',
          'hls/var/master.m3u8',
          'hls/var/720p/index.m3u8',
          'hls/var/720p/seg_0000.ts',
          'hls/var/720p/seg_0001.ts',
          'var.webm',
        ]),
      );
      expect(variantsRepo.listByVod(APP, id)).toHaveLength(0);
      expect(repo.findById(APP, id)).toBeNull();
    });
  });

  // ---- listVods() paging + filters -------------------------------------
  describe('listVods()', () => {
    function seedVod(over: Partial<VodInsert>): number {
      return repo.insert(APP, {
        appId: 1,
        streamId: 's',
        room: 'r',
        name: 'rec.mp4',
        status: 'ready',
        localPath: null,
        startedAt: new Date().toISOString(),
        metatagsJson: '{}',
        ...over,
      });
    }

    it('returns { data, total, limit, offset } and clamps limit/offset', () => {
      for (let i = 0; i < 5; i++) seedVod({ name: `v-${i}.mp4` });
      const page = svc.listVods(APP, { limit: 2, offset: 1 });
      expect(page.data).toHaveLength(2);
      expect(page.total).toBe(5);
      expect(page.limit).toBe(2);
      expect(page.offset).toBe(1);

      // Out-of-range limit is clamped (not rejected).
      expect(svc.listVods(APP, { limit: 99999 }).limit).toBe(1000);
      expect(svc.listVods(APP, { limit: 0 }).limit).toBe(1);
      expect(svc.listVods(APP, { offset: -5 }).offset).toBe(0);
    });

    it('total reflects the filtered set, not the page size', () => {
      seedVod({ room: 'a' });
      seedVod({ room: 'a' });
      seedVod({ room: 'b' });
      const page = svc.listVods(APP, { room: 'a', limit: 1 });
      expect(page.data).toHaveLength(1);
      expect(page.total).toBe(2);
    });

    it('all=true returns every row; reported limit = row count, offset = 0', () => {
      for (let i = 0; i < 4; i++) seedVod({ name: `a-${i}.mp4` });
      const page = svc.listVods(APP, { all: true, limit: 2, offset: 2 });
      expect(page.data).toHaveLength(4);
      expect(page.total).toBe(4);
      expect(page.limit).toBe(4);
      expect(page.offset).toBe(0);
    });
  });

  // ---- getDownload() + openLocalRaw() ----------------------------------
  describe('getDownload() / openLocalRaw()', () => {
    function seedVod(over: Partial<VodInsert>, patch: Partial<VodInsert> = {}): number {
      const id = repo.insert(APP, {
        appId: 1,
        streamId: 's',
        room: 'live-room',
        name: 'clip.mp4',
        status: 'recording',
        localPath: null,
        startedAt: new Date().toISOString(),
        metatagsJson: '{}',
        ...over,
      });
      return id;
    }

    it('S3-backed ready VOD → presigned attachment URL (7d shape)', async () => {
      const id = seedVod({});
      repo.update(APP, id, { status: 'ready', fileKey: 'streamhub/live/clip.mp4' });

      const dl = await svc.getDownload(APP, id);
      expect(dl).toMatchObject({
        source: 's3',
        filename: `clip-${id}.mp4`,
        expiresInSeconds: 3600,
      });
      expect(dl.source === 's3' && dl.url).toContain('streamhub/live/clip.mp4');

      // presignGet was asked for an attachment disposition with the filename.
      const call = ctx.mocks.s3.presignGet.mock.calls[0];
      expect(call[1]).toBe('streamhub/live/clip.mp4');
      expect(call[3]).toMatchObject({
        responseContentDisposition: `attachment; filename="clip-${id}.mp4"`,
      });
    });

    it('local-only ready VOD → source local with the same filename', async () => {
      const local = path.join(appsRoot, APP, 'recordings', 'localclip.mp4');
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, 'mp4-bytes');
      const id = seedVod({ name: 'localclip.mp4' });
      repo.update(APP, id, { status: 'ready', localPath: local });

      const dl = await svc.getDownload(APP, id);
      expect(dl).toEqual({ source: 'local', filename: `localclip-${id}.mp4` });
      expect(ctx.mocks.s3.presignGet).not.toHaveBeenCalled();
    });

    it('throws 409 (Conflict) when the VOD is not ready', async () => {
      const id = seedVod({});
      repo.update(APP, id, { status: 'uploading', fileKey: 'k.mp4' });
      await expect(svc.getDownload(APP, id)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('throws 404 for a missing VOD', async () => {
      await expect(svc.getDownload(APP, 4242)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws 404 when ready but has no S3 object and no local file', async () => {
      const id = seedVod({});
      repo.update(APP, id, { status: 'ready', localPath: '/nope/missing.mp4' });
      await expect(svc.getDownload(APP, id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('openLocalRaw returns the local descriptor for a ready file', () => {
      const local = path.join(appsRoot, APP, 'recordings', 'raw.mp4');
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, 'mp4-bytes');
      const id = seedVod({ name: 'raw.mp4' });
      repo.update(APP, id, { status: 'ready', localPath: local });

      expect(svc.openLocalRaw(APP, id)).toEqual({
        localPath: local,
        filename: `raw-${id}.mp4`,
        contentType: 'video/mp4',
      });
    });

    it('openLocalRaw throws 409 for a not-ready VOD, 404 when no file', () => {
      const id = seedVod({});
      repo.update(APP, id, { status: 'recording', localPath: '/x/none.mp4' });
      expect(() => svc.openLocalRaw(APP, id)).toThrow(ConflictException);

      repo.update(APP, id, { status: 'ready' });
      expect(() => svc.openLocalRaw(APP, id)).toThrow(NotFoundException);
    });
  });
});
