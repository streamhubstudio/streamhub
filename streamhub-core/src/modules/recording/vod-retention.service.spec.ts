/**
 * Unit specs for the VOD retention janitor (module recording).
 *
 * Real per-app SQLite (makeUnitContext) + real VodsRepository + a real
 * RecordingService so the delete CASCADE (S3 best-effort → DB row always) is
 * exercised end-to-end; S3/apps/logs/callbacks are jest mocks. media.util is
 * mocked (deleteVod never shells out). A FIXED clock drives the window math.
 */
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import type { AppConfig } from '../../shared/contracts';
import { RecordingService } from './recording.service';
import {
  VodRetentionService,
  retentionCutoffIso,
} from './vod-retention.service';
import { VodsRepository, type VodInsert } from './vods.repository';
import { VodVariantsRepository } from './vod-variants.repository';
import type { VodStatus } from '../../shared/contracts';

jest.mock('./media.util', () => ({
  probeMedia: jest.fn(),
  extractSnapshot: jest.fn(),
}));

const APP = 'live';
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 6, 13, 12, 0, 0); // fixed clock

function makeCfg(retentionDays: number): AppConfig {
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
      retentionDays,
    },
    s3: {
      provider: 'aws',
      bucket: 'b',
      region: 'us-east-1',
      forcePathStyle: false,
      prefix: 'streamhub/live',
      accessKey: 'AK',
      secretKey: 'SK',
    },
    webrtc: { adaptive: false, layers: [] },
    rtmp: { enabled: true, transcode: false },
    transcoding: { enabled: false, encoding: 'h264', vodAdaptive: false, vodRenditions: [] },
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

describe('VodRetentionService', () => {
  let ctx: UnitContext;
  let repo: VodsRepository;
  let recording: RecordingService;
  let svc: VodRetentionService;

  function seedVod(startedAtMs: number, status: VodStatus = 'ready'): number {
    const base: VodInsert = {
      appId: 1,
      streamId: 's',
      room: 'r',
      name: 'rec.mp4',
      status: 'recording',
      localPath: null,
      startedAt: new Date(startedAtMs).toISOString(),
      metatagsJson: null,
    };
    const id = repo.insert(APP, base);
    repo.update(APP, id, { status, fileKey: `streamhub/live/${id}.mp4` });
    return id;
  }

  beforeEach(() => {
    ctx = makeUnitContext();
    repo = new VodsRepository(ctx.db);
    const variantsRepo = new VodVariantsRepository(ctx.db);
    recording = ctx.newService(
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
    );
    ctx.mocks.apps.list.mockResolvedValue([{ name: APP }]);
    ctx.mocks.apps.appDir.mockReturnValue('/tmp/streamhub-apps/live');
    svc = ctx.newService(
      VodRetentionService,
      ctx.config,
      repo,
      recording,
      ctx.mocks.apps,
      ctx.mocks.logs,
    );
  });

  describe('retentionCutoffIso (pure)', () => {
    it('returns null when retention is off (<= 0)', () => {
      expect(retentionCutoffIso(NOW, 0)).toBeNull();
      expect(retentionCutoffIso(NOW, -1)).toBeNull();
    });
    it('subtracts N days from now', () => {
      expect(retentionCutoffIso(NOW, 30)).toBe(
        new Date(NOW - 30 * DAY).toISOString(),
      );
    });
  });

  it('does nothing when retention is OFF (0) — keeps every VOD', async () => {
    ctx.mocks.apps.getConfig.mockResolvedValue(makeCfg(0));
    const old = seedVod(NOW - 400 * DAY);
    const res = await svc.sweepOnce(NOW);
    expect(res).toEqual({ apps: 0, deleted: 0 });
    expect(repo.findById(APP, old)).not.toBeNull();
  });

  it('deletes VODs older than the window, keeps the recent ones', async () => {
    ctx.mocks.apps.getConfig.mockResolvedValue(makeCfg(30));
    const stale = seedVod(NOW - 100 * DAY);
    const fresh = seedVod(NOW - 1 * DAY);

    const res = await svc.sweepOnce(NOW);

    expect(res.apps).toBe(1);
    expect(res.deleted).toBe(1);
    expect(repo.findById(APP, stale)).toBeNull(); // DB row gone
    expect(repo.findById(APP, fresh)).not.toBeNull();
    // S3 object deletion attempted for the expired VOD's key.
    expect(ctx.mocks.s3.delete).toHaveBeenCalledWith(
      expect.anything(),
      `streamhub/live/${stale}.mp4`,
    );
  });

  it('removes the DB row even when the S3 delete fails (best-effort S3)', async () => {
    ctx.mocks.apps.getConfig.mockResolvedValue(makeCfg(7));
    const stale = seedVod(NOW - 30 * DAY);
    ctx.mocks.s3.delete.mockRejectedValue(new Error('s3 unreachable'));

    const res = await svc.sweepOnce(NOW);

    expect(res.deleted).toBe(1);
    expect(repo.findById(APP, stale)).toBeNull(); // row goes regardless
  });

  it('never touches an in-flight (recording/uploading) VOD, even if old', async () => {
    ctx.mocks.apps.getConfig.mockResolvedValue(makeCfg(7));
    const uploading = seedVod(NOW - 90 * DAY, 'uploading');
    const recordingRow = seedVod(NOW - 90 * DAY, 'recording');

    const res = await svc.sweepOnce(NOW);

    expect(res.deleted).toBe(0);
    expect(repo.findById(APP, uploading)).not.toBeNull();
    expect(repo.findById(APP, recordingRow)).not.toBeNull();
  });

  it('is resilient: a getConfig failure skips the app without throwing', async () => {
    ctx.mocks.apps.getConfig.mockRejectedValue(new Error('config gone'));
    await expect(svc.sweepOnce(NOW)).resolves.toEqual({ apps: 0, deleted: 0 });
  });
});
