import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { AuthContext, CurrentAuth } from '../../shared/auth-context';
import { ConfigService } from '../../shared/config/config.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { MembershipRole } from '../tenancy/tenancy.types';
import { RequirePermission } from '../authz/permission.decorator';
import { EmailService } from '../email/email.service';
import { MagicLinkService } from './magic-link.service';
import { InviteMemberDto } from './dto/invite-member.dto';

interface Envelope<T> {
  data: T;
  error: null;
}

/** A pending invitation (a PENDING user + membership in the caller's tenant). */
export interface PendingInvite {
  userId: string;
  email: string | null;
  role: MembershipRole;
  invitedAt: string;
}

/** Result of POST /tenant/invites. */
export interface InviteResult extends PendingInvite {
  /** Whether the invite email was actually dispatched (SMTP may be off). */
  emailSent: boolean;
}

/**
 * Email invitations to MY tenant (cuenta y auth). Like TeamsController, the
 * tenant always comes from the resolved AuthContext — never a path param — so
 * an owner can only ever invite into their own team. Owner/superadmin only
 * (enforced here regardless of the phased STREAMHUB_AUTHZ_ENFORCE flag).
 *
 * Flow: POST creates a PENDING user (or attaches an existing one) with the
 * requested role and emails a single-use invite link (a 72h magic-link token —
 * MagicLinkService kind='invite'). The invitee clicks → /auth/magic verifies →
 * their pending user is promoted to active with the membership already in
 * place; they may later set a password via signup (invite completion) or the
 * reset flow. DELETE revokes: membership removed, outstanding invite links
 * invalidated, and the user row deleted when it was a never-accepted orphan.
 */
@ApiTags('teams')
@ApiBearerAuth()
@Controller('tenant/invites')
export class TenantInvitesController {
  constructor(
    private readonly config: ConfigService,
    private readonly tenancy: TenancyService,
    private readonly magic: MagicLinkService,
    private readonly email: EmailService,
  ) {}

  @Get()
  @RequirePermission('tenant', 'read')
  @ApiOperation({
    summary: 'Pending invitations of my tenant (owner/superadmin only).',
  })
  @ApiOkResponse({ description: '{ data: PendingInvite[] }.' })
  list(@CurrentAuth() ctx?: AuthContext): Envelope<PendingInvite[]> {
    const tenantId = this.requireOwner(ctx);
    const pending = this.tenancy
      .listMembers(tenantId)
      .filter((m) => m.status === 'pending')
      .map((m) => ({
        userId: m.userId,
        email: m.email,
        role: m.role,
        invitedAt: m.createdAt,
      }));
    return { data: pending, error: null };
  }

  @Post()
  @HttpCode(201)
  @RequirePermission('tenant', 'write')
  @ApiOperation({
    summary: 'Invite a user by email to my tenant (owner/superadmin only).',
    description:
      'Creates a PENDING user (or attaches an existing account) with the given ' +
      "role (defaults 'viewer') and emails a single-use 72h invite link. " +
      'Works even when public signup is disabled — invites are the invite-only ' +
      'door into the platform.',
  })
  @ApiOkResponse({ description: '{ data: InviteResult }.' })
  async invite(
    @Body() dto: InviteMemberDto,
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<Envelope<InviteResult>> {
    const tenantId = this.requireOwner(ctx);

    const email = dto.email.trim().toLowerCase();
    if (!email) throw new BadRequestException('email is required');
    const adminUser = this.config.adminUser;
    if (adminUser && email === adminUser.trim().toLowerCase()) {
      throw new BadRequestException('cannot invite the break-glass admin');
    }
    const role = dto.role ?? 'viewer';

    const existing = this.tenancy.getUserByEmail(email);
    if (existing && this.tenancy.roleInTenant(existing.id, tenantId)) {
      throw new BadRequestException('that email is already a member');
    }
    const userId = existing
      ? existing.id
      : this.tenancy.createUser({ email, status: 'pending' });
    this.tenancy.addMembership(userId, tenantId, role);

    // Invite email: a 72h single-use magic link (verify promotes the pending
    // user to active). SMTP failures don't roll back the membership — the
    // caller sees emailSent:false and can revoke or re-invite.
    const url = this.magic.issueInviteLink(email);
    const team = this.tenancy.getTenant(tenantId);
    const sent = await this.email.sendInvite(email, url, {
      teamName: team?.name,
      role,
      invitedBy: ctx?.email,
    });

    const member = this.tenancy
      .listMembers(tenantId)
      .find((m) => m.userId === userId);
    if (!member) {
      throw new NotFoundException('member not found after invite');
    }
    return {
      data: {
        userId: member.userId,
        email: member.email,
        role: member.role,
        invitedAt: member.createdAt,
        emailSent: sent.ok,
      },
      error: null,
    };
  }

  @Delete(':userId')
  @HttpCode(204)
  @RequirePermission('tenant', 'write')
  @ApiOperation({
    summary: 'Revoke a pending invitation (owner/superadmin only).',
    description:
      'Removes the pending membership and invalidates any outstanding invite ' +
      'links. The user row is deleted too when it was created by the invite ' +
      'and never accepted anywhere else.',
  })
  @ApiParam({ name: 'userId', description: 'The invited (pending) user id.' })
  revoke(
    @Param('userId') userId: string,
    @CurrentAuth() ctx?: AuthContext,
  ): void {
    const tenantId = this.requireOwner(ctx);

    const member = this.tenancy
      .listMembers(tenantId)
      .find((m) => m.userId === userId);
    if (!member) {
      throw new NotFoundException('no such invitation in your tenant');
    }
    if (member.status !== 'pending') {
      throw new BadRequestException(
        'that user already accepted — not a pending invitation',
      );
    }

    this.tenancy.removeMembership(userId, tenantId);
    if (member.email) this.magic.revokeInviteLinks(member.email);
    // Orphan cleanup: an invite-born user with no other team and no password
    // never signed in anywhere — remove the row entirely.
    const user = this.tenancy.getUser(userId);
    if (
      user &&
      user.status === 'pending' &&
      !user.password_hash &&
      this.tenancy.membershipCount(userId) === 0
    ) {
      this.tenancy.deleteUser(userId);
    }
  }

  /**
   * Invitations are sensitive: enforce owner/superadmin + a tenant-scoped
   * credential here regardless of the phased authz flag. Returns the tenant id.
   */
  private requireOwner(ctx?: AuthContext): string {
    if (!ctx || !ctx.tenantId) {
      throw new BadRequestException('no team in context (unscoped credential)');
    }
    if (!(ctx.isSuperadmin || ctx.role === 'owner')) {
      throw new ForbiddenException('only a team owner can manage invitations');
    }
    return ctx.tenantId;
  }
}
