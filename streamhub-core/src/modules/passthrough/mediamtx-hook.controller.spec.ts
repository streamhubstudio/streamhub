/**
 * Unit spec — MediaMTX internal hook controller (single-port :1935 switch).
 * Driven directly with a fake req (ip/socket/headers) + fake PassthroughService,
 * so the loopback+secret GUARD and the auth/ready/notready routing are pinned
 * with no app boot. The e2e counterpart (test/mediamtx-hook.e2e-spec.ts) proves
 * the routes are wired + @Public over the real HTTP stack.
 */
import {
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import type { ConfigService } from '../../shared/config/config.service';
import { MediamtxHookController } from './mediamtx-hook.controller';
import type { PassthroughService } from './passthrough.service';

const SECRET = 's3cret';

function fakePassthrough() {
  return {
    authorizeKey: jest.fn(() => true),
    handlePublish: jest.fn(() => ({ accepted: true })),
    handleDone: jest.fn(),
    handleForwardPublish: jest.fn(),
    handleForwardDone: jest.fn(),
  };
}

/** Fake Express request: loopback + correct secret header unless overridden. */
function req(opts: {
  ip?: string;
  secret?: string | string[] | undefined;
  querySecret?: string;
} = {}): Request {
  const ip = opts.ip ?? '127.0.0.1';
  const headers: Record<string, string | string[] | undefined> = {};
  const secret = 'secret' in opts ? opts.secret : SECRET;
  if (secret !== undefined) headers['x-mediamtx-secret'] = secret;
  const query: Record<string, unknown> = {};
  if (opts.querySecret !== undefined) query.secret = opts.querySecret;
  return {
    ip,
    socket: { remoteAddress: ip },
    headers,
    query,
  } as unknown as Request;
}

function makeController(secret = SECRET) {
  const pass = fakePassthrough();
  const config = { mediamtxHookSecret: secret } as ConfigService;
  const ctrl = new MediamtxHookController(
    config,
    pass as unknown as PassthroughService,
  );
  return { ctrl, pass };
}

describe('MediamtxHookController — internal-peer + secret guard', () => {
  it('rejects a PUBLIC peer even with a valid secret (403)', () => {
    const { ctrl } = makeController();
    expect(() => ctrl.auth(req({ ip: '8.8.8.8' }), { action: 'publish', path: 'a/ptk_x' })).toThrow(
      ForbiddenException,
    );
  });

  it('rejects a missing secret (403)', () => {
    const { ctrl } = makeController();
    expect(() =>
      ctrl.auth(req({ secret: undefined }), { action: 'publish', path: 'a/ptk_x' }),
    ).toThrow(ForbiddenException);
  });

  it('rejects a wrong secret (403)', () => {
    const { ctrl } = makeController();
    expect(() =>
      ctrl.auth(req({ secret: 'nope' }), { action: 'publish', path: 'a/ptk_x' }),
    ).toThrow(ForbiddenException);
  });

  it('DISABLES the routes when no secret is configured (403)', () => {
    const { ctrl } = makeController('');
    expect(() =>
      ctrl.auth(req({ secret: undefined }), { action: 'publish', path: 'a/ptk_x' }),
    ).toThrow(ForbiddenException);
  });

  it('accepts IPv6 loopback ::1', () => {
    const { ctrl, pass } = makeController();
    expect(ctrl.auth(req({ ip: '::1' }), { action: 'publish', path: 'a/ptk_x' })).toEqual({
      ok: true,
    });
    expect(pass.authorizeKey).toHaveBeenCalledWith('a', 'ptk_x');
  });

  it('accepts an RFC1918 compose-bridge peer (172.x) with the secret', () => {
    const { ctrl } = makeController();
    expect(
      ctrl.auth(req({ ip: '172.20.0.5' }), { action: 'publish', path: 'a/ptk_x' }),
    ).toEqual({ ok: true });
  });

  it('accepts the secret via ?secret= query param when the header is absent', () => {
    const { ctrl } = makeController();
    expect(
      ctrl.auth(req({ secret: undefined, querySecret: SECRET }), {
        action: 'publish',
        path: 'a/ptk_x',
      }),
    ).toEqual({ ok: true });
  });

  it('rejects a wrong ?secret= query param', () => {
    const { ctrl } = makeController();
    expect(() =>
      ctrl.auth(req({ secret: undefined, querySecret: 'nope' }), {
        action: 'publish',
        path: 'a/ptk_x',
      }),
    ).toThrow(ForbiddenException);
  });
});

describe('MediamtxHookController — /auth (publish allow/deny)', () => {
  it('allows a non-publish action (reads/HLS) without touching the key store', () => {
    const { ctrl, pass } = makeController();
    expect(ctrl.auth(req(), { action: 'read', path: 'anything' })).toEqual({ ok: true });
    expect(pass.authorizeKey).not.toHaveBeenCalled();
  });

  it('allows the LiveKit plane (live/<key>) — LiveKit does its own auth', () => {
    const { ctrl, pass } = makeController();
    expect(ctrl.auth(req(), { action: 'publish', path: 'live/sk_lk' })).toEqual({ ok: true });
    expect(pass.authorizeKey).not.toHaveBeenCalled();
  });

  it('allows a valid passthrough key', () => {
    const { ctrl, pass } = makeController();
    pass.authorizeKey.mockReturnValue(true);
    expect(ctrl.auth(req(), { action: 'publish', path: 'shop/ptk_ok' })).toEqual({ ok: true });
    expect(pass.authorizeKey).toHaveBeenCalledWith('shop', 'ptk_ok');
  });

  it('DENIES an unknown passthrough key (401)', () => {
    const { ctrl, pass } = makeController();
    pass.authorizeKey.mockReturnValue(false);
    expect(() => ctrl.auth(req(), { action: 'publish', path: 'shop/ptk_bad' })).toThrow(
      UnauthorizedException,
    );
  });

  it('DENIES a garbage path (401)', () => {
    const { ctrl } = makeController();
    expect(() => ctrl.auth(req(), { action: 'publish', path: 'garbage' })).toThrow(
      UnauthorizedException,
    );
  });
});

describe('MediamtxHookController — /ready + /notready', () => {
  it('ready arms the passthrough remux (handlePublish) for a passthrough path', () => {
    const { ctrl, pass } = makeController();
    expect(ctrl.ready(req(), { path: 'shop/ptk_ok' })).toEqual({ ok: true });
    expect(pass.handlePublish).toHaveBeenCalledWith('shop', 'ptk_ok');
    expect(pass.handleForwardPublish).not.toHaveBeenCalled();
  });

  it('ready arms the FORWARD (handleForwardPublish) for the LiveKit plane', () => {
    const { ctrl, pass } = makeController();
    expect(ctrl.ready(req(), { path: 'live/sk_lk' })).toEqual({ ok: true });
    expect(pass.handleForwardPublish).toHaveBeenCalledWith('sk_lk');
    expect(pass.handlePublish).not.toHaveBeenCalled();
  });

  it('ready is a no-op for a garbage path (neither remux nor forward)', () => {
    const { ctrl, pass } = makeController();
    expect(ctrl.ready(req(), { path: 'garbage' })).toEqual({ ok: true });
    expect(pass.handlePublish).not.toHaveBeenCalled();
    expect(pass.handleForwardPublish).not.toHaveBeenCalled();
  });

  it('notready stops the remux (handleDone) for a passthrough path', () => {
    const { ctrl, pass } = makeController();
    expect(ctrl.notready(req(), { path: 'shop/ptk_ok' })).toEqual({ ok: true });
    expect(pass.handleDone).toHaveBeenCalledWith('shop', 'ptk_ok');
    expect(pass.handleForwardDone).not.toHaveBeenCalled();
  });

  it('notready stops the FORWARD for the LiveKit plane', () => {
    const { ctrl, pass } = makeController();
    expect(ctrl.notready(req(), { path: 'live/sk_lk' })).toEqual({ ok: true });
    expect(pass.handleForwardDone).toHaveBeenCalledWith('sk_lk');
    expect(pass.handleDone).not.toHaveBeenCalled();
  });

  it('notready is a no-op for a garbage path', () => {
    const { ctrl, pass } = makeController();
    expect(ctrl.notready(req(), { path: 'garbage' })).toEqual({ ok: true });
    expect(pass.handleDone).not.toHaveBeenCalled();
    expect(pass.handleForwardDone).not.toHaveBeenCalled();
  });

  it('ready/notready enforce the same guard (403 off-internal / bad secret)', () => {
    const { ctrl } = makeController();
    expect(() => ctrl.ready(req({ ip: '8.8.8.8' }), { path: 'shop/ptk_ok' })).toThrow(
      ForbiddenException,
    );
    expect(() => ctrl.notready(req({ secret: 'nope' }), { path: 'shop/ptk_ok' })).toThrow(
      ForbiddenException,
    );
  });
});
