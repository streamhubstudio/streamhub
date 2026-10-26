/**
 * Unit — cluster EDGE login lock (CLUSTER-ROADMAP §5 step 3).
 *
 * On a node whose role is `edge`, every session-MINT path is refused with 403
 * `cluster_edge_login_disabled`: signup, password login, break-glass admin and
 * magic-link verify. `standalone` and `master` behave normally. Crucially the
 * VALIDATION paths keep working on an edge so already-issued JWTs and `sk_` API
 * tokens are never locked out.
 */
import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { signJwt } from '../../shared/auth';
import { TenancyService } from '../tenancy/tenancy.service';
import { EmailService, type SendResult } from '../email/email.service';
import { NodeRoleService, type NodeRole } from '../cluster/node-role.service';
import { getAppVersion } from '../health/app-version';
import { AuthService } from './auth.service';
import { LoginController } from './login.controller';
import { MagicLinkService } from './magic-link.service';
import { SessionService } from './session.service';
import { TotpService } from './totp.service';

const SECRET = 'test-jwt-secret-do-not-use-in-prod';

interface Harness {
  ctx: UnitContext;
  tenancy: TenancyService;
  auth: AuthService;
  magic: MagicLinkService;
  nodeRole: NodeRoleService;
  lastMagicToken: () => string;
}

function makeHarness(role: NodeRole): Harness {
  const ctx = makeUnitContext({
    ADMIN_USER: 'root',
    ADMIN_PASS: 'break-glass-pass',
    STREAMHUB_JWT_SECRET: SECRET,
    STREAMHUB_ALLOW_SIGNUP: '1',
  });
  const tenancy = ctx.newService(TenancyService, ctx.db, ctx.config);
  tenancy.onModuleInit();
  const totp = ctx.newService(TotpService, ctx.config, tenancy);
  const sessions = ctx.newService(SessionService, ctx.db);
  sessions.onModuleInit();

  const nodeRole = ctx.newService(NodeRoleService, ctx.db, ctx.config);
  nodeRole.setRole(role);

  const sendMagicLink = jest
    .fn<Promise<SendResult>, [string, string]>()
    .mockResolvedValue({ ok: true, messageId: '<id>' });
  const email = { sendMagicLink } as unknown as EmailService;

  const auth = ctx.newService(
    AuthService,
    ctx.db,
    ctx.config,
    tenancy,
    totp,
    sessions,
    undefined, // reputation
    nodeRole,
  );
  const magic = ctx.newService(
    MagicLinkService,
    ctx.db,
    ctx.config,
    tenancy,
    email,
    totp,
    sessions,
    undefined, // reputation
    nodeRole,
  );
  magic.onModuleInit();

  const lastMagicToken = (): string => {
    const url = sendMagicLink.mock.calls.at(-1)?.[1] ?? '';
    return new URL(url).searchParams.get('token') ?? '';
  };

  return { ctx, tenancy, auth, magic, nodeRole, lastMagicToken };
}

function makeReq(token: string): Request {
  const ip = '203.0.113.10';
  return {
    headers: { authorization: `Bearer ${token}` },
    path: '/api/v1/apps',
    url: '/api/v1/apps',
    ip,
    socket: { remoteAddress: ip },
    params: {},
  } as unknown as Request;
}

describe('cluster edge login lock', () => {
  describe.each(['standalone', 'master'] as const)('role=%s (allowed)', (role) => {
    let h: Harness;
    beforeEach(() => (h = makeHarness(role)));
    afterEach(() => h.ctx.cleanup());

    it('signup succeeds', async () => {
      const { token } = await h.auth.signup({
        email: 'a@x.com',
        password: 'passw0rd!',
      });
      expect(token).toBeTruthy();
    });

    it('break-glass login succeeds', async () => {
      const { token } = await h.auth.login('root', 'break-glass-pass');
      expect(token).toBeTruthy();
    });
  });

  describe('role=edge (mint paths refused)', () => {
    let h: Harness;
    beforeEach(() => (h = makeHarness('edge')));
    afterEach(() => h.ctx.cleanup());

    it('signup → 403 cluster_edge_login_disabled (nothing created)', async () => {
      await expect(
        h.auth.signup({ email: 'a@x.com', password: 'passw0rd!' }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        h.auth.signup({ email: 'a@x.com', password: 'passw0rd!' }),
      ).rejects.toThrow('cluster_edge_login_disabled');
      expect(h.tenancy.getUserByEmail('a@x.com')).toBeNull();
    });

    it('password login → 403 (built-in user, before credential check)', async () => {
      // Seed a real user directly (bypassing signup, which is also locked).
      h.tenancy.createUser({ email: 'u@x.com', status: 'active' });
      await expect(h.auth.login('u@x.com', 'whatever')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('break-glass admin login → 403', async () => {
      await expect(h.auth.login('root', 'break-glass-pass')).rejects.toThrow(
        'cluster_edge_login_disabled',
      );
    });

    it('magic-link verify → 403 (mint path)', async () => {
      // The link request itself does not mint a token, so it is allowed; only
      // verify() (which mints a JWT) is refused.
      await h.magic.requestMagicLink('m@x.com', '203.0.113.1');
      const token = h.lastMagicToken();
      expect(token).toBeTruthy();
      await expect(h.magic.verify(token)).rejects.toThrow(
        'cluster_edge_login_disabled',
      );
    });

    it('an ALREADY-ISSUED JWT still validates on an edge', async () => {
      // Mint while standalone, then convert this node to an edge.
      const uid = h.tenancy.createUser({ email: 'live@x.com', status: 'active' });
      h.nodeRole.setRole('standalone');
      // A legacy (no-sid) token is accepted by the grace path.
      const jwt = signJwt({ sub: uid }, SECRET, 3600);
      h.nodeRole.setRole('edge');
      const ctx = await h.auth.validate(makeReq(jwt));
      expect(ctx.scope).toBe('app');
    });

    it('a sk_ API token still validates on an edge', async () => {
      // createToken does not go through the mint choke point.
      const { token } = await h.auth.createToken({
        name: 't',
        scope: 'global',
      });
      const ctx = await h.auth.validate(makeReq(token));
      expect(ctx.scope).toBe('global');
    });

    it('GET /auth/config reports the edge (loginEnabled=false + masterUrl)', () => {
      h.nodeRole.setMasterUrl('https://master.example.com');
      const controller = new LoginController(h.auth, undefined, h.nodeRole);
      expect(controller.config().data).toEqual({
        allowSignup: true,
        nodeRole: 'edge',
        masterUrl: 'https://master.example.com',
        loginEnabled: false,
        appVersion: expect.any(String),
      });
    });
  });
});

describe('GET /auth/config — role fields', () => {
  it('standalone/master → loginEnabled=true', () => {
    for (const role of ['standalone', 'master'] as const) {
      const h = makeHarness(role);
      try {
        const controller = new LoginController(h.auth, undefined, h.nodeRole);
        const data = controller.config().data;
        expect(data.nodeRole).toBe(role);
        expect(data.loginEnabled).toBe(true);
      } finally {
        h.ctx.cleanup();
      }
    }
  });

  it('carries appVersion = the real product version (VERSION file, not 0.1.0)', () => {
    const h = makeHarness('standalone');
    try {
      const controller = new LoginController(h.auth, undefined, h.nodeRole);
      const { appVersion } = controller.config().data;
      expect(appVersion).toBe(getAppVersion());
      expect(appVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(appVersion).not.toBe('0.1.0');
    } finally {
      h.ctx.cleanup();
    }
  });
});
