/**
 * Unit spec — LiveKitController public PLAY-TOKEN endpoint.
 *
 * Bug fix: the /play and /embed player pages need a LiveKit token with NO login.
 * `GET /apps/:app/play-token/:room` mints a subscribe-only (video+audio) token
 * for anonymous viewers. This spec pins:
 *   1. the route is marked @Public() (the global auth guard skips it),
 *   2. it mints a HIDDEN, subscribe-only, non-publishing token (a viewer must
 *      never become a stream/participant),
 *   3. the per-app `publicPlayback` feature gate (default ON) can disable it.
 *
 * The controller is driven directly with light fakes — no HTTP/DI boot needed.
 */
import { NotFoundException } from '@nestjs/common';
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

  const config = { publicWsUrl: 'wss://media.test', env: () => '' } as any;
  const ingressAuth = {} as any;
  const quotas = {} as any;

  const controller = new LiveKitController(
    livekit,
    config,
    ingressAuth,
    moduleRef,
    quotas,
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

  it('honours the publicPlayback feature gate: 404 when disabled', async () => {
    const { controller, mintTokenAdvanced } = makeController(false);
    await expect(controller.playToken('live', 'room1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mintTokenAdvanced).not.toHaveBeenCalled();
  });
});
