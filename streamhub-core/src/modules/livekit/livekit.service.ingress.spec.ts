/**
 * Unit spec — LiveKitService.createIngress: transcoding-bypass guard, the
 * GLOBAL ingest profile switch, presets-only encoding, and fallback-on-reject.
 *
 * The profile switch (`STREAMHUB_INGEST_PROFILE`) is the stability contract:
 *  - 'livekit' (DEFAULT — stable/legacy): StreamHub attaches NO encoding
 *    opinions; LiveKit decides everything (pre-2.7.1 behaviour). Instant
 *    rollback for the efficient profile.
 *  - 'efficient' (opt-in): an explicit single-layer PRESET by default, the
 *    matching 3-layer preset when the app opts into adaptive; audioOnly no
 *    longer drops the video options (LiveKit ≤1.8.4 ignores the flag and an
 *    option-less ingress falls back to the 3-layer default — the footgun).
 *  - fallback-on-reject: if LiveKit rejects our options, retry once with NO
 *    opinions — options may only ever degrade, never break ingress creation.
 *
 * IngressClient is a jest fake in the service's lazy `_ingressClient` slot.
 */
import { IngressVideoEncodingPreset } from '@livekit/protocol';
import { LiveKitService } from './livekit.service';
import { mockLogsService } from '../../../test/helpers/service-mocks';

function makeService(profile: 'efficient' | 'livekit' = 'efficient') {
  const config = {
    livekitUrl: 'ws://127.0.0.1:7880',
    livekitApiKey: 'key',
    livekitApiSecret: 'secret',
    ingestProfile: profile,
  } as any;
  const svc = new LiveKitService(config, mockLogsService());
  const createIngress = jest.fn(async (_inputType: unknown, opts: any) => ({
    ingressId: 'IN_1',
    url: 'rtmp://host/live',
    streamKey: 'sk_1',
    roomName: opts.roomName,
  }));
  (svc as any)._ingressClient = { createIngress };
  return { svc, createIngress };
}

const BASE = {
  appName: 'live',
  roomName: 'live-ch1',
  participantIdentity: 'ingress-live',
} as const;

describe('LiveKitService.createIngress — transcoding-bypass guard', () => {
  it('does NOT forward enableTranscoding:false for an RTMP input (no bypass error)', async () => {
    const { svc, createIngress } = makeService();
    await svc.createIngress({ ...BASE, inputType: 'rtmp', enableTranscoding: false });
    const opts = createIngress.mock.calls[0][1];
    expect(opts.enableTranscoding).toBeUndefined();
  });

  it('honours enableTranscoding:false for a WHIP input (bypass allowed)', async () => {
    const { svc, createIngress } = makeService();
    await svc.createIngress({ ...BASE, inputType: 'whip', enableTranscoding: false });
    const opts = createIngress.mock.calls[0][1];
    expect(opts.enableTranscoding).toBe(false);
  });

  it('does NOT forward a bypass for RTMP even when transcoding is requested on', async () => {
    const { svc, createIngress } = makeService();
    await svc.createIngress({ ...BASE, inputType: 'rtmp', enableTranscoding: true });
    const opts = createIngress.mock.calls[0][1];
    expect(opts.enableTranscoding).toBeUndefined();
  });
});

describe("ingest profile 'livekit' (DEFAULT — stable/legacy rollback)", () => {
  it('attaches NO video options and NO audioOnly — LiveKit decides everything', async () => {
    const { svc, createIngress } = makeService('livekit');
    await svc.createIngress({
      ...BASE,
      inputType: 'rtmp',
      simulcast: false,
      maxHeight: 480,
      audioOnly: true,
    });
    const opts = createIngress.mock.calls[0][1];
    expect(opts.video).toBeUndefined();
    expect(opts.audioOnly).toBeUndefined();
  });

  it('still hides the WHIP bypass rules (bypass forwarded for whip only)', async () => {
    const { svc, createIngress } = makeService('livekit');
    await svc.createIngress({ ...BASE, inputType: 'whip', enableTranscoding: false });
    expect(createIngress.mock.calls[0][1].enableTranscoding).toBe(false);
  });
});

describe("ingest profile 'efficient' — presets only", () => {
  function presetOf(opts: any): IngressVideoEncodingPreset {
    expect(opts.video?.encodingOptions?.case).toBe('preset');
    return opts.video.encodingOptions.value as IngressVideoEncodingPreset;
  }

  it('attaches the SINGLE-layer 720p preset by default (the safeguard)', async () => {
    const { svc, createIngress } = makeService('efficient');
    await svc.createIngress({ ...BASE, inputType: 'rtmp' });
    expect(presetOf(createIngress.mock.calls[0][1])).toBe(
      IngressVideoEncodingPreset.H264_720P_30FPS_1_LAYER,
    );
  });

  it('cap 1080 → single-layer 1080p preset', async () => {
    const { svc, createIngress } = makeService('efficient');
    await svc.createIngress({ ...BASE, inputType: 'rtmp', maxHeight: 1080 });
    expect(presetOf(createIngress.mock.calls[0][1])).toBe(
      IngressVideoEncodingPreset.H264_1080P_30FPS_1_LAYER,
    );
  });

  it('sub-720 caps fold UP to the 720p single-layer preset (no custom layers)', async () => {
    const { svc, createIngress } = makeService('efficient');
    await svc.createIngress({ ...BASE, inputType: 'rtmp', maxHeight: 360 });
    expect(presetOf(createIngress.mock.calls[0][1])).toBe(
      IngressVideoEncodingPreset.H264_720P_30FPS_1_LAYER,
    );
  });

  it('adaptive (simulcast:true) → the capped 3-LAYER preset, chosen explicitly', async () => {
    const { svc, createIngress } = makeService('efficient');
    await svc.createIngress({ ...BASE, inputType: 'rtmp', simulcast: true });
    expect(presetOf(createIngress.mock.calls[0][1])).toBe(
      IngressVideoEncodingPreset.H264_720P_30FPS_3_LAYERS,
    );
  });

  it('attaches no video for a WHIP passthrough bypass', async () => {
    const { svc, createIngress } = makeService('efficient');
    await svc.createIngress({
      ...BASE,
      inputType: 'whip',
      enableTranscoding: false,
      simulcast: false,
    });
    expect(createIngress.mock.calls[0][1].video).toBeUndefined();
  });

  it('audioOnly STILL attaches the single-layer preset (footgun fix: LiveKit ≤1.8.4 ignores audioOnly; option-less would mean the 3-layer default)', async () => {
    const { svc, createIngress } = makeService('efficient');
    await svc.createIngress({ ...BASE, inputType: 'rtmp', audioOnly: true });
    const opts = createIngress.mock.calls[0][1];
    expect(opts.audioOnly).toBe(true);
    expect(presetOf(opts)).toBe(
      IngressVideoEncodingPreset.H264_720P_30FPS_1_LAYER,
    );
  });
});

describe('fallback-on-reject — options degrade, never break', () => {
  it('retries once WITHOUT any encoding opinions when LiveKit rejects them', async () => {
    const { svc, createIngress } = makeService('efficient');
    createIngress.mockRejectedValueOnce(
      new Error('twirp error unknown: invalid video parameters'),
    );
    const info = await svc.createIngress({ ...BASE, inputType: 'rtmp' });
    expect(info.ingressId).toBe('IN_1');
    expect(createIngress).toHaveBeenCalledTimes(2);
    // First attempt carried our preset; the retry is opinion-free.
    expect(createIngress.mock.calls[0][1].video).toBeDefined();
    expect(createIngress.mock.calls[1][1].video).toBeUndefined();
    expect(createIngress.mock.calls[1][1].audioOnly).toBeUndefined();
  });

  it('does NOT retry when no opinions were attached (legacy profile) — the error propagates', async () => {
    const { svc, createIngress } = makeService('livekit');
    createIngress.mockRejectedValue(new Error('boom'));
    await expect(
      svc.createIngress({ ...BASE, inputType: 'rtmp' }),
    ).rejects.toThrow();
    expect(createIngress).toHaveBeenCalledTimes(1);
  });
});
