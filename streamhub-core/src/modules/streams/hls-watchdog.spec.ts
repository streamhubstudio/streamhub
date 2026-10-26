/**
 * Unit spec — HlsWatchdogService (auto-HLS watchdog, QW-2).
 *
 * For always-on linear-channel apps the watchdog relaunches a DEAD HLS egress
 * and never double-launches a LIVE one (HlsService.start is idempotent, but the
 * watchdog checks liveness first so it doesn't even call start when one exists).
 * Pins:
 *   1. a dead egress (no active HLS for the room) → exactly ONE start();
 *   2. a live egress → ZERO start();
 *   3. a non-linear app is skipped entirely;
 *   4. two active streams in the SAME room → still ONE start (dedup).
 *
 * All collaborators are jest fakes — nothing dials LiveKit or touches disk.
 */
import { HlsWatchdogService } from './hls-watchdog.service';
import { mockLogsService } from '../../../test/helpers/service-mocks';

interface Opts {
  alwaysOnHls?: boolean;
  dvr?: boolean;
  streams?: Array<{ streamId: string; room: string; status: string }>;
  /** Active HLS egresses returned by listHlsEgress, keyed by room. */
  liveEgress?: Array<{ egressId: string; roomName: string; status: string }>;
  linear?: boolean; // whether the app opts into features.linear at all
}

function make(opts: Opts = {}) {
  const {
    alwaysOnHls = true,
    dvr = false,
    linear = true,
    streams = [{ streamId: 's1', room: 'live-ch1', status: 'active' }],
    liveEgress = [],
  } = opts;

  const cfg = {
    name: 'live',
    roomPrefix: 'live',
    features: {
      linear: linear
        ? {
            persistentRoom: false,
            roomEmptyTimeoutSeconds: 86400,
            alwaysOnHls,
            dvr,
            dvrWindowSeconds: 3600,
          }
        : undefined,
    },
  } as any;

  const config = {
    nodeEnv: 'test',
    publicBaseUrl: '',
    env: () => undefined,
  } as any;
  const streamsSvc = { list: jest.fn(async () => streams) } as any;
  const hls = {
    start: jest.fn(async () => ({
      egressId: 'EG_new',
      playlistUrl: 'u',
      status: 'EGRESS_ACTIVE',
    })),
  } as any;
  const apps = {
    list: jest.fn(async () => [{ name: 'live' }]),
    getConfig: jest.fn(async () => cfg),
    appDir: (name: string) => `/tmp/${name}`,
  } as any;
  const livekit = {
    listHlsEgress: jest.fn(async () => liveEgress),
  } as any;

  const svc = new HlsWatchdogService(
    config,
    streamsSvc,
    hls,
    apps,
    livekit,
    mockLogsService(),
  );
  return { svc, hls, livekit, apps, streamsSvc };
}

describe('HlsWatchdogService.reconcileOnce', () => {
  it('relaunches a DEAD HLS egress exactly once (idempotent start)', async () => {
    const { svc, hls } = make({ liveEgress: [] });

    const res = await svc.reconcileOnce();

    expect(hls.start).toHaveBeenCalledTimes(1);
    expect(hls.start).toHaveBeenCalledWith('live', 's1', '');
    expect(res).toMatchObject({ checked: 1, relaunched: 1 });
  });

  it('does NOT relaunch when a LIVE HLS egress already exists', async () => {
    const { svc, hls } = make({
      liveEgress: [
        { egressId: 'EG_live', roomName: 'live-ch1', status: 'EGRESS_ACTIVE' },
      ],
    });

    const res = await svc.reconcileOnce();

    expect(hls.start).not.toHaveBeenCalled();
    expect(res).toMatchObject({ checked: 1, relaunched: 0 });
  });

  it('skips an app that does not opt into features.linear', async () => {
    const { svc, hls, livekit, streamsSvc } = make({ linear: false });

    const res = await svc.reconcileOnce();

    expect(hls.start).not.toHaveBeenCalled();
    expect(livekit.listHlsEgress).not.toHaveBeenCalled();
    expect(streamsSvc.list).not.toHaveBeenCalled();
    expect(res).toMatchObject({ checked: 0, relaunched: 0 });
  });

  it('skips an always-on:false + dvr:false app', async () => {
    const { svc, hls } = make({ alwaysOnHls: false, dvr: false });

    const res = await svc.reconcileOnce();

    expect(hls.start).not.toHaveBeenCalled();
    expect(res.checked).toBe(0);
  });

  it('deduplicates: two active streams in the same room trigger ONE start', async () => {
    const { svc, hls } = make({
      streams: [
        { streamId: 's1', room: 'live-ch1', status: 'active' },
        { streamId: 's2', room: 'live-ch1', status: 'active' },
      ],
      liveEgress: [],
    });

    const res = await svc.reconcileOnce();

    expect(hls.start).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ checked: 1, relaunched: 1 });
  });

  it('assumes alive on a transient listHlsEgress failure (never double-launches)', async () => {
    const { svc, hls, livekit } = make({ liveEgress: [] });
    livekit.listHlsEgress.mockRejectedValueOnce(new Error('livekit down'));

    const res = await svc.reconcileOnce();

    expect(hls.start).not.toHaveBeenCalled();
    expect(res.relaunched).toBe(0);
  });
});
