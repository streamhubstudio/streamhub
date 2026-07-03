import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { AuthContext, CurrentAuth } from '../../shared/auth-context';
import { TenancyService } from '../tenancy/tenancy.service';
import { QuotasService, UsageReport } from '../quotas/quotas.service';
import { RequirePermission } from '../authz/permission.decorator';
import { TeamMember, TenantRow } from '../tenancy/tenancy.types';
import { InviteMemberDto } from './dto/invite-member.dto';

interface Envelope<T> {
  data: T;
  error: null;
}

interface MyTeam {
  team: TenantRow | null;
  members: TeamMember[];
  usage: UsageReport;
}

/**
 * Simple, self-scoped team surface (Wave-6). A user only ever sees THEIR OWN
 * team — the tenant is taken from the resolved AuthContext, never from a path
 * param, so teams are isolated by construction (the same tenant scoping Casbin
 * and quotas already enforce). One read endpoint + one invite endpoint.
 */
@ApiTags('teams')
@ApiBearerAuth()
@Controller('teams')
export class TeamsController {
  constructor(
    private readonly tenancy: TenancyService,
    private readonly quotas: QuotasService,
  ) {}

  @Get('mine')
  @RequirePermission('usage', 'read')
  @ApiOperation({
    summary: 'My team: tenant, members and quota usage.',
  })
  @ApiOkResponse({
    description: '{ data: { team, members, usage } } for the caller’s tenant.',
  })
  mine(@CurrentAuth() ctx?: AuthContext): Envelope<MyTeam> {
    const tenantId = this.requireTenant(ctx);
    return {
      data: {
        team: this.tenancy.getTenant(tenantId),
        members: this.tenancy.listMembers(tenantId),
        usage: this.quotas.getUsage(tenantId),
      },
      error: null,
    };
  }

  @Post('mine/members')
  @HttpCode(201)
  @RequirePermission('tenant', 'write')
  @ApiOperation({
    summary: 'Invite/attach a member to my team (owner or superadmin only).',
    description:
      'If a user with that email exists they are attached to the team with the ' +
      'given role; otherwise a pending user is created (they set a password by ' +
      'signing up with the same email later). Defaults to role=viewer.',
  })
  @ApiOkResponse({ description: '{ data: member }.' })
  invite(
    @Body() dto: InviteMemberDto,
    @CurrentAuth() ctx?: AuthContext,
  ): Envelope<TeamMember> {
    const tenantId = this.requireTenant(ctx);

    // Invites are sensitive: enforce owner/superadmin here regardless of the
    // phased STREAMHUB_AUTHZ_ENFORCE flag (@RequirePermission only bites in 'on').
    const isOwner = ctx?.isSuperadmin || ctx?.role === 'owner';
    if (!isOwner) {
      throw new ForbiddenException('only a team owner can invite members');
    }

    const email = dto.email.trim().toLowerCase();
    if (!email) throw new BadRequestException('email is required');
    const role = dto.role ?? 'viewer';

    const existing = this.tenancy.getUserByEmail(email);
    const userId = existing
      ? existing.id
      : this.tenancy.createUser({ email, status: 'pending' });
    this.tenancy.addMembership(userId, tenantId, role);

    const member = this.tenancy
      .listMembers(tenantId)
      .find((m) => m.userId === userId);
    if (!member) {
      // Should never happen (we just wrote it) — defensive.
      throw new NotFoundException('member not found after invite');
    }
    return { data: member, error: null };
  }

  /** A team is always the caller's own tenant. Reject unscoped credentials. */
  private requireTenant(ctx?: AuthContext): string {
    if (!ctx || !ctx.tenantId) {
      throw new BadRequestException(
        'no team in context (unscoped credential)',
      );
    }
    return ctx.tenantId;
  }
}
