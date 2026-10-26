/**
 * Unit spec — PipelineService (feature pipeline, GET /apps/:app/pipeline).
 *
 * Locks down the resolved media-pipeline topology contract the dashboard's
 * animated flow diagram is built on:
 *  - INVARIANT: the shape is STABLE and COMPLETE — every section present, the
 *    6 ingest nodes and 3 delivery nodes always emitted in a fixed order.
 *  - passthrough app (transcoding off, recording off, no S3): minimal pipeline
 *    with everything inactive and split/snapshot/bucket keys omitted.
 *  - fully-configured app: rtmp+rtmps, transcoding+GPU, adaptive ladder,
 *    recording split/snapshots, S3 creds (configured, bucket only — never a
 *    credential), CDN public base, installed plugins with their soft switch.
 *  - live hints: `active` flags come from the app db `streams` table
 *    (status='active' per StreamType) with NO LiveKit dials; HLS delivery is
 *    active only when a live room has an on-disk playlist (stale dirs ignored).
 *
 * Same harness as apps.service.spec.ts (real temp DB + real AppsService /
 * AppPluginsRepository; HwAccelService stubbed — GPU detection is locked down
 * in hwaccel.service.spec.ts).
 */
import * as fs from 'fs';
import * as path from 'path';
import { NotFoundException } from '@nestjs/common';

import { AppsService } from '../apps/apps.service';
import { AppPluginsRepository } from '../plugins/app-plugins.repository';
import { S3Service } from '../s3/s3.service';
import { SecretsStore } from '../s3/secrets.store';
import type { HwAccelService } from '../system/hwaccel.service';
import type { HwaccelDecision, HwaccelMode } from '../system/gpu.types';
import type { PluginRegistryService } from '../plugins/plugin-registry.service';
import type {
  VisionAppService,
  VisionPipelineView,
} from '../vision-apps/vision.service';
import type { NotifierService } from '../notifications/notifier.service';
import type { NetMetricsService } from '../net-metrics/net-metrics.service';
import type { PassthroughService } from '../passthrough/passthrough.service';
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { PipelineService } from './pipeline.service';

/** Fakes for the 5 read-only collaborators (each returns an idle default). */
interface Fakes {
  registry: { getMeta: jest.Mock };
  vision: { pipelineVision: jest.Mock };
  notifier: { channelsFor: jest.Mock };
  netMetrics: { history: jest.Mock };
  passthrough: { enabled: jest.Mock; list: jest.Mock };
}

interface Harness extends Fakes {
  ctx: UnitContext;
  apps: AppsService;
  repo: AppPluginsRepository;
  hw: { getMode: jest.Mock; resolve: jest.Mock };
  pipeline: PipelineService;
}

/** An empty-but-well-formed vision pipeline aggregate (no nodes, no models). */
function idlePipelineVision(): VisionPipelineView {
  return {
    enabledModels: [],
    assignments: { running: 0, pending: 0 },
    edge: { total: 0, online: 0 },
  };
}

function cpuDecision(requested: HwaccelMode = 'auto'): HwaccelDecision {
  return { requested, effective: 'cpu', type: 'none', reason: 'no gpu' };
}

function gpuDecision(requested: HwaccelMode = 'gpu'): HwaccelDecision {
  return { requested, effective: 'gpu', type: 'nvidia', reason: 'gpu found' };
}

/** Build a full harness. `env` pins ConfigService keys (RTMPS defaults off). */
function build(env: Record<string, string> = {}): Harness {
  const ctx = makeUnitContext({
    STREAMHUB_RTMPS_ENABLE: 'false',
    STREAMHUB_HLS_CDN: 'false',
    RTMP_PUBLIC_HOST: '',
    RTMPS_PUBLIC_HOST: '',
    ...env,
  });
  const s3 = new S3Service();
  const secrets = new SecretsStore(ctx.config);
  const samplesFake = { generate: jest.fn(async () => []) };
  const moduleRef = { get: jest.fn(() => samplesFake) } as unknown as never;
  const apps = ctx.newService(
    AppsService,
    ctx.config,
    ctx.db,
    s3,
    secrets,
    moduleRef,
  );
  const repo = new AppPluginsRepository(ctx.db);
  const hw = {
    getMode: jest.fn(() => 'auto' as HwaccelMode),
    resolve: jest.fn(async (): Promise<HwaccelDecision> => cpuDecision()),
  };
  // Read-only collaborators — inert idle defaults; individual tests tweak them.
  const registry: Fakes['registry'] = {
    getMeta: jest.fn((id: string) => ({ id, kind: 'plugin', category: 'processor' })),
  };
  const vision: Fakes['vision'] = {
    pipelineVision: jest.fn(() => idlePipelineVision()),
  };
  const notifier: Fakes['notifier'] = {
    channelsFor: jest.fn(() => ({ email: false, discord: false, telegram: false })),
  };
  const netMetrics: Fakes['netMetrics'] = { history: jest.fn(() => []) };
  const passthrough: Fakes['passthrough'] = {
    enabled: jest.fn(() => false),
    list: jest.fn(() => []),
  };
  const pipeline = new PipelineService(
    ctx.config,
    ctx.db,
    apps,
    hw as unknown as HwAccelService,
    repo,
    registry as unknown as PluginRegistryService,
    vision as unknown as VisionAppService,
    notifier as unknown as NotifierService,
    netMetrics as unknown as NetMetricsService,
    passthrough as unknown as PassthroughService,
  );
  return { ctx, apps, repo, hw, registry, vision, notifier, netMetrics, passthrough, pipeline };
}

/** Insert a stream row straight into the app db (the live-hint source). */
async function insertStream(
  h: Harness,
  app: string,
  type: string,
  room: string,
  status: 'active' | 'ended' = 'active',
): Promise<void> {
  const record = await h.apps.get(app);
  h.ctx.db
    .appDb(app)
    .prepare(
      `INSERT INTO streams (app_id, stream_id, type, room, participant, status)
       VALUES (?, ?, ?, ?, 'pub', ?)`,
    )
    .run(
      record!.id,
      `${room}/${type}-${Math.random().toString(36).slice(2)}`,
      type,
      room,
      status,
    );
}

describe('PipelineService — resolved media-pipeline topology', () => {
  let h: Harness;

  afterEach(() => {
    h.ctx.cleanup();
  });

  describe('passthrough app (minimal pipeline)', () => {
    beforeEach(async () => {
      h = build();
      await h.apps.create({ name: 'pass' });
      await h.apps.updateConfig('pass', {
        transcoding: {
          enabled: false,
          encoding: 'h264',
          vodAdaptive: false,
          vodRenditions: [],
        },
        recording: { enabled: false } as never,
      });
    });

    it('emits the complete stable shape with everything idle', async () => {
      const p = await h.pipeline.get('pass');

      // INVARIANT: fixed node sets + order (the diagram indexes into these).
      expect(p.ingest.map((i) => i.type)).toEqual([
        'rtmp',
        'rtmps',
        'whip',
        'webrtc',
        'rtsp',
        'ws-mjpeg',
        'srt',
        'mpegts',
      ]);
      expect(p.delivery.map((d) => d.type)).toEqual([
        'webrtc',
        'hls',
        'cdn',
        'restream',
      ]);

      // Nothing live, nothing configured beyond the scaffold defaults.
      expect(p.ingest.every((i) => i.active === false)).toBe(true);
      expect(p.ingest.find((i) => i.type === 'rtmp')!.enabled).toBe(true);
      expect(p.ingest.find((i) => i.type === 'rtmps')!.enabled).toBe(false);
      expect(p.ingest.find((i) => i.type === 'ws-mjpeg')!.enabled).toBe(true);
      expect(p.ingest.every((i) => typeof i.label === 'string' && i.label)).toBe(
        true,
      );

      expect(p.processing.transcoding).toEqual({
        enabled: false,
        encoder: 'cpu',
        hwaccel: 'auto',
      });
      // Scaffold default ladder rides along even when transcoding is off.
      expect(p.processing.adaptive.enabled).toBe(true);
      expect(p.processing.adaptive.layers).toEqual([
        { name: 'high', height: 720 },
        { name: 'med', height: 480 },
        { name: 'low', height: 240 },
      ]);

      const webrtcOut = p.delivery.find((d) => d.type === 'webrtc')!;
      const hls = p.delivery.find((d) => d.type === 'hls')!;
      const cdn = p.delivery.find((d) => d.type === 'cdn')!;
      expect(webrtcOut).toMatchObject({ enabled: true, active: false });
      expect(hls).toMatchObject({ enabled: true, active: false });
      expect(cdn).toMatchObject({ enabled: false, active: false });
      expect(cdn.detail).toBeUndefined();

      // recording off + split/snapshot at 0 ⇒ optional keys OMITTED.
      expect(p.storage.recording).toEqual({ enabled: false });
      // no credentials, scaffold bucket is empty ⇒ bucket key omitted too.
      expect(p.storage.s3).toEqual({ configured: false });

      expect(p.plugins).toEqual([]);
      expect(p.live).toEqual({ activeStreams: 0, tags: [] });
      expect('viewers' in p.live).toBe(false);

      // New sections: always present, well-formed idle defaults.
      expect(p.ingestFront).toEqual({ mediamtx: false, port: 1935 });
      expect(p.processing.passthrough).toEqual({ enabled: false, transports: [] });
      expect(p.compute).toEqual({
        edge: { total: 0, online: 0 },
        vision: { enabled: false, models: [], assignments: { running: 0, pending: 0 } },
      });
      expect(p.events).toEqual({
        callbacks: { configured: false },
        mqtt: { enabled: false },
        log: { enabled: true },
      });
      expect(p.notifications).toEqual({ email: false, discord: false, telegram: false });
      expect(p.net).toEqual({ inBytes: 0, outBytes: 0, windowSec: 3600 });
      // Restream node present but disabled (no targets) ⇒ no detail leaked.
      expect(p.delivery.find((d) => d.type === 'restream')).toEqual({
        type: 'restream',
        enabled: false,
        active: false,
        label: 'Restream',
      });
    });

    it('never leaks credentials anywhere in the payload', async () => {
      await h.apps.setS3('pass', {
        bucket: 'vods-pass',
        key: 'AKIA-SUPER-SECRET-KEY',
        secret: 'wJal-SUPER-SECRET-VALUE',
      });
      const flat = JSON.stringify(await h.pipeline.get('pass'));
      expect(flat).not.toContain('SUPER-SECRET');
      expect(flat).toContain('vods-pass'); // bucket NAME is fine
    });
  });

  describe('fully-configured app', () => {
    beforeEach(async () => {
      h = build({ STREAMHUB_RTMPS_ENABLE: 'true', RTMP_PUBLIC_HOST: 'stream.example.com' });
      await h.apps.create({ name: 'full' });
      await h.apps.updateConfig('full', {
        transcoding: {
          enabled: true,
          encoding: 'h264',
          vodAdaptive: true,
          vodRenditions: [{ height: 720, bitrateKbps: 2800 }],
        },
        webrtc: {
          adaptive: true,
          layers: [
            { name: 'high', height: 1080 },
            { name: 'low', height: 360 },
          ],
        },
        recording: {
          enabled: true,
          splitMinutes: 30,
          snapshotSeconds: 60,
        } as never,
      });
      await h.apps.setS3('full', {
        bucket: 'full-vods',
        key: 'AK123456',
        secret: 'SK123456',
        public_url: 'https://cdn.example.com',
        confirmPublic: true,
      });
      h.repo.install('full', 'yolo', {}, true);
      h.repo.install('full', 'deface', {}, false);
      h.hw.getMode.mockReturnValue('gpu');
      h.hw.resolve.mockResolvedValue(gpuDecision());
    });

    it('reports transcoding on the GPU path with the configured ladder', async () => {
      const p = await h.pipeline.get('full');
      expect(p.processing.transcoding).toEqual({
        enabled: true,
        encoder: 'gpu',
        hwaccel: 'gpu',
      });
      expect(p.processing.adaptive).toEqual({
        enabled: true,
        layers: [
          { name: 'high', height: 1080 },
          { name: 'low', height: 360 },
        ],
      });
    });

    it('reports recording split/snapshots + configured S3 (bucket name only)', async () => {
      const p = await h.pipeline.get('full');
      expect(p.storage.recording).toEqual({
        enabled: true,
        splitMinutes: 30,
        snapshotSeconds: 60,
      });
      expect(p.storage.s3).toEqual({ configured: true, bucket: 'full-vods' });
    });

    it('enables the RTMPS ingest node and the CDN delivery node', async () => {
      const p = await h.pipeline.get('full');
      const rtmps = p.ingest.find((i) => i.type === 'rtmps')!;
      expect(rtmps.enabled).toBe(true);
      expect(rtmps.active).toBe(false); // nothing live yet
      expect(rtmps.detail).toContain('rtmps://stream.example.com:1936');

      const cdn = p.delivery.find((d) => d.type === 'cdn')!;
      expect(cdn).toMatchObject({
        enabled: true,
        active: false,
        detail: 'https://cdn.example.com',
      });
    });

    it('lists the installed plugins with their soft switch + registry meta', async () => {
      const p = await h.pipeline.get('full');
      expect(p.plugins).toEqual([
        { id: 'yolo', enabled: true, kind: 'plugin', category: 'processor' },
        { id: 'deface', enabled: false, kind: 'plugin', category: 'processor' },
      ]);
    });

    it('falls back to encoder cpu when hwaccel=gpu but no GPU is detected', async () => {
      h.hw.resolve.mockResolvedValue(cpuDecision('gpu'));
      const p = await h.pipeline.get('full');
      expect(p.processing.transcoding).toEqual({
        enabled: true,
        encoder: 'cpu',
        hwaccel: 'gpu',
      });
    });
  });

  describe('live hints (active streams / HLS)', () => {
    beforeEach(async () => {
      h = build();
      await h.apps.create({ name: 'live1' });
    });

    it('flags each ingest type active from its live streams and counts them', async () => {
      await insertStream(h, 'live1', 'webrtc', 'roomA');
      await insertStream(h, 'live1', 'rtmp', 'roomB');
      await insertStream(h, 'live1', 'rtsp', 'roomC');
      await insertStream(h, 'live1', 'ws-mjpeg', 'roomD');
      await insertStream(h, 'live1', 'rtmp', 'roomE', 'ended'); // ignored

      const p = await h.pipeline.get('live1');
      const active = Object.fromEntries(
        p.ingest.map((i) => [i.type, i.active]),
      );
      expect(active).toEqual({
        rtmp: true,
        rtmps: false, // TLS front is off ⇒ never active
        whip: false,
        webrtc: true,
        rtsp: true,
        'ws-mjpeg': true,
        srt: false, // passthrough plane off ⇒ never active
        mpegts: false, // passthrough plane off ⇒ never active
      });
      expect(p.live).toEqual({ activeStreams: 4, tags: [] });
      expect(p.delivery.find((d) => d.type === 'webrtc')!.active).toBe(true);
    });

    it('mirrors live RTMP traffic onto the RTMPS node when the TLS front is on', async () => {
      h.ctx.cleanup();
      h = build({ STREAMHUB_RTMPS_ENABLE: 'true' });
      await h.apps.create({ name: 'live1' });
      await insertStream(h, 'live1', 'rtmp', 'roomA');

      const p = await h.pipeline.get('live1');
      expect(p.ingest.find((i) => i.type === 'rtmps')).toMatchObject({
        enabled: true,
        active: true,
      });
    });

    it('marks HLS delivery active only when a LIVE room has an on-disk playlist', async () => {
      await insertStream(h, 'live1', 'webrtc', 'live-room');

      // Stale playlist of a room that is NOT live ⇒ inactive.
      const hlsDir = path.join(h.apps.appDir('live1'), 'hls');
      fs.mkdirSync(path.join(hlsDir, 'dead-room'), { recursive: true });
      fs.writeFileSync(path.join(hlsDir, 'dead-room', 'index.m3u8'), '#EXTM3U');
      expect(
        (await h.pipeline.get('live1')).delivery.find((d) => d.type === 'hls')!
          .active,
      ).toBe(false);

      // Playlist of the live room (slug rules of HlsService) ⇒ active.
      fs.mkdirSync(path.join(hlsDir, 'live-room'), { recursive: true });
      fs.writeFileSync(path.join(hlsDir, 'live-room', 'index.m3u8'), '#EXTM3U');
      expect(
        (await h.pipeline.get('live1')).delivery.find((d) => d.type === 'hls')!
          .active,
      ).toBe(true);
    });

    it('STREAMHUB_HLS_CDN on: CDN node enabled + active while live HLS flows', async () => {
      h.ctx.cleanup();
      h = build({ STREAMHUB_HLS_CDN: 'true' });
      await h.apps.create({ name: 'live1' });

      // Knob on, nothing live yet: enabled but idle.
      let p = await h.pipeline.get('live1');
      expect(p.delivery.find((d) => d.type === 'cdn')).toMatchObject({
        enabled: true,
        active: false,
        detail: 'CDN-cacheable live HLS (STREAMHUB_HLS_CDN on)',
      });

      // A live room with an on-disk playlist ⇒ the CDN edge carries the flow.
      await insertStream(h, 'live1', 'rtmp', 'show');
      const dir = path.join(h.apps.appDir('live1'), 'hls', 'show');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.m3u8'), '#EXTM3U');
      p = await h.pipeline.get('live1');
      expect(p.delivery.find((d) => d.type === 'cdn')).toMatchObject({
        enabled: true,
        active: true,
      });
    });

    it('disables the ws-mjpeg node when features.ws_ingest.enabled is false', async () => {
      await h.apps.updateConfig('live1', {
        features: {
          wsIngest: { enabled: false, maxCameras: 0, maxFps: 15, maxFrameKb: 256 },
        } as never,
      });
      const p = await h.pipeline.get('live1');
      expect(p.ingest.find((i) => i.type === 'ws-mjpeg')!.enabled).toBe(false);
    });
  });

  describe('new sections (front / passthrough / compute / events / net / restream)', () => {
    beforeEach(async () => {
      h = build();
      await h.apps.create({ name: 'xapp' });
    });

    it('reflects the MediaMTX single-port front from env', async () => {
      h.ctx.cleanup();
      h = build({ STREAMHUB_MEDIAMTX_ENABLE: 'true', STREAMHUB_MEDIAMTX_RTMP_PORT: '1935' });
      await h.apps.create({ name: 'xapp' });
      const p = await h.pipeline.get('xapp');
      expect(p.ingestFront).toEqual({ mediamtx: true, port: 1935 });
    });

    it('enables the SRT ingest node + passthrough plane when the plane is on', async () => {
      h.passthrough.enabled.mockReturnValue(true);
      h.passthrough.list.mockReturnValue([{ inputType: 'srt' }, { inputType: 'rtmp' }]);
      const p = await h.pipeline.get('xapp');
      const srt = p.ingest.find((i) => i.type === 'srt')!;
      expect(srt.enabled).toBe(true);
      // The MPEG-TS/UDP node shares the same passthrough plane switch as SRT.
      expect(p.ingest.find((i) => i.type === 'mpegts')!.enabled).toBe(true);
      // transports come from the configured ingresses, deduped + sorted.
      expect(p.processing.passthrough).toEqual({
        enabled: true,
        transports: ['rtmp', 'srt'],
      });
    });

    it('surfaces an mpegts transport from a configured MPEG-TS ingress', async () => {
      h.passthrough.enabled.mockReturnValue(true);
      h.passthrough.list.mockReturnValue([{ inputType: 'mpegts' }, { inputType: 'rtmp' }]);
      const p = await h.pipeline.get('xapp');
      expect(p.processing.passthrough).toEqual({
        enabled: true,
        transports: ['mpegts', 'rtmp'],
      });
    });

    it('passthrough on with no ingresses ⇒ the full capability set', async () => {
      h.passthrough.enabled.mockReturnValue(true);
      h.passthrough.list.mockReturnValue([]);
      const p = await h.pipeline.get('xapp');
      expect(p.processing.passthrough).toEqual({
        enabled: true,
        transports: ['mpegts', 'rtmp', 'srt'],
      });
    });

    it('maps the vision aggregate into the compute section (enabled models only)', async () => {
      h.vision.pipelineVision.mockReturnValue({
        enabledModels: ['occupancy', 'counting'],
        assignments: { running: 2, pending: 1 },
        edge: { total: 4, online: 3 },
      } satisfies VisionPipelineView);
      const p = await h.pipeline.get('xapp');
      expect(p.compute).toEqual({
        edge: { total: 4, online: 3 },
        vision: {
          enabled: true,
          models: ['occupancy', 'counting'],
          assignments: { running: 2, pending: 1 },
        },
      });
    });

    it('degrades compute to idle when the vision aggregate throws', async () => {
      h.vision.pipelineVision.mockImplementation(() => {
        throw new Error('vision not installed');
      });
      const p = await h.pipeline.get('xapp');
      expect(p.compute.edge).toEqual({ total: 0, online: 0 });
      expect(p.compute.vision.enabled).toBe(false);
    });

    it('reports callbacks/mqtt event taps from config (log always on)', async () => {
      await h.apps.updateConfig('xapp', {
        callbacks: { url: 'https://example.com/hook', secret: 's3cr3t' },
        mqtt: { enabled: true } as never,
      });
      const p = await h.pipeline.get('xapp');
      expect(p.events).toEqual({
        callbacks: { configured: true },
        mqtt: { enabled: true },
        log: { enabled: true },
      });
      // The secret must never surface anywhere in the payload.
      expect(JSON.stringify(p)).not.toContain('s3cr3t');
    });

    it('passes resolved notification channels through (booleans only)', async () => {
      h.notifier.channelsFor.mockReturnValue({ email: true, discord: false, telegram: true });
      const p = await h.pipeline.get('xapp');
      expect(p.notifications).toEqual({ email: true, discord: false, telegram: true });
      expect(h.notifier.channelsFor).toHaveBeenCalledWith('xapp');
    });

    it('sums the last-hour net history into in/out bytes', async () => {
      h.netMetrics.history.mockReturnValue([
        { bucket: 'a', in: 100, out: 40 },
        { bucket: 'b', in: 5, out: 3 },
      ]);
      const p = await h.pipeline.get('xapp');
      expect(p.net).toEqual({ inBytes: 105, outBytes: 43, windowSec: 3600 });
      expect(h.netMetrics.history).toHaveBeenCalledWith('xapp', 1);
    });

    it('counts restream targets (configured = non-stopped, live = starting/active)', async () => {
      const rec = (await h.apps.get('xapp'))!;
      const insert = (status: string, room: string) =>
        h.ctx.db
          .appDb('xapp')
          .prepare(
            `INSERT INTO restream_targets
               (app, room, stream_id, name, platform, url, url_masked, egress_id, status)
             VALUES ('xapp', ?, NULL, NULL, 'youtube', 'rtmp://x/key', 'rtmp://x/***', ?, ?)`,
          )
          .run(room, `eg-${room}`, status);
      void rec;
      insert('active', 'r1');
      insert('starting', 'r2');
      insert('stopped', 'r3'); // counts as configured=no, live=no

      const p = await h.pipeline.get('xapp');
      const restream = p.delivery.find((d) => d.type === 'restream')!;
      expect(restream.enabled).toBe(true); // 2 non-stopped
      expect(restream.active).toBe(true); // 2 live
      expect(restream.detail).toBe('2 targets');
    });
  });

  describe('errors', () => {
    it('404s on an unknown app', async () => {
      h = build();
      await expect(h.pipeline.get('nope')).rejects.toThrow(NotFoundException);
    });
  });
});
