/**
 * Unit specs for VodTranscodeService (feature transcoding-adaptive-vod).
 *
 * Real, isolated per-app SQLite DB (harness makeUnitContext) + real
 * VodsRepository / VodVariantsRepository; ffmpeg shell-outs
 * (transcodeHlsRendition / transcodeWebmVp8, media.util probe) are jest-mocked
 * so no child process is spawned — the mocks materialize realistic playlist /
 * segment / webm files on disk. S3 / apps / logs / callbacks are contract
 * mocks. onModuleInit() is NOT called, so enqueue() processes jobs INLINE
 * (awaited) — the whole pipeline is deterministic.
 *
 * Coverage:
 *  - planFor()/needed(): master-switch gating, encoding h264 vs h264+vp8,
 *    ladder from vod_renditions vs derived from webrtc.layers.
 *  - adaptive pipeline: N HLS renditions + master playlist (content checked),
 *    segment uploads, vod_variants rows, metatags, vod_variants_ready callback.
 *  - h264+vp8 pipeline: WebM/VP8 alternate variant (video/webm upload).
 *  - deleteSourceAfter honored (source removed + vods.local_path nulled).
 *  - degradation: failed rendition skipped; nothing generated → error logged,
 *    VOD left `ready`, no variant rows.
 *  - DRM wiring (features.drm): fail-closed `skip` ships NO variants (webm
 *    included), fail-open degrades to the unchanged clear path, `encrypt`
 *    swaps the clear ladder for the shaka CMAF output (key VALUES never
 *    persisted). DrmService.decide is spied — its guard chain has its own
 *    suite (drm/drm.service.spec.ts).
 */
import * as fs from 'fs';
import * as path from 'path';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import type { AppConfig } from '../../shared/contracts';
import { DrmService, type DrmPackagingContext } from './drm/drm.service';
import { VodTranscodeService } from './vod-transcode.service';
import { VodsRepository } from './vods.repository';
import { VodVariantsRepository } from './vod-variants.repository';

// ffmpeg shell-outs → deterministic, process-free fakes that write real files.
jest.mock('./vod-transcode.util', () => {
  const actual = jest.requireActual('./vod-transcode.util');
  return {
    ...actual,
    transcodeHlsRendition: jest.fn(),
    transcodeRenditionMp4: jest.fn(),
    transcodeWebmVp8: jest.fn(),
  };
});
// shaka-packager shell-out → fake that materializes the packaged tree.
jest.mock('./drm/drm-packager.util', () => {
  const actual = jest.requireActual('./drm/drm-packager.util');
  return {
    ...actual,
    isShakaPackagerAvailable: jest.fn(async () => false),
    packageDrmHls: jest.fn(async () => false),
  };
});
jest.mock('./media.util', () => ({
  probeMedia: jest.fn(async () => ({
    width: 1920,
    height: 1080,
    durationS: 60,
    format: 'h264',
  })),
  extractSnapshot: jest.fn(async () => true),
}));
import {
  transcodeHlsRendition,
  transcodeRenditionMp4,
  transcodeWebmVp8,
} from './vod-transcode.util';
import { packageDrmHls } from './drm/drm-packager.util';

const APP = 'live';

function makeAppConfig(over: {
  transcoding?: Partial<NonNullable<AppConfig['transcoding']>>;
  recording?: Partial<AppConfig['recording']>;
  s3?: Partial<AppConfig['s3']>;
  webrtc?: Partial<AppConfig['webrtc']>;
  features?: Partial<AppConfig['features']>;
} = {}): AppConfig {
  return {
    name: APP,
    displayName: 'Live',
    roomPrefix: 'live',
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
    webrtc: { adaptive: false, layers: [], ...over.webrtc },
    rtmp: { enabled: true, transcode: false },
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
      publicPlayback: true,
      ...over.features,
    },
  };
}

interface CapturedUpload {
  key: string;
  contentType?: string;
  /** Playlist content snapshotted at upload time (workdir is wiped after). */
  content?: string;
}

describe('VodTranscodeService', () => {
  let ctx: UnitContext;
  let vods: VodsRepository;
  let variants: VodVariantsRepository;
  let svc: VodTranscodeService;
  let drmSvc: DrmService;
  let appsRoot: string;
  let uploads: CapturedUpload[];

  const cfgMock = () => ctx.mocks.apps.getConfig;

  beforeEach(() => {
    ctx = makeUnitContext();
    vods = new VodsRepository(ctx.db);
    variants = new VodVariantsRepository(ctx.db);
    appsRoot = path.join(ctx.dataDir, 'apps-work');
    ctx.mocks.apps.appDir.mockImplementation((name: string) =>
      path.join(appsRoot, name),
    );
    cfgMock().mockResolvedValue(makeAppConfig());

    uploads = [];
    ctx.mocks.s3.upload.mockImplementation(
      async (_c, localPath: string, key: string, contentType?: string) => {
        uploads.push({
          key,
          contentType,
          content: key.endsWith('.m3u8')
            ? fs.readFileSync(localPath, 'utf8')
            : undefined,
        });
        return {
          key,
          bucket: 'test-bucket',
          url: `https://s3.test/test-bucket/${key}`,
          sizeBytes: 10,
          etag: 'etag',
        };
      },
    );

    (transcodeHlsRendition as jest.Mock).mockImplementation(
      async (_src: string, outDir: string) => {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(
          path.join(outDir, 'index.m3u8'),
          '#EXTM3U\n#EXTINF:4,\nseg_0000.ts\n#EXTINF:4,\nseg_0001.ts\n#EXT-X-ENDLIST\n',
        );
        fs.writeFileSync(path.join(outDir, 'seg_0000.ts'), 'ts-0');
        fs.writeFileSync(path.join(outDir, 'seg_0001.ts'), 'ts-1');
        return true;
      },
    );
    (transcodeWebmVp8 as jest.Mock).mockImplementation(
      async (_src: string, outPath: string) => {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, 'webm-bytes');
        return true;
      },
    );

    // Real DrmService (secrets stubbed); with features.drm absent it always
    // decides `clear` — the DRM tests spy on decide() explicitly.
    drmSvc = new DrmService({
      get: jest.fn(async () => undefined),
    } as never);
    svc = ctx.newService(
      VodTranscodeService,
      ctx.config,
      vods,
      variants,
      ctx.mocks.apps,
      ctx.mocks.s3,
      ctx.mocks.logs,
      ctx.mocks.callbacks,
      drmSvc,
    );
  });

  afterEach(async () => {
    await svc.onModuleDestroy();
    ctx.cleanup();
  });

  /** Insert a ready VOD row + its on-disk source MP4; returns { vodId, sourcePath }. */
  function seedVod(name = 'rec-1'): { vodId: number; sourcePath: string } {
    const dir = path.join(appsRoot, APP, 'recordings');
    fs.mkdirSync(dir, { recursive: true });
    const sourcePath = path.join(dir, `${name}.mp4`);
    fs.writeFileSync(sourcePath, 'mp4-data');
    const vodId = vods.insert(APP, {
      appId: 1,
      streamId: 'stream-1',
      room: 'room-1',
      name: `${name}.mp4`,
      status: 'ready',
      localPath: sourcePath,
      startedAt: new Date().toISOString(),
      metatagsJson: JSON.stringify({ egressId: 'EG_test' }),
    });
    return { vodId, sourcePath };
  }

  const dispatched = (event: string) =>
    ctx.mocks.callbacks.dispatch.mock.calls.filter((c) => c[1] === event);
  const meta = (id: number) =>
    JSON.parse(vods.findById(APP, id)!.metatagsJson!) as Record<string, unknown>;

  // ---- planFor() / needed() ---------------------------------------------
  describe('planFor()/needed()', () => {
    it('default config (transcoding disabled): nothing to do', () => {
      const cfg = makeAppConfig();
      expect(svc.planFor(cfg)).toEqual({ renditions: [], webm: false });
      expect(svc.needed(cfg)).toBe(false);
    });

    it('master switch off gates EVERYTHING (even vp8 + adaptive configured)', () => {
      const cfg = makeAppConfig({
        transcoding: {
          enabled: false,
          encoding: 'h264+vp8',
          vodAdaptive: true,
          vodRenditions: [{ height: 720, bitrateKbps: 2800 }],
        },
      });
      expect(svc.needed(cfg)).toBe(false);
    });

    it('encoding h264+vp8 → webm only (no ladder without vodAdaptive)', () => {
      const cfg = makeAppConfig({
        transcoding: { enabled: true, encoding: 'h264+vp8' },
      });
      expect(svc.planFor(cfg)).toEqual({ renditions: [], webm: true });
      expect(svc.needed(cfg)).toBe(true);
    });

    it('vodAdaptive uses the explicit vod_renditions ladder', () => {
      const cfg = makeAppConfig({
        transcoding: {
          enabled: true,
          vodAdaptive: true,
          vodRenditions: [
            { height: 1080, bitrateKbps: 5000 },
            { height: 480, bitrateKbps: 1400 },
          ],
        },
      });
      expect(svc.planFor(cfg).renditions).toEqual([
        { height: 1080, bitrateKbps: 5000 },
        { height: 480, bitrateKbps: 1400 },
      ]);
    });

    it('vodAdaptive with no explicit ladder derives it from webrtc.layers', () => {
      const cfg = makeAppConfig({
        transcoding: { enabled: true, vodAdaptive: true },
        webrtc: {
          adaptive: true,
          layers: [
            { name: 'high', height: 720 },
            { name: 'med', height: 480 },
            { name: 'low', height: 240 },
          ],
        },
      });
      expect(svc.planFor(cfg).renditions).toEqual([
        { height: 720, bitrateKbps: 2800 },
        { height: 480, bitrateKbps: 1400 },
        { height: 240, bitrateKbps: 500 },
      ]);
    });
  });

  // ---- adaptive HLS pipeline ---------------------------------------------
  describe('adaptive HLS pipeline', () => {
    const adaptiveCfg = () =>
      makeAppConfig({
        transcoding: {
          enabled: true,
          vodAdaptive: true,
          vodRenditions: [
            { height: 720, bitrateKbps: 2800 },
            { height: 480, bitrateKbps: 1400 },
          ],
        },
      });

    it('generates N rendition variants + a master playlist referencing them', async () => {
      cfgMock().mockResolvedValue(adaptiveCfg());
      const { vodId, sourcePath } = seedVod();

      await svc.enqueue({
        appName: APP,
        vodId,
        sourcePath,
        deleteSourceAfter: false,
      });

      const rows = variants.listByVod(APP, vodId);
      expect(rows.map((r) => [r.kind, r.format, r.height])).toEqual([
        ['master', 'hls', null],
        ['rendition', 'hls-h264', 720],
        ['rendition', 'hls-h264', 480],
      ]);

      // rendition playlists + segments + master all uploaded
      const keys = uploads.map((u) => u.key);
      expect(keys).toEqual(
        expect.arrayContaining([
          'hls/rec-1/720p/index.m3u8',
          'hls/rec-1/720p/seg_0000.ts',
          'hls/rec-1/720p/seg_0001.ts',
          'hls/rec-1/480p/index.m3u8',
          'hls/rec-1/480p/seg_0000.ts',
          'hls/rec-1/master.m3u8',
        ]),
      );

      // master playlist content: one EXT-X-STREAM-INF per rendition with
      // BANDWIDTH + RESOLUTION, referencing the rendition playlists.
      const master = uploads.find((u) => u.key === 'hls/rec-1/master.m3u8')!;
      expect(master.contentType).toBe('application/vnd.apple.mpegurl');
      expect(master.content).toContain('#EXTM3U');
      expect(master.content).toContain(
        'BANDWIDTH=2928000,RESOLUTION=1280x720',
      );
      expect(master.content).toContain('BANDWIDTH=1528000,RESOLUTION=854x480');
      expect(master.content).toContain('720p/index.m3u8');
      expect(master.content).toContain('480p/index.m3u8');

      // rendition rows carry the playlist key + segment keys for the cascade
      const r720 = rows.find((r) => r.height === 720)!;
      expect(r720.fileKey).toBe('hls/rec-1/720p/index.m3u8');
      expect(JSON.parse(r720.extraJson!)).toEqual({
        segmentKeys: [
          'hls/rec-1/720p/seg_0000.ts',
          'hls/rec-1/720p/seg_0001.ts',
        ],
      });

      // metatags + callback
      expect(meta(vodId).hlsMasterKey).toBe('hls/rec-1/master.m3u8');
      expect(dispatched('vod_variants_ready')).toHaveLength(1);
      const payload = dispatched('vod_variants_ready')[0][2] as Record<
        string,
        unknown
      >;
      expect(payload.masterKey).toBe('hls/rec-1/master.m3u8');

      // the temp transcode workdir is cleaned up
      expect(
        fs.existsSync(path.join(appsRoot, APP, 'transcode', 'rec-1')),
      ).toBe(false);
    });

    it('skips a failed rendition but still publishes the rest + master', async () => {
      cfgMock().mockResolvedValue(adaptiveCfg());
      (transcodeHlsRendition as jest.Mock).mockImplementation(
        async (_src: string, outDir: string, r: { height: number }) => {
          if (r.height === 480) return false; // this ladder step fails
          fs.mkdirSync(outDir, { recursive: true });
          fs.writeFileSync(path.join(outDir, 'index.m3u8'), '#EXTM3U\n');
          fs.writeFileSync(path.join(outDir, 'seg_0000.ts'), 'ts-0');
          return true;
        },
      );
      const { vodId, sourcePath } = seedVod();

      await svc.enqueue({
        appName: APP,
        vodId,
        sourcePath,
        deleteSourceAfter: false,
      });

      const rows = variants.listByVod(APP, vodId);
      expect(rows.map((r) => [r.kind, r.height])).toEqual([
        ['master', null],
        ['rendition', 720],
      ]);
      const master = uploads.find((u) => u.key === 'hls/rec-1/master.m3u8')!;
      expect(master.content).toContain('720p/index.m3u8');
      expect(master.content).not.toContain('480p/index.m3u8');
    });
  });

  // ---- h264+vp8 (WebM alternate) ------------------------------------------
  describe('encoding h264+vp8 → WebM/VP8 alternate', () => {
    it('generates + uploads the webm variant (no HLS without vodAdaptive)', async () => {
      cfgMock().mockResolvedValue(
        makeAppConfig({
          transcoding: { enabled: true, encoding: 'h264+vp8' },
        }),
      );
      const { vodId, sourcePath } = seedVod('rec-vp8');

      await svc.enqueue({
        appName: APP,
        vodId,
        sourcePath,
        deleteSourceAfter: false,
      });

      expect(transcodeWebmVp8).toHaveBeenCalledWith(
        sourcePath,
        expect.stringContaining('rec-vp8.webm'),
        expect.any(Number),
      );
      const rows = variants.listByVod(APP, vodId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: 'alternate',
        format: 'webm-vp8',
        fileKey: 'rec-vp8.webm',
      });
      const up = uploads.find((u) => u.key === 'rec-vp8.webm')!;
      expect(up.contentType).toBe('video/webm');
      expect(uploads.some((u) => u.key.endsWith('.m3u8'))).toBe(false);
      expect(dispatched('vod_variants_ready')).toHaveLength(1);
    });

    it('h264+vp8 AND vodAdaptive produce ladder + master + webm together', async () => {
      cfgMock().mockResolvedValue(
        makeAppConfig({
          transcoding: {
            enabled: true,
            encoding: 'h264+vp8',
            vodAdaptive: true,
            vodRenditions: [{ height: 720, bitrateKbps: 2800 }],
          },
        }),
      );
      const { vodId, sourcePath } = seedVod();

      await svc.enqueue({
        appName: APP,
        vodId,
        sourcePath,
        deleteSourceAfter: false,
      });

      const rows = variants.listByVod(APP, vodId);
      expect(rows.map((r) => r.kind)).toEqual([
        'master',
        'rendition',
        'alternate',
      ]);
    });
  });

  // ---- source lifecycle ----------------------------------------------------
  describe('source lifecycle (deferred delete_local_after_upload)', () => {
    it('deleteSourceAfter=true removes the source and nulls vods.local_path', async () => {
      cfgMock().mockResolvedValue(
        makeAppConfig({ transcoding: { enabled: true, encoding: 'h264+vp8' } }),
      );
      const { vodId, sourcePath } = seedVod();

      await svc.enqueue({
        appName: APP,
        vodId,
        sourcePath,
        deleteSourceAfter: true,
      });

      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(vods.findById(APP, vodId)!.localPath).toBeNull();
    });

    it('deleteSourceAfter=false keeps the source + local_path', async () => {
      cfgMock().mockResolvedValue(
        makeAppConfig({ transcoding: { enabled: true, encoding: 'h264+vp8' } }),
      );
      const { vodId, sourcePath } = seedVod();

      await svc.enqueue({
        appName: APP,
        vodId,
        sourcePath,
        deleteSourceAfter: false,
      });

      expect(fs.existsSync(sourcePath)).toBe(true);
      expect(vods.findById(APP, vodId)!.localPath).toBe(sourcePath);
    });
  });

  // ---- degradation -----------------------------------------------------------
  describe('degradation', () => {
    it('everything failing → no variant rows, error logged, VOD stays ready', async () => {
      cfgMock().mockResolvedValue(
        makeAppConfig({
          transcoding: {
            enabled: true,
            encoding: 'h264+vp8',
            vodAdaptive: true,
            vodRenditions: [{ height: 720, bitrateKbps: 2800 }],
          },
        }),
      );
      (transcodeHlsRendition as jest.Mock).mockResolvedValue(false);
      (transcodeWebmVp8 as jest.Mock).mockResolvedValue(false);
      const { vodId, sourcePath } = seedVod();

      await svc.enqueue({
        appName: APP,
        vodId,
        sourcePath,
        deleteSourceAfter: false,
      });

      expect(variants.listByVod(APP, vodId)).toHaveLength(0);
      expect(dispatched('vod_variants_ready')).toHaveLength(0);
      expect(vods.findById(APP, vodId)!.status).toBe('ready');
      expect(
        ctx.mocks.logs.write.mock.calls.some(
          (c) => c[2] === 'vod transcode produced no variants',
        ),
      ).toBe(true);
    });

    it('missing source file → logged, nothing generated', async () => {
      cfgMock().mockResolvedValue(
        makeAppConfig({ transcoding: { enabled: true, encoding: 'h264+vp8' } }),
      );
      const { vodId } = seedVod();

      await svc.enqueue({
        appName: APP,
        vodId,
        sourcePath: path.join(appsRoot, APP, 'recordings', 'ghost.mp4'),
        deleteSourceAfter: false,
      });

      expect(variants.listByVod(APP, vodId)).toHaveLength(0);
      expect(
        ctx.mocks.logs.write.mock.calls.some(
          (c) => c[2] === 'transcode source missing',
        ),
      ).toBe(true);
    });
  });

  // ---- DRM wiring (features.drm) -------------------------------------------
  describe('DRM wiring (features.drm)', () => {
    const KEY_ID = '0123456789abcdef0123456789abcdef';
    const KEY_SECRET = 'deadbeefdeadbeefdeadbeefdeadbeef';

    const drmCfg = () =>
      makeAppConfig({
        transcoding: {
          enabled: true,
          encoding: 'h264+vp8', // webm alternate must be suppressed under DRM
          vodAdaptive: true,
          vodRenditions: [{ height: 720, bitrateKbps: 2800 }],
        },
        features: {
          drm: {
            enabled: true,
            provider: 'external',
            systems: ['widevine', 'playready', 'fairplay'],
            scheme: 'cbcs',
            keyServerUrl: 'https://keys.example/speke',
            keyServerTokenEnv: '',
            licenseUrls: {
              widevine: 'https://lic.example/wv',
              playready: '',
              fairplay: '',
            },
            fairplayCertUrl: '',
            failOpen: false,
          },
        },
      });

    const encryptDecision = () => ({
      mode: 'encrypt' as const,
      ctx: {
        scheme: 'cbcs',
        systems: ['widevine', 'playready', 'fairplay'],
        keys: { assetId: 'rec-1', keys: [{ keyId: KEY_ID, key: KEY_SECRET }] },
        keyArgs: ['--enable_raw_key_encryption'],
        licenseUrls: { widevine: 'https://lic.example/wv' },
        hlsKeyUri: 'skd://rec-1',
      } as DrmPackagingContext,
    });

    it('fail-closed skip: NO variants ship (HLS + webm suppressed), drmError recorded', async () => {
      cfgMock().mockResolvedValue(drmCfg());
      jest
        .spyOn(drmSvc, 'decide')
        .mockResolvedValue({ mode: 'skip', reason: 'no packager' });
      const { vodId, sourcePath } = seedVod();

      await svc.enqueue({
        appName: APP,
        vodId,
        sourcePath,
        deleteSourceAfter: false,
      });

      expect(uploads).toHaveLength(0);
      expect(variants.listByVod(APP, vodId)).toHaveLength(0);
      expect(transcodeHlsRendition).not.toHaveBeenCalled();
      expect(transcodeWebmVp8).not.toHaveBeenCalled();
      expect(meta(vodId).drmError).toBe('no packager');
      expect(vods.findById(APP, vodId)!.status).toBe('ready'); // base VOD untouched
      expect(
        ctx.mocks.logs.write.mock.calls.some(
          (c) => c[2] === 'drm packaging skipped (fail-closed)',
        ),
      ).toBe(true);
      expect(dispatched('vod_variants_ready')).toHaveLength(0);
    });

    it('fail-open (clear-degraded): clear pipeline runs UNCHANGED, warn logged', async () => {
      cfgMock().mockResolvedValue(drmCfg());
      jest
        .spyOn(drmSvc, 'decide')
        .mockResolvedValue({ mode: 'clear-degraded', reason: 'no keys' });
      const { vodId, sourcePath } = seedVod();

      await svc.enqueue({
        appName: APP,
        vodId,
        sourcePath,
        deleteSourceAfter: false,
      });

      // exact clear behaviour: ladder + master + webm alternate
      const keys = uploads.map((u) => u.key);
      expect(keys).toEqual(
        expect.arrayContaining([
          'hls/rec-1/720p/index.m3u8',
          'hls/rec-1/master.m3u8',
          'rec-1.webm',
        ]),
      );
      expect(packageDrmHls).not.toHaveBeenCalled();
      expect(
        ctx.mocks.logs.write.mock.calls.some(
          (c) => c[2] === 'drm degraded to clear packaging (fail_open)',
        ),
      ).toBe(true);
    });

    it('encrypt: clear ladder replaced by the shaka CMAF output; keys never persisted', async () => {
      cfgMock().mockResolvedValue(drmCfg());
      jest.spyOn(drmSvc, 'decide').mockResolvedValue(encryptDecision());
      (transcodeRenditionMp4 as jest.Mock).mockImplementation(
        async (_src: string, outPath: string) => {
          fs.mkdirSync(path.dirname(outPath), { recursive: true });
          fs.writeFileSync(outPath, 'mezz-mp4');
          return true;
        },
      );
      (packageDrmHls as jest.Mock).mockImplementation(
        async (job: { outDir: string }) => {
          fs.mkdirSync(job.outDir, { recursive: true });
          for (const f of [
            'master.m3u8',
            '720p.m3u8',
            '720p.mp4',
            'audio.m3u8',
            'audio.mp4',
          ]) {
            fs.writeFileSync(path.join(job.outDir, f), `drm-${f}`);
          }
          return true;
        },
      );
      const { vodId, sourcePath } = seedVod();

      await svc.enqueue({
        appName: APP,
        vodId,
        sourcePath,
        deleteSourceAfter: false,
      });

      // packager fed the mezzanine + the provider's key args
      expect(packageDrmHls).toHaveBeenCalledWith(
        expect.objectContaining({
          audioSourcePath: sourcePath,
          keyArgs: ['--enable_raw_key_encryption'],
        }),
      );

      // encrypted tree uploaded under the SAME hls/<base>/ prefix; no clear .ts
      const keys = uploads.map((u) => u.key);
      expect(keys).toEqual(
        expect.arrayContaining([
          'hls/rec-1/master.m3u8',
          'hls/rec-1/720p.m3u8',
          'hls/rec-1/720p.mp4',
          'hls/rec-1/audio.m3u8',
          'hls/rec-1/audio.mp4',
        ]),
      );
      expect(keys.some((k) => k.endsWith('.ts'))).toBe(false);
      expect(keys.some((k) => k.endsWith('.webm'))).toBe(false);
      expect(transcodeWebmVp8).not.toHaveBeenCalled();
      expect(
        uploads.find((u) => u.key === 'hls/rec-1/720p.mp4')!.contentType,
      ).toBe('video/mp4');

      // variant rows: master hls-drm + rendition hls-cmaf-cbcs
      const rows = variants.listByVod(APP, vodId);
      expect(rows.map((r) => [r.kind, r.format, r.height])).toEqual([
        ['master', 'hls-drm', null],
        ['rendition', 'hls-cmaf-cbcs', 720],
      ]);
      const master = rows.find((r) => r.kind === 'master')!;
      const extra = JSON.parse(master.extraJson!) as Record<string, unknown>;
      expect(extra.scheme).toBe('cbcs');
      expect(extra.keyIds).toEqual([KEY_ID]);
      expect(extra.licenseUrls).toEqual({ widevine: 'https://lic.example/wv' });
      // the content key VALUE never lands in any row
      for (const r of rows) {
        expect(r.extraJson ?? '').not.toContain(KEY_SECRET);
      }

      // metatags + callback carry the PUBLIC drm summary
      const m = meta(vodId);
      expect(m.hlsMasterKey).toBe('hls/rec-1/master.m3u8');
      expect((m.drm as Record<string, unknown>).scheme).toBe('cbcs');
      expect(JSON.stringify(m)).not.toContain(KEY_SECRET);
      const payload = dispatched('vod_variants_ready')[0][2] as Record<
        string,
        unknown
      >;
      expect((payload.drm as Record<string, unknown>).keyIds).toEqual([
        KEY_ID,
      ]);
      expect(JSON.stringify(payload)).not.toContain(KEY_SECRET);
    });

    it('encrypt: packager failure → no HLS variants, drmError, NO clear fallback', async () => {
      cfgMock().mockResolvedValue(drmCfg());
      jest.spyOn(drmSvc, 'decide').mockResolvedValue(encryptDecision());
      (transcodeRenditionMp4 as jest.Mock).mockImplementation(
        async (_src: string, outPath: string) => {
          fs.mkdirSync(path.dirname(outPath), { recursive: true });
          fs.writeFileSync(outPath, 'mezz-mp4');
          return true;
        },
      );
      (packageDrmHls as jest.Mock).mockResolvedValue(false);
      const { vodId, sourcePath } = seedVod();

      await svc.enqueue({
        appName: APP,
        vodId,
        sourcePath,
        deleteSourceAfter: false,
      });

      expect(uploads).toHaveLength(0);
      expect(variants.listByVod(APP, vodId)).toHaveLength(0);
      expect(transcodeHlsRendition).not.toHaveBeenCalled(); // never falls back to clear
      expect(meta(vodId).drmError).toBe('shaka-packager run failed');
      expect(vods.findById(APP, vodId)!.status).toBe('ready');
    });

    it('features.drm absent (real decide): pipeline stays clear, packager untouched', async () => {
      cfgMock().mockResolvedValue(
        makeAppConfig({
          transcoding: {
            enabled: true,
            vodAdaptive: true,
            vodRenditions: [{ height: 720, bitrateKbps: 2800 }],
          },
        }),
      );
      const { vodId, sourcePath } = seedVod();

      await svc.enqueue({
        appName: APP,
        vodId,
        sourcePath,
        deleteSourceAfter: false,
      });

      expect(packageDrmHls).not.toHaveBeenCalled();
      expect(uploads.map((u) => u.key)).toEqual(
        expect.arrayContaining(['hls/rec-1/master.m3u8']),
      );
      expect(variants.listByVod(APP, vodId).length).toBeGreaterThan(0);
    });
  });
});
