/**
 * Unit spec — LiveKitController public PLAY-TOKEN endpoint.
 *
 * Bug fix: the /play and /embed player pages need a LiveKit token with NO login.
 * `GET /apps/:app/play-token/:room` mints a subscribe-only (video+audio) token
 * for anonymous viewers. This spec pins:
 *   1. the route is marked @Public() (the global auth guard skips it),
 *   2. it mints a HIDDEN, subscribe-only, non-publishing token (a viewer must
 *      never become a stream/participant),
 *   3. the per-app `publicPlayback` feature gate (default ON): when disabled,
 *      an unsigned request is 403 (fix P0-3 — the signed-URL contract itself
 *      is pinned in livekit.playback.spec.ts).
 *
 * The controller is driven directly with light fakes — no HTTP/DI boot needed.
 */
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { LiveKitController } from './livekit.controller';
import { IS_PUBLIC_KEY } from '../../shared/auth/public.decorator';
import { APPS_SERVICE, type AppConfig } from '../../shared/contracts';

function makeController(publicPlayback = true) {
  const mintTokenAdvanced = jest.fn(async () => 'JWT_TOKEN');
  const livekit = { mintTokenAdvanced } as any;

  const cfg = {
    name: 'live',
    roomPrefix: 'live',
    features: { publicPlayback },
  } as unknown as AppConfig;
  const apps = { getConfig: jest.fn(async () => cfg) };
  const moduleRef = {
    get: jest.fn((token: symbol) => {
      if (token === APPS_SERVICE) return apps;
      throw new Error('not found');
    }),
  } as any;

  const config = {
    publicWsUrl: 'wss://media.test',
    env: () => '',
    jwtSecret: 'test-master-secret',
  } as any;
  const ingressAuth = {} as any;
  const quotas = {} as any;
  const ingressBackup = {
    getRoleInfo: () => ({ role: null, pairedIngressId: null }),
    getLinkFor: () => null,
    remove: () => {},
    link: () => {},
  } as any;

  const controller = new LiveKitController(
    livekit,
    config,
    ingressAuth,
    moduleRef,
    quotas,
    ingressBackup,
  );
  return { controller, mintTokenAdvanced, apps };
}

describe('LiveKitController — public play-token', () => {
  it('is registered as a @Public() route (no Bearer required)', () => {
    const isPublic = new Reflector().get<boolean>(
      IS_PUBLIC_KEY,
      LiveKitController.prototype.playToken,
    );
    expect(isPublic).toBe(true);
  });

  it('mints a hidden, subscribe-only (no publish/no data) token and returns { token, wsUrl }', async () => {
    const { controller, mintTokenAdvanced } = makeController(true);

    const res = await controller.playToken('live', 'room1');

    expect(mintTokenAdvanced).toHaveBeenCalledTimes(1);
    const opts = mintTokenAdvanced.mock.calls[0][0] as any;
    expect(opts).toMatchObject({
      room: 'live-room1', // namespaced under the app prefix
      canPublish: false,
      canSubscribe: true,
      canPublishData: false,
      hidden: true,
    });
    // Full video: NOT audio-only (contrast with the radio listen-token).
    expect(opts.audioOnly).toBeUndefined();

    expect(res.data).toMatchObject({
      token: 'JWT_TOKEN',
      app: 'live',
      room: 'live-room1',
      wsUrl: 'wss://media.test',
      mode: 'viewer',
    });
  });

  it('honours the publicPlayback feature gate: 403 without a signed URL (P0-3)', async () => {
    const { controller, mintTokenAdvanced } = makeController(false);
    await expect(controller.playToken('live', 'room1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(mintTokenAdvanced).not.toHaveBeenCalled();
  });
});

// ============================================================================
// QW-1 — 24/7 persistent room pre-create on ingress
// ============================================================================
//
// A 24/7 linear channel opts into `features.linear.persistentRoom`. The ingress
// controller must PRE-CREATE the LiveKit room with a long `emptyTimeout` BEFORE
// createIngress, so a source outage never recycles the room (which would change
// its SID and drop viewers). A normal app must NOT pre-create the room (it keeps
// LiveKit's ~300s server default).
function makeIngressController(
  linear?: Partial<{
    persistentRoom: boolean;
    roomEmptyTimeoutSeconds: number;
    alwaysOnHls: boolean;
    dvr: boolean;
    dvrWindowSeconds: number;
  }>,
) {
  const createRoom = jest.fn(async () => ({
    name: 'live-ch1',
    sid: 'RM_1',
    numParticipants: 0,
    creationTime: 0,
  }));
  const createIngress = jest.fn(async () => ({
    ingressId: 'IN_1',
    url: 'rtmp://host/live/key1',
    streamKey: 'key1',
    roomName: 'live-ch1',
  }));
  const livekit = { createRoom, createIngress } as any;

  const features: any = { adaptivePlayer: false, rtmpPassword: false };
  if (linear) {
    features.linear = {
      persistentRoom: false,
      roomEmptyTimeoutSeconds: 86400,
      alwaysOnHls: false,
      dvr: false,
      dvrWindowSeconds: 3600,
      ...linear,
    };
  }
  const cfg = {
    name: 'live',
    roomPrefix: 'live',
    features,
    rtmp: { transcode: false },
  } as unknown as AppConfig;
  const apps = { getConfig: jest.fn(async () => cfg) };
  const moduleRef = {
    get: jest.fn((token: symbol) => {
      if (token === APPS_SERVICE) return apps;
      throw new Error('not found');
    }),
  } as any;
  const config = { publicWsUrl: 'wss://m', env: () => '', jwtSecret: 's' } as any;
  const ingressAuth = { register: jest.fn(() => ({ password: undefined })) } as any;
  const quotas = { enforceConcurrentStreams: jest.fn(async () => {}) } as any;
  const ingressBackup = {
    link: () => {},
    getRoleInfo: () => ({ role: null, pairedIngressId: null }),
    getLinkFor: () => null,
    remove: () => {},
  } as any;

  const controller = new LiveKitController(
    livekit,
    config,
    ingressAuth,
    moduleRef,
    quotas,
    ingressBackup,
  );
  return { controller, createRoom, createIngress };
}

describe('LiveKitController — QW-1 persistent room on ingress', () => {
  const dto = { inputType: 'rtmp', room: 'ch1' } as any;

  it('a persistent-channel app pre-creates the room with a long emptyTimeout BEFORE createIngress', async () => {
    const { controller, createRoom, createIngress } = makeIngressController({
      persistentRoom: true,
      roomEmptyTimeoutSeconds: 86400,
    });

    await controller.createIngress('live', dto);

    expect(createRoom).toHaveBeenCalledTimes(1);
    expect(createRoom).toHaveBeenCalledWith('live-ch1', 86400);
    expect(createIngress).toHaveBeenCalledTimes(1);
    // Ordering: the room must be pre-created before the ingress.
    expect(createRoom.mock.invocationCallOrder[0]).toBeLessThan(
      createIngress.mock.invocationCallOrder[0],
    );
  });

  it('a normal app does NOT pre-create the room (keeps the 300s default)', async () => {
    const { controller, createRoom, createIngress } = makeIngressController();

    await controller.createIngress('live', dto);

    expect(createRoom).not.toHaveBeenCalled();
    expect(createIngress).toHaveBeenCalledTimes(1);
  });

  it('persistentRoom:false is treated as a normal app (no pre-create)', async () => {
    const { controller, createRoom } = makeIngressController({
      persistentRoom: false,
    });

    await controller.createIngress('live', dto);

    expect(createRoom).not.toHaveBeenCalled();
  });

  it('a createRoom hiccup never blocks ingress creation (best-effort)', async () => {
    const { controller, createRoom, createIngress } = makeIngressController({
      persistentRoom: true,
    });
    createRoom.mockRejectedValueOnce(new Error('livekit down'));

    await expect(controller.createIngress('live', dto)).resolves.toBeDefined();
    expect(createIngress).toHaveBeenCalledTimes(1);
  });
});
