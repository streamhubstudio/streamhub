/**
 * Unit spec — LiveKitController public playback endpoints under fix P0-3.
 *
 * Drives the controller directly with light fakes (no HTTP/DI boot), pinning:
 *   1. PUBLIC app (public_playback unset/true — the default): play-token and
 *      radio listen-token keep minting anonymously, NO signature needed
 *      (back-compat: existing /play + /embed players keep working);
 *   2. PRIVATE app (public_playback:false): missing / tampered signatures →
 *      403; a genuine expired signature → 403 ("expired"); a valid signed URL
 *      mints a subscribe-only token;
 *   3. the sign endpoint requires stream:read (RBAC metadata), clamps the TTL
 *      and round-trips with play-token verification;
 *   4. the radio listen-token honours the same gate.
 */
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { LiveKitController } from './livekit.controller';
import { signPlayback } from './playback-url.util';
import {
  REQUIRE_PERMISSION_KEY,
  RequiredPermission,
} from '../authz/permission.decorator';
import { APPS_SERVICE, type AppConfig } from '../../shared/contracts';

const MASTER = 'test-master-secret';

function makeController(opts: { publicPlayback?: boolean } = {}) {
  const livekit = {
    mintTokenAdvanced: jest.fn(async () => 'lk-token'),
  };
  const config = {
    jwtSecret: MASTER,
    publicWsUrl: 'wss://media.example/rtc',
    rtmpPublicHost: '',
    env: () => '',
  };
  const cfg = {
    name: 'live',
    roomPrefix: 'live',
    features: {
      publicPlayback: opts.publicPlayback ?? true,
      hiddenQc: false,
      adaptivePlayer: false,
      chat: true,
      reactions: true,
      rtmpPassword: false,
      viewerCounter: false,
    },
    webrtc: { adaptive: false, layers: [] },
    rtmp: { enabled: true, transcode: false },
  } as unknown as AppConfig;
  const apps = { getConfig: jest.fn(async () => cfg) };
  const moduleRef = {
    get: jest.fn((token: symbol) => {
      if (token === APPS_SERVICE) return apps;
      throw new Error('not found');
    }),
  };
  const quotas = { enforceConcurrentStreams: jest.fn(async () => undefined) };
  const controller = new LiveKitController(
    livekit as never,
    config as never,
    {} as never, // IngressAuthService — untouched by these routes
    moduleRef as never,
    quotas as never,
  );
  return { controller, livekit };
}

function expIn(seconds: number): string {
  return String(Math.floor(Date.now() / 1000) + seconds);
}

describe('LiveKitController — playback (P0-3)', () => {
  describe('PUBLIC app (default) — anonymous playback keeps working', () => {
    it('play-token mints with NO signature', async () => {
      const { controller, livekit } = makeController({ publicPlayback: true });
      const res = await controller.playToken('live', 'show');
      expect(res.data.token).toBe('lk-token');
      expect(res.data.room).toBe('live-show');
      expect(livekit.mintTokenAdvanced).toHaveBeenCalledWith(
        expect.objectContaining({ canPublish: false, canSubscribe: true, hidden: true }),
      );
    });

    it('radio listen-token mints with NO signature', async () => {
      const { controller } = makeController({ publicPlayback: true });
      const res = await controller.listenToken('live', 'radio1');
      expect(res.data.token).toBe('lk-token');
      expect(res.data.mode).toBe('listener');
    });
  });

  describe('PRIVATE app (public_playback:false) — signed URL required', () => {
    it('403s with NO signature (no more room-name-secrecy playback)', async () => {
      const { controller, livekit } = makeController({ publicPlayback: false });
      await expect(controller.playToken('live', 'show')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(livekit.mintTokenAdvanced).not.toHaveBeenCalled();
    });

    it('mints with a VALID signature', async () => {
      const { controller } = makeController({ publicPlayback: false });
      const exp = expIn(300);
      const sig = signPlayback(MASTER, 'live', 'show', Number(exp));
      const res = await controller.playToken('live', 'show', exp, sig);
      expect(res.data.token).toBe('lk-token');
    });

    it('403s an EXPIRED (but genuine) signature', async () => {
      const { controller } = makeController({ publicPlayback: false });
      const exp = String(Math.floor(Date.now() / 1000) - 10);
      const sig = signPlayback(MASTER, 'live', 'show', Number(exp));
      await expect(
        controller.playToken('live', 'show', exp, sig),
      ).rejects.toMatchObject({ message: expect.stringContaining('expired') });
    });

    it('403s a TAMPERED signature / room / extended exp', async () => {
      const { controller } = makeController({ publicPlayback: false });
      const exp = expIn(300);
      const sig = signPlayback(MASTER, 'live', 'show', Number(exp));
      const flipped = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1);
      await expect(
        controller.playToken('live', 'show', exp, flipped),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Signature for room A does not open room B.
      await expect(
        controller.playToken('live', 'other', exp, sig),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Extending exp invalidates the MAC (never reads as merely expired).
      await expect(
        controller.playToken('live', 'show', String(Number(exp) + 999), sig),
      ).rejects.toMatchObject({
        message: expect.stringContaining('signed URL'),
      });
    });

    it('gates the radio listen-token the same way', async () => {
      const { controller } = makeController({ publicPlayback: false });
      await expect(controller.listenToken('live', 'radio1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      const exp = expIn(300);
      const sig = signPlayback(MASTER, 'live', 'radio1', Number(exp));
      const res = await controller.listenToken('live', 'radio1', exp, sig);
      expect(res.data.token).toBe('lk-token');
    });
  });

  describe('POST play-token/:room/sign (authenticated mint)', () => {
    it('requires stream:read (RBAC metadata)', () => {
      const required = new Reflector().get<RequiredPermission>(
        REQUIRE_PERMISSION_KEY,
        LiveKitController.prototype.signPlaybackUrl,
      );
      expect(required).toEqual({ resource: 'stream', action: 'read' });
    });

    it('round-trips: the signed URL it mints passes play-token verification', async () => {
      const { controller } = makeController({ publicPlayback: false });
      const signed = controller.signPlaybackUrl('live', 'show', {});
      expect(signed.data.tokenUrl).toContain(
        `/api/v1/apps/live/play-token/show?exp=${signed.data.exp}&sig=`,
      );
      const res = await controller.playToken(
        'live',
        'show',
        String(signed.data.exp),
        signed.data.sig,
      );
      expect(res.data.token).toBe('lk-token');
    });

    it('emits a tokenized /embed widget URL + iframe (app+room scoped, expiring)', () => {
      const { controller } = makeController({ publicPlayback: false });
      const { data } = controller.signPlaybackUrl('live', 'show', {});
      const q = `exp=${data.exp}&sig=${data.sig}`;
      // Player + embed surfaces carry the SAME capability (exp+sig), scoped to
      // this app+room, so a private app can be embedded without a login.
      expect(data.playUrl).toBe(`/play/live/show?${q}`);
      expect(data.embedUrl).toBe(`/embed/live/show?${q}`);
      expect(data.iframe).toContain(`src="/embed/live/show?${q}"`);
      expect(data.iframe).toContain('<iframe');
      // The embed page validates the capability server-side: the URL it carries
      // passes play-token verification.
      expect(() =>
        controller['assertPlaybackAllowed'](
          { features: { publicPlayback: false } } as never,
          'live',
          'show',
          String(data.exp),
          data.sig,
        ),
      ).not.toThrow();
    });

    it('the embed snippet NEVER carries an sk_ token or JWT session', () => {
      const { controller } = makeController({ publicPlayback: false });
      const { data } = controller.signPlaybackUrl('live', 'show', {});
      for (const value of [data.iframe, data.embedUrl, data.playUrl, data.tokenUrl]) {
        expect(value).not.toMatch(/sk_/); // API bearer prefix
        expect(value).not.toMatch(/Bearer/i);
        expect(value).not.toMatch(/eyJ/); // JWT header prefix
      }
      // The only secret material is the short HMAC signature (hex), not a token.
      expect(data.sig).toMatch(/^[0-9a-f]{64}$/);
    });

    it('clamps the requested TTL (default 300, floor 30, cap 86400)', () => {
      const { controller } = makeController();
      const now = Math.floor(Date.now() / 1000);
      expect(controller.signPlaybackUrl('live', 'r', {}).data.ttlSeconds).toBe(300);
      expect(
        controller.signPlaybackUrl('live', 'r', { ttlSeconds: 86_400 }).data
          .ttlSeconds,
      ).toBe(86_400);
      const d = controller.signPlaybackUrl('live', 'r', { ttlSeconds: 60 }).data;
      expect(d.exp).toBeGreaterThanOrEqual(now + 59);
      expect(d.exp).toBeLessThanOrEqual(now + 61);
    });
  });
});
