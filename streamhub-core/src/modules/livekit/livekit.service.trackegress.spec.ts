/**
 * Unit spec — LiveKitService.startTrackCompositeEgress (track/audio egress).
 *
 * LIVEKIT-UNUSED-FEATURES "track (single-track) egress": record ONE publisher
 * with ffmpeg (TrackCompositeEgress) instead of a headless-Chrome room render.
 * Pins:
 *   1. the publisher's audio+video track sids are resolved via getParticipant
 *      and forwarded as TrackCompositeOptions (file output, MP4);
 *   2. audioOnly attaches ONLY the audio sid — and fails fast when the
 *      participant publishes no audio;
 *   3. a participant with no published tracks fails fast;
 *   4. failures surface as 503 ServiceUnavailable (guard), never a crash.
 *
 * RoomServiceClient/EgressClient are jest fakes injected into the service's
 * lazy client slots — nothing dials the network.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { TrackType } from '@livekit/protocol';

import { LiveKitService } from './livekit.service';
import { mockLogsService } from '../../../test/helpers/service-mocks';

function makeService(tracks: Array<{ sid: string; type: TrackType }>) {
  const config = {
    livekitUrl: 'ws://127.0.0.1:7880',
    livekitApiKey: 'key',
    livekitApiSecret: 'secret',
  } as any;
  const svc = new LiveKitService(config, mockLogsService());
  const roomClient = {
    getParticipant: jest.fn(async () => ({
      identity: 'pub-1',
      name: '',
      sid: 'PA_1',
      tracks,
    })),
  };
  const egressClient = {
    startTrackCompositeEgress: jest.fn(async () => ({
      egressId: 'EG_track',
      status: 0, // EGRESS_STARTING
    })),
  };
  (svc as any)._roomClient = roomClient;
  (svc as any)._egressClient = egressClient;
  return { svc, roomClient, egressClient };
}

const BASE = {
  appName: 'live',
  roomName: 'live-room1',
  participantIdentity: 'pub-1',
  outputFilepath: '/data/apps/live/recordings/rec.mp4',
};

describe('LiveKitService.startTrackCompositeEgress', () => {
  it('resolves audio+video sids and starts a file TrackComposite egress', async () => {
    const { svc, roomClient, egressClient } = makeService([
      { sid: 'TR_a1', type: TrackType.AUDIO },
      { sid: 'TR_v1', type: TrackType.VIDEO },
    ]);

    const res = await svc.startTrackCompositeEgress(BASE);

    expect(roomClient.getParticipant).toHaveBeenCalledWith(
      'live-room1',
      'pub-1',
    );
    expect(egressClient.startTrackCompositeEgress).toHaveBeenCalledTimes(1);
    const [room, output, opts] =
      egressClient.startTrackCompositeEgress.mock.calls[0];
    expect(room).toBe('live-room1');
    expect(output.file?.filepath).toBe(BASE.outputFilepath);
    expect(opts).toMatchObject({ audioTrackId: 'TR_a1', videoTrackId: 'TR_v1' });
    expect(res).toEqual({ egressId: 'EG_track', status: 'EGRESS_STARTING' });
  });

  it('audioOnly attaches ONLY the audio sid', async () => {
    const { svc, egressClient } = makeService([
      { sid: 'TR_a1', type: TrackType.AUDIO },
      { sid: 'TR_v1', type: TrackType.VIDEO },
    ]);

    await svc.startTrackCompositeEgress({ ...BASE, audioOnly: true });

    const opts = egressClient.startTrackCompositeEgress.mock.calls[0][2];
    expect(opts.audioTrackId).toBe('TR_a1');
    expect(opts.videoTrackId).toBeUndefined();
  });

  it('video-only publisher works in track mode (no audio attached)', async () => {
    const { svc, egressClient } = makeService([
      { sid: 'TR_v1', type: TrackType.VIDEO },
    ]);

    await svc.startTrackCompositeEgress(BASE);

    const opts = egressClient.startTrackCompositeEgress.mock.calls[0][2];
    expect(opts.videoTrackId).toBe('TR_v1');
    expect(opts.audioTrackId).toBeUndefined();
  });

  it('audioOnly with no audio track fails fast (503, egress never started)', async () => {
    const { svc, egressClient } = makeService([
      { sid: 'TR_v1', type: TrackType.VIDEO },
    ]);

    await expect(
      svc.startTrackCompositeEgress({ ...BASE, audioOnly: true }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(egressClient.startTrackCompositeEgress).not.toHaveBeenCalled();
  });

  it('a participant with no published tracks fails fast (503)', async () => {
    const { svc, egressClient } = makeService([]);

    await expect(svc.startTrackCompositeEgress(BASE)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(egressClient.startTrackCompositeEgress).not.toHaveBeenCalled();
  });

  it('an SDK failure surfaces as 503 (guard), never a crash', async () => {
    const { svc, egressClient } = makeService([
      { sid: 'TR_a1', type: TrackType.AUDIO },
    ]);
    egressClient.startTrackCompositeEgress.mockRejectedValue(
      new Error('egress unavailable'),
    );

    await expect(svc.startTrackCompositeEgress(BASE)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
