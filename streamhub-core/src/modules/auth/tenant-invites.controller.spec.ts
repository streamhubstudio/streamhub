/**
 * Unit — auth/TenantInvitesController (email invitations to MY tenant).
 *
 * Real migrated SQLite DB + real TenancyService/MagicLinkService; EmailService
 * is a capturing fake (no SMTP). Exercises:
 *   - invite: creates a PENDING user + membership in the CALLER's tenant, sends
 *     the invite email (72h magic link), owner/superadmin-only (403 otherwise),
 *     duplicate member rejected, break-glass admin email rejected,
 *   - accept: the emailed link verifies into a session and promotes the invitee,
 *   - list: pending invitations only,
 *   - revoke: membership + orphan user removed, outstanding links invalidated.
 */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { AuthContext } from '../../shared/auth-context';
import { TenancyService } from '../tenancy/tenancy.service';
import { EmailService, type SendResult } from '../email/email.service';
import { MagicLinkService } from './magic-link.service';
import { SessionService } from './session.service';
import { TenantInvitesController } from './tenant-invites.controller';
import { TotpService } from './totp.service';

const SECRET = 'test-jwt-secret-do-not-use-in-prod';

interface Harness {
  ctx: UnitContext;
  tenancy: TenancyService;
  magic: MagicLinkService;
  controller: TenantInvitesController;
  sendInvite: jest.Mock<Promise<SendResult>, [string, string, unknown]>;
  /** Owner ctx over a fresh team. */
  owner: AuthContext;
  /** Extract ?token= from the last invite email URL. */
  lastToken: () => string;
}

function makeInvites(overrides: Record<string, string> = {}): Harness {
  const ctx = makeUnitContext({
    ADMIN_USER: '',
    ADMIN_PASS: '',
    STREAMHUB_JWT_SECRET: SECRET,
    ...overrides,
  });
  const tenancy = ctx.newService(TenancyService, ctx.db, ctx.config);
  tenancy.onModuleInit();
  const totp = ctx.newService(TotpService, ctx.config, tenancy);

  const sendInvite = jest
    .fn<Promise<SendResult>, [string, string, unknown]>()
    .mockResolvedValue({ ok: true, messageId: '<id>' });
  const email = { sendInvite } as unknown as EmailService;

  const sessions = ctx.newService(SessionService, ctx.db);
  sessions.onModuleInit();
  const magic = ctx.newService(
    MagicLinkService,
    ctx.db,
    ctx.config,
    tenancy,
    email,
    totp,
    sessions,
  );
  magic.onModuleInit();

  const controller = ctx.newService(
    TenantInvitesController,
    ctx.config,
    tenancy,
    magic,
    email,
  );

  // Seed the inviting owner + their team.
  const ownerId = tenancy.createUser({ email: 'owner@x.com', status: 'active' });
  const tenantId = tenancy.createTeam('Acme');
  tenancy.addMembership(ownerId, tenantId, 'owner');
  const owner: AuthContext = {
    userId: ownerId,
    tenantId,
    role: 'owner',
    isSuperadmin: false,
    scope: 'user',
    via: 'user_jwt',
    email: 'owner@x.com',
  };

  const lastToken = (): string => {
    const url = (sendInvite.mock.calls.at(-1)?.[1] as string) ?? '';
    return new URL(url).searchParams.get('token') ?? '';
  };

  return { ctx, tenancy, magic, controller, sendInvite, owner, lastToken };
}

function roleCtx(h: Harness, role: 'editor' | 'viewer'): AuthContext {
  return { ...h.owner, userId: `usr_${role}`, role };
}

describe('auth/TenantInvitesController', () => {
  let h: Harness;
  beforeEach(() => (h = makeInvites()));
  afterEach(() => h.ctx.cleanup());

  // ===========================================================================
  // invite (POST /tenant/invites)
  // ===========================================================================
  it('creates a PENDING user + membership in MY tenant and emails the invite link', async () => {
    const res = await h.controller.invite(
      { email: 'New.Member@X.com', role: 'editor' },
      h.owner,
    );

    expect(res.data).toMatchObject({
      email: 'new.member@x.com',
      role: 'editor',
      emailSent: true,
    });

    const user = h.tenancy.getUserByEmail('new.member@x.com')!;
    expect(user.status).toBe('pending');
    expect(user.password_hash).toBeNull();
    expect(h.tenancy.roleInTenant(user.id, h.owner.tenantId!)).toBe('editor');

    // The email carried a magic link pointing at the public app.
    expect(h.sendInvite).toHaveBeenCalledTimes(1);
    const [to, url, opts] = h.sendInvite.mock.calls[0];
    expect(to).toBe('new.member@x.com');
    expect(url).toContain('/auth/magic?token=');
    expect(opts).toMatchObject({ teamName: 'Acme', role: 'editor' });
  });

  it('defaults the role to viewer', async () => {
    const res = await h.controller.invite({ email: 'v@x.com' }, h.owner);
    expect(res.data.role).toBe('viewer');
  });

  it('is OWNER-only: editor/viewer get 403, unscoped credentials 400', async () => {
    await expect(
      h.controller.invite({ email: 'a@x.com' }, roleCtx(h, 'editor')),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      h.controller.invite({ email: 'a@x.com' }, roleCtx(h, 'viewer')),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      h.controller.invite({ email: 'a@x.com' }, { ...h.owner, tenantId: null }),
    ).rejects.toThrow(BadRequestException);
    expect(h.sendInvite).not.toHaveBeenCalled();
  });

  it('rejects inviting an existing member / the break-glass admin email', async () => {
    await h.controller.invite({ email: 'dup@x.com' }, h.owner);
    await expect(
      h.controller.invite({ email: 'dup@x.com' }, h.owner),
    ).rejects.toThrow(BadRequestException);

    const h2 = makeInvites({ ADMIN_USER: 'root@corp.com', ADMIN_PASS: 'pw' });
    try {
      await expect(
        h2.controller.invite({ email: 'root@corp.com' }, h2.owner),
      ).rejects.toThrow(BadRequestException);
    } finally {
      h2.ctx.cleanup();
    }
  });

  it('the emailed invite link ACCEPTS into a session (pending → active, role kept)', async () => {
    await h.controller.invite({ email: 'joiner@x.com', role: 'editor' }, h.owner);
    const token = h.lastToken();
    expect(token.length).toBeGreaterThan(20);

    const { token: jwt } = await h.magic.verify(token);
    expect(jwt).toMatch(/\..+\./);

    const user = h.tenancy.getUserByEmail('joiner@x.com')!;
    expect(user.status).toBe('active');
    expect(h.tenancy.primaryMembership(user.id)).toEqual({
      tenantId: h.owner.tenantId,
      role: 'editor',
    });
  });

  // ===========================================================================
  // list (GET /tenant/invites)
  // ===========================================================================
  it('lists only PENDING invitations of my tenant', async () => {
    await h.controller.invite({ email: 'p1@x.com' }, h.owner);
    await h.controller.invite({ email: 'p2@x.com', role: 'editor' }, h.owner);
    // p2 accepts → drops off the pending list.
    await h.magic.verify(h.lastToken());

    const res = h.controller.list(h.owner);
    expect(res.data.map((i) => i.email)).toEqual(['p1@x.com']);
    expect(res.data[0]).toMatchObject({ role: 'viewer' });
  });

  // ===========================================================================
  // revoke (DELETE /tenant/invites/:userId)
  // ===========================================================================
  it('revokes: removes the membership, deletes the orphan user, kills the link', async () => {
    await h.controller.invite({ email: 'gone@x.com' }, h.owner);
    const invited = h.tenancy.getUserByEmail('gone@x.com')!;
    const token = h.lastToken();

    h.controller.revoke(invited.id, h.owner);

    // Membership + orphan user row gone.
    expect(h.tenancy.roleInTenant(invited.id, h.owner.tenantId!)).toBeNull();
    expect(h.tenancy.getUser(invited.id)).toBeNull();
    // The emailed link no longer works.
    await expect(h.magic.verify(token)).rejects.toBeDefined();
  });

  it('revoke refuses non-members and already-accepted invites', async () => {
    expect(() => h.controller.revoke('usr_nobody', h.owner)).toThrow(
      NotFoundException,
    );

    await h.controller.invite({ email: 'done@x.com' }, h.owner);
    await h.magic.verify(h.lastToken()); // accepted
    const user = h.tenancy.getUserByEmail('done@x.com')!;
    expect(() => h.controller.revoke(user.id, h.owner)).toThrow(
      BadRequestException,
    );
  });

  it('revoke is OWNER-only', async () => {
    await h.controller.invite({ email: 'x@x.com' }, h.owner);
    const user = h.tenancy.getUserByEmail('x@x.com')!;
    expect(() => h.controller.revoke(user.id, roleCtx(h, 'editor'))).toThrow(
      ForbiddenException,
    );
  });
});
