/**
 * Unit spec — LiveKitService.startHlsEgress (DVR live playlist, QW-4).
 *
 * The live HLS egress writes a SegmentedFileOutput. For always-on/DVR channels
 * StreamHub sets `livePlaylistName` so LiveKit ALSO emits a bounded rolling
 * playlist (served as the public manifest so the live edge never grows
 * unbounded). Pins:
 *   1. `livePlaylistName` is set (absolute, inside outputDir) when provided;
 *   2. it is NOT set (proto default '') for a normal HLS start;
 *   3. `playlistName` (the full timeline) is always present.
 *
 * EgressClient is a jest fake in the service's lazy slot — nothing dials out.
 */
import * as path from 'path';

import { LiveKitService } from './livekit.service';
import { mockLogsService } from '../../../test/helpers/service-mocks';

function makeService() {
  const config = {
    livekitUrl: 'ws://127.0.0.1:7880',
    livekitApiKey: 'key',
    livekitApiSecret: 'secret',
  } as any;
  const svc = new LiveKitService(config, mockLogsService());
  const egressClient = {
    startRoomCompositeEgress: jest.fn(async () => ({
      egressId: 'EG_hls',
      status: 0, // EGRESS_STARTING
      roomName: 'live-ch1',
    })),
  };
  (svc as any)._egressClient = egressClient;
  return { svc, egressClient };
}

const OUT = '/data/apps/live/hls/live-ch1';
const BASE = {
  appName: 'live',
  roomName: 'live-ch1',
  outputDir: OUT,
  playlistName: 'index.m3u8',
  segmentDurationS: 4,
};

describe('LiveKitService.startHlsEgress — DVR live playlist', () => {
  it('sets livePlaylistName (absolute, in outputDir) when the DVR flag is on', async () => {
    const { svc, egressClient } = makeService();

    const res = await svc.startHlsEgress({ ...BASE, livePlaylistName: 'live.m3u8' });

    expect(egressClient.startRoomCompositeEgress).toHaveBeenCalledTimes(1);
    const [room, output] = egressClient.startRoomCompositeEgress.mock.calls[0];
    expect(room).toBe('live-ch1');
    const seg = (output as any).segments;
    expect(seg.playlistName).toBe(path.join(OUT, 'index.m3u8'));
    expect(seg.livePlaylistName).toBe(path.join(OUT, 'live.m3u8'));
    expect(res).toMatchObject({ egressId: 'EG_hls', roomName: 'live-ch1' });
  });

  it('does NOT set livePlaylistName for a normal HLS start (default behaviour)', async () => {
    const { svc, egressClient } = makeService();

    await svc.startHlsEgress(BASE);

    const output = egressClient.startRoomCompositeEgress.mock.calls[0][1];
    const seg = (output as any).segments;
    expect(seg.playlistName).toBe(path.join(OUT, 'index.m3u8'));
    // protobuf-es scalar string default is '' — no live playlist requested.
    expect(seg.livePlaylistName).toBe('');
  });
});
