import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { AuthContext, CurrentAuth } from '../../shared/auth-context';
import { RequirePermission } from '../authz/permission.decorator';
import { UpdateQuotasDto } from './dto/update-quotas.dto';
import { QuotasService, TenantSummary, UsageReport } from './quotas.service';

interface Envelope<T> {
  data: T;
  error: null;
}

/** Tenant quota usage + superadmin tenant administration (wave-5). */
@ApiTags('quotas')
@ApiBearerAuth()
@Controller('tenants')
export class QuotasController {
  constructor(private readonly quotas: QuotasService) {}

  @Get()
  @RequirePermission('tenant', 'read')
  @ApiOperation({
    summary: 'List every tenant + its effective quota (superadmin only).',
  })
  @ApiOkResponse({ description: 'Array of tenants with plan, quotas and app count.' })
  list(@CurrentAuth() ctx?: AuthContext): Envelope<TenantSummary[]> {
    this.requireSuperadmin(ctx);
    return { data: this.quotas.listTenants(), error: null };
  }

  @Get(':id/usage')
  @RequirePermission('usage', 'read')
  @ApiOperation({
    summary: 'Tenant quota usage vs limits (apps, streams, recording, egress).',
  })
  @ApiParam({ name: 'id', description: 'Tenant id (Logto org id).' })
  @ApiOkResponse({ description: 'Usage report with per-metric exceeded flags.' })
  usage(
    @Param('id') id: string,
    @CurrentAuth() ctx?: AuthContext,
  ): Envelope<UsageReport> {
    // Data-scope guard: a non-superadmin may only read its OWN tenant's usage.
    // (New endpoint — always enforced; not subject to the phased flag.)
    if (ctx && !ctx.isSuperadmin && ctx.via !== 'api_token') {
      if (ctx.tenantId && ctx.tenantId !== id) {
        throw new ForbiddenException('cannot read another tenant usage');
      }
    }
    return { data: this.quotas.getUsage(id), error: null };
  }

  @Patch(':id/quotas')
  @RequirePermission('tenant', 'write')
  @ApiOperation({
    summary: "Raise/lower a tenant's plan + quota limits (superadmin only).",
  })
  @ApiParam({ name: 'id', description: 'Tenant id (Logto org id).' })
  @ApiOkResponse({ description: 'The updated tenant with its new effective quota.' })
  updateQuotas(
    @Param('id') id: string,
    @Body() body: UpdateQuotasDto,
    @CurrentAuth() ctx?: AuthContext,
  ): Envelope<TenantSummary> {
    this.requireSuperadmin(ctx);
    return { data: this.quotas.setQuotas(id, body), error: null };
  }

  /**
   * Superadmin-only gate for the tenant-administration surface. Always enforced
   * (not subject to the phased authz flag) so listing/editing every tenant can
   * never leak to a tenant-scoped principal. The break-glass admin and the
   * global `sk_` automation token both resolve to `isSuperadmin` (see
   * auth.service), so both keep access.
   */
  private requireSuperadmin(ctx?: AuthContext): void {
    if (!ctx || !ctx.isSuperadmin) {
      throw new ForbiddenException('superadmin only');
    }
  }
}
