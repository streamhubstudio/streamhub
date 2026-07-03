/**
 * Unit + e2e spec — WebhooksController (callbacks-webhooks module).
 *
 * The LiveKit webhook sink. Two concerns:
 *   1. Signature verification: authenticity comes from LiveKit's Authorization
 *      header (WebhookReceiver), not a Bearer token. A rejected signature must
 *      401 and MUST NOT route/dispatch anything.
 *   2. Routing: every recognised LiveKit event is (a) run through its business
 *      handler (stream upsert / recording advance) and (b) forwarded verbatim to
 *      the app callback (forwardRaw). Callbacks must never fire app-less, and a
 *      downstream failure must never crash the ack (always 200).
 *
 * Unit tests drive the controller directly with a fake ModuleRef resolving the
 * shared harness mocks; one e2e test exercises the real signature-rejection path
 * through the booted AppModule.
 *
 * Owned by the callbacks-webhooks test agent.
 */
import { UnauthorizedException } from '@nestjs/common';
import { ParticipantInfo_Kind, IngressInput, EgressStatus } from '@livekit/protocol';

import { WebhooksController } from './webhooks.controller';
import {
  APPS_SERVICE,
  CALLBACKS_SERVICE,
  LOGS_SERVICE,
  RECORDING_SERVICE,
  STREAMS_SERVICE,
} from '../../shared/contracts';
import {
  bootstrapTestApp,
  mockAppsService,
  mockCallbacksService,
  mockLogsService,
  mockRecordingService,
  mockStreamsService,
  type TestApp,
} from '../../../test/helpers';

// -----------------------------------------------------------------------------
// Harness for the controller under test
// -----------------------------------------------------------------------------

function makeController() {
  const apps = mockAppsService();
  const callbacks = mockCallbacksService();
  const logs = mockLogsService();
  const streams = mockStreamsService();
  const recording = mockRecordingService();
  streams.upsert.mockResolvedValue({} as any);

  // Default app registry: one app "live" with room prefix "live".
  apps.list.mockResolvedValue([
    {
      id: 1,
      name: 'live',
      displayName: 'Live',
      livekitRoomPrefix: 'live',
      createdAt: '',
      updatedAt: '',
      settingsJson: null,
    },
  ]);

  const livekit = { receiveWebhook: jest.fn(async () => ({})) };
  const ingressAuth = { isAuthorized: jest.fn(() => true), remove: jest.fn() };

  const byToken = new Map<symbol, unknown>([
    [APPS_SERVICE, apps],
    [CALLBACKS_SERVICE, callbacks],
    [LOGS_SERVICE, logs],
    [STREAMS_SERVICE, streams],
    [RECORDING_SERVICE, recording],
  ]);
  const moduleRef = {
    get: jest.fn((token: symbol) => {
      const v = byToken.get(token);
      if (!v) throw new Error('not found');
      return v;
    }),
  };

  const controller = new WebhooksController(
    livekit as any,
    ingressAuth as any,
    moduleRef as any,
  );
  return { controller, apps, callbacks, logs, streams, recording, livekit, ingressAuth };
}

/** Feed a decoded LiveKit event through the controller (signature pre-passed). */
async function receive(
  h: ReturnType<typeof makeController>,
  event: Record<string, unknown>,
) {
  h.livekit.receiveWebhook.mockResolvedValue(event as any);
  return h.controller.receive(
    { rawBody: Buffer.from('{}') } as any,
    'Bearer whatever',
  );
}

/** Names dispatched to a callback for the given app. */
function dispatchedEvents(h: ReturnType<typeof makeController>): string[] {
  return h.callbacks.dispatch.mock.calls.map((c) => c[1] as string);
}

// -----------------------------------------------------------------------------
// 1) Signature verification
// -----------------------------------------------------------------------------

describe('WebhooksController — signature verification', () => {
  it('acks { data: { received: true } } when the signature is valid', async () => {
    const h = makeController();
    const res = await receive(h, {
      event: 'room_started',
      room: { name: 'live-1' },
    });
    expect(res).toEqual({ data: { received: true } });
  });

  it('throws 401 and routes NOTHING when receiveWebhook rejects', async () => {
    const h = makeController();
    h.livekit.receiveWebhook.mockRejectedValue(new Error('bad sig'));

    await expect(
      h.controller.receive({ rawBody: Buffer.from('{}') } as any, 'bad'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(h.callbacks.dispatch).not.toHaveBeenCalled();
    expect(h.streams.upsert).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// 2) Forwarding — every recognised event routes to dispatch
// -----------------------------------------------------------------------------

describe('WebhooksController — forwards events to the callback', () => {
  const FORWARDED = [
    'room_started',
    'room_finished',
    'track_published',
    'track_unpublished',
  ];

  it.each(FORWARDED)('forwards "%s" verbatim to dispatch', async (name) => {
    const h = makeController();
    await receive(h, { event: name, room: { name: 'live-1' } });

    expect(h.callbacks.dispatch).toHaveBeenCalledTimes(1);
    const [app, ev, data] = h.callbacks.dispatch.mock.calls[0];
    expect(app).toBe('live');
    expect(ev).toBe(name);
    expect(data).toMatchObject({ room: 'live-1' });
  });

  it('does NOT forward unmapped LiveKit events (e.g. track_muted)', async () => {
    const h = makeController();
    await receive(h, { event: 'track_muted', room: { name: 'live-1' } });
    expect(h.callbacks.dispatch).not.toHaveBeenCalled();
  });

  it('NEVER fires a callback when no app resolves from the room', async () => {
    const h = makeController();
    // Room prefix "other-" does not match the "live" app.
    await receive(h, { event: 'room_started', room: { name: 'other-9' } });
    expect(h.callbacks.dispatch).not.toHaveBeenCalled();
  });

  it('builds flat JSON-safe data (participant/track/ids) in the forwarded payload', async () => {
    const h = makeController();
    h.streams.upsert.mockResolvedValue({} as any);
    await receive(h, {
      event: 'track_published',
      room: { name: 'live-1' },
      id: 'EV1',
      createdAt: 1700000000,
      participant: {
        identity: 'pub',
        name: 'Publisher',
        sid: 'PA_1',
        permission: { hidden: false },
      },
      track: { sid: 'TR_1', type: 1, source: 2, muted: false },
    });

    // The RAW forward of track_published carries the flat participant/track data
    // (a separate stream_started business dispatch also fires — pick the raw one).
    const raw = h.callbacks.dispatch.mock.calls.find(
      (c) => c[1] === 'track_published',
    );
    const data = raw?.[2] as any;
    expect(data.room).toBe('live-1');
    expect(data.participant).toMatchObject({ identity: 'pub', sid: 'PA_1' });
    expect(data.track).toMatchObject({ sid: 'TR_1', muted: false });
    expect(data.eventId).toBe('EV1');
    expect(data.createdAt).toBe(1700000000);
  });
});

// -----------------------------------------------------------------------------
// 3) stream lifecycle — a stream is a PUBLISHER (track_published), never a
//    bare joiner. REGRESSION for the over-count bug (subscribers counted as
//    streams): participant_joined must NOT create a stream.
// -----------------------------------------------------------------------------

describe('WebhooksController — stream lifecycle (publisher = track_published)', () => {
  it('REGRESSION: participant_joined (a subscriber/viewer) creates NO stream — only forwards the raw event', async () => {
    const h = makeController();
    await receive(h, {
      event: 'participant_joined',
      room: { name: 'live-1' },
      participant: { identity: 'viewer', kind: ParticipantInfo_Kind.STANDARD },
    });
    // The bug: a mere joiner (0 published tracks) became a stream row.
    expect(h.streams.upsert).not.toHaveBeenCalled();
    // No business stream_started; the raw participant_joined is still forwarded.
    expect(dispatchedEvents(h)).toEqual(['participant_joined']);
  });

  it('track_published upserts a webrtc stream and dispatches BOTH stream_started and track_published', async () => {
    const h = makeController();
    await receive(h, {
      event: 'track_published',
      room: { name: 'live-1' },
      participant: { identity: 'alice', kind: ParticipantInfo_Kind.STANDARD },
      track: { sid: 'TR_1', type: 1, source: 2, muted: false },
    });

    // Canonical stream key = `${room}/${identity}`.
    expect(h.streams.upsert).toHaveBeenCalledWith(
      'live',
      'live-1/alice',
      'webrtc',
      'live-1',
      'alice',
    );
    const evs = dispatchedEvents(h);
    expect(evs).toContain('stream_started'); // business
    expect(evs).toContain('track_published'); // raw forward
    expect(evs).toHaveLength(2);
  });

  it('marks an INGRESS-kind publisher as an rtmp stream on track_published', async () => {
    const h = makeController();
    await receive(h, {
      event: 'track_published',
      room: { name: 'live-1' },
      participant: { identity: 'ing', kind: ParticipantInfo_Kind.INGRESS },
      track: { sid: 'TR_2', type: 1, source: 2, muted: false },
    });
    expect(h.streams.upsert).toHaveBeenCalledWith(
      'live',
      'live-1/ing',
      'rtmp',
      'live-1',
      'ing',
    );
  });

  it('skips hidden (QC/recorder) publishers for business but STILL forwards the raw track_published', async () => {
    const h = makeController();
    await receive(h, {
      event: 'track_published',
      room: { name: 'live-1' },
      participant: { identity: 'qc', permission: { hidden: true } },
      track: { sid: 'TR_3', type: 1, source: 2, muted: false },
    });
    // No stream row, no business stream_started...
    expect(h.streams.upsert).not.toHaveBeenCalled();
    // ...but the raw track_published is still forwarded (forwardRaw is unconditional).
    expect(dispatchedEvents(h)).toEqual(['track_published']);
  });

  it('track_unpublished ends the stream (streams.end) and dispatches stream_ended', async () => {
    const h = makeController();
    await receive(h, {
      event: 'track_unpublished',
      room: { name: 'live-1' },
      participant: { identity: 'alice' },
      track: { sid: 'TR_1', type: 1, source: 2, muted: false },
    });
    expect(h.streams.end).toHaveBeenCalledWith('live', 'live-1/alice');
    const ended = h.callbacks.dispatch.mock.calls.find(
      (c) => c[1] === 'stream_ended',
    );
    expect(ended?.[2]).toMatchObject({
      streamId: 'live-1/alice',
      room: 'live-1',
      participant: 'alice',
    });
  });

  it('ends the stream (streams.end) and dispatches stream_ended on participant_left', async () => {
    const h = makeController();
    await receive(h, {
      event: 'participant_left',
      room: { name: 'live-1' },
      participant: { identity: 'alice' },
    });
    expect(h.streams.end).toHaveBeenCalledWith('live', 'live-1/alice');
    const business = h.callbacks.dispatch.mock.calls.find(
      (c) => c[1] === 'stream_ended',
    );
    expect(business?.[2]).toMatchObject({
      streamId: 'live-1/alice',
      room: 'live-1',
      participant: 'alice',
    });
  });
});

// -----------------------------------------------------------------------------
// 4) ingress events + RTMP password enforcement
// -----------------------------------------------------------------------------

describe('WebhooksController — ingress events', () => {
  it('upserts + dispatches stream_started when the participant identity is known', async () => {
    const h = makeController();
    await receive(h, {
      event: 'ingress_started',
      ingressInfo: {
        ingressId: 'IN_1',
        inputType: IngressInput.WHIP_INPUT,
        roomName: 'live-1',
        participantIdentity: 'whip-pub',
      },
    });
    expect(h.streams.upsert).toHaveBeenCalledWith(
      'live',
      'live-1/whip-pub',
      'whip',
      'live-1',
      'whip-pub',
    );
    expect(dispatchedEvents(h)).toEqual(
      expect.arrayContaining(['stream_started', 'ingress_started']),
    );
  });

  it('terminates an unauthorized RTMP ingress and emits stream_ended (unauthorized_rtmp_password)', async () => {
    const h = makeController();
    h.ingressAuth.isAuthorized.mockReturnValue(false);
    const del = jest.fn(async () => undefined);
    (h.livekit as any).deleteIngress = del;

    await receive(h, {
      event: 'ingress_started',
      ingressInfo: {
        ingressId: 'IN_bad',
        inputType: IngressInput.RTMP_INPUT,
        roomName: 'live-1',
        participantIdentity: '',
      },
    });

    expect(del).toHaveBeenCalledWith('IN_bad');
    // ingress-auth now routes per-app: the resolved app name is threaded through.
    expect(h.ingressAuth.remove).toHaveBeenCalledWith('live', 'IN_bad');
    // No stream row created for the rejected push.
    expect(h.streams.upsert).not.toHaveBeenCalled();
    const ended = h.callbacks.dispatch.mock.calls.find(
      (c) => c[1] === 'stream_ended',
    );
    expect(ended?.[2]).toMatchObject({ reason: 'unauthorized_rtmp_password' });
  });

  it('dispatches stream_ended on ingress_ended', async () => {
    const h = makeController();
    await receive(h, {
      event: 'ingress_ended',
      ingressInfo: {
        ingressId: 'IN_1',
        inputType: IngressInput.RTMP_INPUT,
        roomName: 'live-1',
        participantIdentity: 'p1',
      },
    });
    const ended = h.callbacks.dispatch.mock.calls.find(
      (c) => c[1] === 'stream_ended',
    );
    expect(ended?.[2]).toMatchObject({ streamId: 'live-1/p1', ingressId: 'IN_1' });
  });
});

// -----------------------------------------------------------------------------
// 5) egress → recording advance + raw forward
// -----------------------------------------------------------------------------

describe('WebhooksController — egress events', () => {
  it('advances the recording flow and forwards the raw egress event', async () => {
    const h = makeController();
    await receive(h, {
      event: 'egress_ended',
      room: { name: 'live-1' },
      egressInfo: {
        egressId: 'EG_1',
        status: EgressStatus.EGRESS_COMPLETE,
        roomName: 'live-1',
      },
    });
    expect(h.recording.onEgressEvent).toHaveBeenCalledWith(
      'EG_1',
      'EGRESS_COMPLETE',
      expect.any(Object),
    );
    expect(dispatchedEvents(h)).toContain('egress_ended');
  });
});

// -----------------------------------------------------------------------------
// 6) Resilience — a downstream failure never breaks the 200 ack
// -----------------------------------------------------------------------------

describe('WebhooksController — resilience (always ack 200)', () => {
  it('still acks when streams.upsert throws', async () => {
    const h = makeController();
    h.streams.upsert.mockRejectedValue(new Error('db down'));
    const res = await receive(h, {
      event: 'track_published',
      room: { name: 'live-1' },
      participant: { identity: 'alice' },
      track: { sid: 'TR_1', type: 1, source: 2, muted: false },
    });
    expect(res).toEqual({ data: { received: true } });
    // Raw forward still happened despite the upsert failure.
    expect(dispatchedEvents(h)).toContain('track_published');
  });

  it('still acks when callbacks.dispatch throws', async () => {
    const h = makeController();
    h.callbacks.dispatch.mockRejectedValue(new Error('dispatch boom'));
    const res = await receive(h, {
      event: 'room_started',
      room: { name: 'live-1' },
    });
    expect(res).toEqual({ data: { received: true } });
  });
});

// -----------------------------------------------------------------------------
// 7) e2e — real signature-rejection path through the booted AppModule
// -----------------------------------------------------------------------------

describe('WebhooksController (e2e) — POST /api/v1/webhooks/livekit', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await bootstrapTestApp();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('is a public route that rejects an unsigned/invalid webhook with 401', async () => {
    await ctx
      .request()
      .post('/api/v1/webhooks/livekit')
      .set('content-type', 'application/json')
      .send({ event: 'room_started', room: { name: 'live-1' } })
      .expect(401);
  });
});
