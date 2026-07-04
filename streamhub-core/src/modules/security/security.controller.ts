import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { AuthContext, CurrentAuth } from '../../shared/auth-context';
import { ConfigService } from '../../shared/config/config.service';
import { IpRule, IpRulesService } from './ip-rules.service';
import {
  BanView,
  IpReputationService,
  OffenderView,
} from './ip-reputation.service';
import {
  resolveSecuritySettings,
  type SecuritySettings,
} from './security-settings';
import { CreateIpRuleDto } from './dto/create-ip-rule.dto';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}

function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

/** GET /security/status payload. */
export interface SecurityStatus {
  mode: SecuritySettings['mode'];
  allowlistOnly: boolean;
  autoban: {
    enabled: boolean;
    maxOffenses: number;
    windowS: number;
    baseTtlS: number;
    track404: boolean;
  };
  counts: {
    rules: number;
    allowRules: number;
    blockRules: number;
    activeBans: number;
    trackedOffenders: number;
  };
}

/**
 * Network-security admin surface (defensive abuse protection). GLOBAL scope
 * only — every endpoint rejects app-scoped principals via the same
 * requireGlobal gate the other superadmin surfaces (/cluster, /system) use.
 */
@ApiTags('security')
@ApiBearerAuth()
@Controller('security')
export class SecurityController {
  private readonly settings: SecuritySettings;

  constructor(
    config: ConfigService,
    private readonly rules: IpRulesService,
    private readonly reputation: IpReputationService,
  ) {
    this.settings = resolveSecuritySettings(config);
  }

  @Get('status')
  @ApiOperation({
    summary:
      'Network-security overview: mode, allowlist-only flag, auto-ban config ' +
      'and rule/ban/offender counts. Global-scope (superadmin) surface.',
  })
  @ApiOkResponse({ description: '{ data: SecurityStatus }' })
  status(@CurrentAuth() ctx?: AuthContext): Envelope<SecurityStatus> {
    this.requireGlobal(ctx);
    const s = this.settings;
    const ruleCounts = this.rules.counts();
    const repCounts = this.reputation.counts();
    return ok({
      mode: s.mode,
      allowlistOnly: s.allowlistOnly,
      autoban: {
        enabled: s.autobanEnabled,
        maxOffenses: s.autobanMaxOffenses,
        windowS: s.autobanWindowS,
        baseTtlS: s.autobanBaseTtlS,
        track404: s.autoban404Enabled,
      },
      counts: {
        rules: ruleCounts.total,
        allowRules: ruleCounts.allow,
        blockRules: ruleCounts.block,
        activeBans: repCounts.activeBans,
        trackedOffenders: repCounts.trackedOffenders,
      },
    });
  }

  @Get('ip-rules')
  @ApiOperation({
    summary: 'List the global IP allow/block rules (newest first).',
  })
  @ApiOkResponse({ description: '{ data: IpRule[] }' })
  listRules(@CurrentAuth() ctx?: AuthContext): Envelope<IpRule[]> {
    this.requireGlobal(ctx);
    return ok(this.rules.list());
  }

  @Post('ip-rules')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Add an allow/block rule (IPv4/IPv6 CIDR or bare IP). 400 on invalid ' +
      'CIDR or duplicate. Takes effect immediately (in-memory cache reload).',
  })
  @ApiOkResponse({ description: '{ data: IpRule } — the created rule.' })
  addRule(
    @Body() dto: CreateIpRuleDto,
    @CurrentAuth() ctx?: AuthContext,
  ): Envelope<IpRule> {
    this.requireGlobal(ctx);
    return ok(
      this.rules.add({
        cidr: dto.cidr,
        action: dto.action,
        note: dto.note ?? null,
        createdBy: ctx?.userId ?? null,
      }),
    );
  }

  @Delete('ip-rules/:id')
  @ApiParam({ name: 'id', description: 'Rule id.' })
  @ApiOperation({ summary: 'Delete a rule. 404 when unknown.' })
  @ApiOkResponse({ description: '{ data: { id, deleted: true } }' })
  @ApiNotFoundResponse({ description: 'Unknown rule.' })
  removeRule(
    @Param('id', ParseIntPipe) id: number,
    @CurrentAuth() ctx?: AuthContext,
  ): Envelope<{ id: number; deleted: true }> {
    this.requireGlobal(ctx);
    this.rules.remove(id);
    return ok({ id, deleted: true as const });
  }

  @Get('bans')
  @ApiOperation({
    summary:
      'Auto-ban state: currently active bans plus recently expired ones ' +
      '(7-day history).',
  })
  @ApiOkResponse({ description: '{ data: { active: Ban[], recent: Ban[] } }' })
  bans(
    @CurrentAuth() ctx?: AuthContext,
  ): Envelope<{ active: BanView[]; recent: BanView[] }> {
    this.requireGlobal(ctx);
    return ok({
      active: this.reputation.activeBans(),
      recent: this.reputation.recentBans(),
    });
  }

  @Post('bans/:ip/unban')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'ip', description: 'The banned IP address.' })
  @ApiOperation({
    summary:
      'Lift a ban immediately (also resets its escalation level). 404 when ' +
      'the IP has no ban record.',
  })
  @ApiOkResponse({ description: '{ data: { ip, unbanned: true } }' })
  @ApiNotFoundResponse({ description: 'IP has no ban record.' })
  unban(
    @Param('ip') ip: string,
    @CurrentAuth() ctx?: AuthContext,
  ): Envelope<{ ip: string; unbanned: true }> {
    this.requireGlobal(ctx);
    if (!this.reputation.unban(ip)) {
      throw new NotFoundException(`no ban record for ${ip}`);
    }
    return ok({ ip, unbanned: true as const });
  }

  @Get('offenses')
  @ApiOperation({
    summary:
      'Recent offenders inside the sliding window: per-IP offense counts and ' +
      'kind breakdown (heaviest first).',
  })
  @ApiOkResponse({ description: '{ data: Offender[] }' })
  offenses(@CurrentAuth() ctx?: AuthContext): Envelope<OffenderView[]> {
    this.requireGlobal(ctx);
    return ok(this.reputation.offenders());
  }

  /** Reject app-scoped principals from the global surface (no-op in dev). */
  private requireGlobal(ctx?: AuthContext): void {
    if (ctx && !ctx.isSuperadmin && ctx.scope !== 'global') {
      throw new ForbiddenException(
        'this endpoint requires a global-scope credential',
      );
    }
  }
}
