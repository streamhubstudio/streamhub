/**
 * Unit spec — POST /apps/:app/vods/:id/probe (backfill de metadata de VODs).
 *
 * VODs grabados ANTES del pipeline de metadata no tienen duration_s ni
 * dimensiones; la UI de Grabaciones necesita poder completarlos on-demand.
 * Pins:
 *   1. permission metadata: vod:write on the controller handler,
 *   2. local file present → ffprobe over the local path, row backfilled,
 *   3. no local file but S3 object → ffprobe over a presigned URL,
 *   4. probe failure (all-null) → probed:false and the row is untouched,
 *   5. no media at all → 404; unknown vod → 404,
 *   6. existing `format` is never clobbered by a re-probe.
 *
 * Same harness as recording.service.spec.ts: real temp per-app SQLite +
 * VodsRepository, media.util (ffprobe) mocked — no child process is spawned.
 */
import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as fs from 'fs';
import * as path from 'path';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { RecordingController } from './recording.controller';
import { RecordingService } from './recording.service';
import { VodsRepository, type VodInsert } from './vods.repository';
import { VodVariantsRepository } from './vod-variants.repository';
import {
  REQUIRE_PERMISSION_KEY,
  type RequiredPermission,
} from '../authz/permission.decorator';

// media.util spawns ffprobe/ffmpeg — mock it for deterministic runs.
jest.mock('./media.util', () => ({
  probeMedia: jest.fn(async () => ({
    width: 1920,
    height: 1080,
    durationS: 754.2,
    format: 'h264',
  })),
  extractSnapshot: jest.fn(async () => false),
}));
import { probeMedia } from './media.util';

const APP = 'live';

describe('RecordingService.probeVod', () => {
  let ctx: UnitContext;
  let repo: VodsRepository;
  let svc: RecordingService;

  beforeEach(() => {
    ctx = makeUnitContext();
    repo = new VodsRepository(ctx.db);
    ctx.mocks.apps.appDir.mockImplementation((name: string) =>
      path.join(ctx.dataDir, 'apps-work', name),
    );
    ctx.mocks.apps.getConfig.mockResolvedValue({
      name: APP,
      s3: { bucket: 'b', prefix: '' },
      recording: { enabled: true },
    } as never);
    (probeMedia as jest.Mock).mockResolvedValue({
      width: 1920,
      height: 1080,
      durationS: 754.2,
      format: 'h264',
    });

    svc = ctx.newService(
      RecordingService,
      ctx.config,
      ctx.db,
      repo,
      new VodVariantsRepository(ctx.db),
      ctx.mocks.apps,
      ctx.mocks.livekit,
      ctx.mocks.s3,
      ctx.mocks.logs,
      ctx.mocks.callbacks,
    );
  });

  afterEach(async () => {
    await svc.onModuleDestroy();
    ctx.cleanup();
  });

  /** Insert a legacy VOD row (no duration/dimensions). */
  function seedVod(over: Partial<VodInsert> & { fileKey?: string } = {}): number {
    const id = repo.insert(APP, {
      appId: 1,
      streamId: 'room1/pub',
      room: 'room1',
      name: 'legacy.mp4',
      status: 'ready',
      localPath: over.localPath ?? null,
      startedAt: '2025-11-01T10:00:00.000Z',
      metatagsJson: null,
      ...over,
    });
    if (over.fileKey) repo.update(APP, id, { fileKey: over.fileKey });
    return id;
  }

  /** Write a fake local recording file and return its path. */
  function localFile(): string {
    const dir = path.join(ctx.dataDir, 'recordings');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'legacy.mp4');
    fs.writeFileSync(p, 'mp4-bytes');
    return p;
  }

  it('is guarded by vod:write on the controller handler', () => {
    const perm = new Reflector().get<RequiredPermission>(
      REQUIRE_PERMISSION_KEY,
      RecordingController.prototype.probeVod,
    );
    expect(perm).toEqual({ resource: 'vod', action: 'write' });
  });

  it('probes the LOCAL file when present and backfills the row', async () => {
    const p = localFile();
    const id = seedVod({ localPath: p });

    const res = await svc.probeVod(APP, id);

    expect(probeMedia).toHaveBeenCalledWith(p);
    expect(ctx.mocks.s3.presignGet).not.toHaveBeenCalled();
    expect(res.probed).toBe(true);
    expect(res.durationS).toBeCloseTo(754.2);
    expect(res.width).toBe(1920);
    expect(res.height).toBe(1080);
    expect(res.format).toBe('h264');

    const row = repo.findById(APP, id);
    expect(row?.durationS).toBeCloseTo(754.2);
    expect(row?.width).toBe(1920);
  });

  it('falls back to a presigned S3 URL when there is no local file', async () => {
    const id = seedVod({ fileKey: 'streamhub/live/legacy.mp4' });

    const res = await svc.probeVod(APP, id);

    expect(ctx.mocks.s3.presignGet).toHaveBeenCalledTimes(1);
    const url = await (ctx.mocks.s3.presignGet as jest.Mock).mock.results[0]
      .value;
    expect(probeMedia).toHaveBeenCalledWith(url);
    expect(res.probed).toBe(true);
    expect(repo.findById(APP, id)?.durationS).toBeCloseTo(754.2);
  });

  it('is best-effort: a failed probe leaves the row untouched (probed:false)', async () => {
    (probeMedia as jest.Mock).mockResolvedValue({
      width: null,
      height: null,
      durationS: null,
      format: null,
    });
    const id = seedVod({ localPath: localFile() });

    const res = await svc.probeVod(APP, id);

    expect(res.probed).toBe(false);
    const row = repo.findById(APP, id);
    expect(row?.durationS).toBeNull();
    expect(row?.width).toBeNull();
  });

  it('never clobbers an existing format on re-probe', async () => {
    const id = seedVod({ localPath: localFile() });
    repo.update(APP, id, { format: 'hevc' });

    const res = await svc.probeVod(APP, id);

    expect(res.probed).toBe(true); // duration still backfilled
    expect(repo.findById(APP, id)?.format).toBe('hevc');
  });

  it('404s when the VOD has no media at all, and for unknown ids', async () => {
    const id = seedVod({}); // no localPath, no fileKey
    await expect(svc.probeVod(APP, id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.probeVod(APP, 99_999)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(probeMedia).not.toHaveBeenCalled();
  });
});
