/**
 * Unit spec — RecordingService recordMode=track|audio (module recording).
 *
 * LIVEKIT-UNUSED-FEATURES "track/audio-only egress": the record-start API
 * accepts `recordMode: composite|track|audio`; track/audio record ONE
 * publisher via TrackCompositeEgress (ffmpeg, no headless Chrome). Pins:
 *   1. track mode → livekitTrack.startTrackCompositeEgress (audioOnly false),
 *      NEVER the composite startEgress; a `recording` VOD row is persisted
 *      with metatags.mode = 'track';
 *   2. audio mode → audioOnly true, and live ImageOutput snapshots are forced
 *      OFF even when the app config enables them;
 *   3. the participant identity defaults to the streamId and an explicit
 *      participantIdentity wins;
 *   4. recordMode omitted/composite keeps the app-config egress (back-compat);
 *   5. track/audio without the concrete LiveKitService wired → 500 with a
 *      clear message (no half-started state);
 *   6. startForStream forwards the recordMode options.
 *
 * Same harness as recording.service.spec: real per-app DB + VodsRepository,
 * everything external mocked.
 */
import { InternalServerErrorException } from '@nestjs/common';
import * as path from 'path';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import type { AppConfig } from '../../shared/contracts';
import { RecordingService } from './recording.service';
import { VodsRepository } from './vods.repository';
import { VodVariantsRepository } from './vod-variants.repository';

jest.mock('./media.util', () => ({
  probeMedia: jest.fn(async () => ({})),
  extractSnapshot: jest.fn(async () => false),
}));

const APP = 'live';

function makeAppConfig(
  over: { recording?: Partial<AppConfig['recording']> } = {},
): AppConfig {
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
      bucket: 'b',
      region: 'us-east-1',
      forcePathStyle: false,
      prefix: 'p',
      accessKey: 'AK',
      secretKey: 'SK',
    },
    webrtc: { adaptive: false, layers: [] },
    rtmp: { enabled: true, transcode: false },
    callbacks: { url: '', secret: '' },
    features: {
      rtmpPassword: false,
      viewerCounter: false,
      chat: false,
      reactions: false,
      hiddenQc: false,
      adaptivePlayer: false,
      publicPlayback: true,
    },
  };
}

describe('RecordingService — recordMode track|audio', () => {
  let ctx: UnitContext;
  let repo: VodsRepository;
  let livekitTrack: { startTrackCompositeEgress: jest.Mock };

  const makeService = (withTrackService = true) =>
    ctx.newService(
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
      undefined, // metrics
      undefined, // vodTranscode
      (withTrackService ? livekitTrack : undefined) as never,
    );

  beforeEach(() => {
    ctx = makeUnitContext();
    repo = new VodsRepository(ctx.db);
    livekitTrack = {
      startTrackCompositeEgress: jest.fn(async () => ({
        egressId: 'EG_track',
        status: 'EGRESS_STARTING',
      })),
    };
    ctx.mocks.apps.appDir.mockImplementation((name: string) =>
      path.join(ctx.dataDir, 'apps-work', name),
    );
    ctx.mocks.apps.getConfig.mockResolvedValue(makeAppConfig());
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('track mode starts a TrackComposite egress of the streamId publisher', async () => {
    const svc = makeService();
    const handle = await svc.start({
      appName: APP,
      roomName: 'live-r1',
      streamId: 'live-r1/pub-1',
      recordMode: 'track',
    });

    expect(handle.egressId).toBe('EG_track');
    expect(handle.status).toBe('recording');
    // The composite path was NOT taken.
    expect(ctx.mocks.livekit.startEgress).not.toHaveBeenCalled();
    expect(livekitTrack.startTrackCompositeEgress).toHaveBeenCalledTimes(1);
    const input = livekitTrack.startTrackCompositeEgress.mock.calls[0][0];
    expect(input).toMatchObject({
      appName: APP,
      roomName: 'live-r1',
      participantIdentity: 'live-r1/pub-1',
      audioOnly: false,
    });
    expect(input.outputFilepath).toMatch(/recordings\/.+\.mp4$/);

    // VOD row persisted as recording, with the mode in the metatags.
    const vod = repo.findById(APP, handle.vodId);
    expect(vod?.status).toBe('recording');
    expect(JSON.parse(vod?.metatagsJson ?? '{}')).toMatchObject({
      mode: 'track',
      egressId: 'EG_track',
    });
  });

  it('audio mode sets audioOnly and forces live snapshots OFF', async () => {
    ctx.mocks.apps.getConfig.mockResolvedValue(
      makeAppConfig({ recording: { snapshotSeconds: 60 } }),
    );
    const svc = makeService();
    const handle = await svc.start({
      appName: APP,
      roomName: 'live-r1',
      streamId: 'radio-host',
      recordMode: 'audio',
    });

    const input = livekitTrack.startTrackCompositeEgress.mock.calls[0][0];
    expect(input.audioOnly).toBe(true);
    const meta = JSON.parse(
      repo.findById(APP, handle.vodId)?.metatagsJson ?? '{}',
    );
    expect(meta.mode).toBe('audio');
    // ImageOutput snapshots ride Chrome egresses only — forced off here.
    expect(meta.snapshotSeconds).toBe(0);
    expect(meta.snapshotPrefix).toBeUndefined();
  });

  it('an explicit participantIdentity wins over the streamId default', async () => {
    const svc = makeService();
    await svc.start({
      appName: APP,
      roomName: 'live-r1',
      streamId: 'stream-9',
      recordMode: 'track',
      participantIdentity: 'the-real-pub',
    });
    expect(
      livekitTrack.startTrackCompositeEgress.mock.calls[0][0]
        .participantIdentity,
    ).toBe('the-real-pub');
  });

  it('recordMode omitted / composite keeps the app-config egress (back-compat)', async () => {
    const svc = makeService();
    await svc.start({ appName: APP, roomName: 'live-r1' });
    await svc.start({
      appName: APP,
      roomName: 'live-r1',
      recordMode: 'composite',
    });

    expect(ctx.mocks.livekit.startEgress).toHaveBeenCalledTimes(2);
    expect(livekitTrack.startTrackCompositeEgress).not.toHaveBeenCalled();
    expect(ctx.mocks.livekit.startEgress.mock.calls[0][0]).toMatchObject({
      mode: 'room-composite',
    });
  });

  it('track/audio without the concrete LiveKitService wired → clear 500', async () => {
    const svc = makeService(false);
    await expect(
      svc.start({ appName: APP, roomName: 'live-r1', recordMode: 'track' }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(ctx.mocks.livekit.startEgress).not.toHaveBeenCalled();
  });

  it('startForStream forwards recordMode + participantIdentity', async () => {
    const svc = makeService();
    await svc.startForStream(APP, 'live-r1/pub-1', 'live-r1', {
      recordMode: 'audio',
      participantIdentity: 'pub-1',
    });
    expect(livekitTrack.startTrackCompositeEgress).toHaveBeenCalledWith(
      expect.objectContaining({
        roomName: 'live-r1',
        participantIdentity: 'pub-1',
        audioOnly: true,
      }),
    );
  });
});
