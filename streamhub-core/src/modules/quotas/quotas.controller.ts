import {
  Controller,
  ForbiddenException,
  Get,
  Param,
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
import { QuotasService, UsageReport } from './quotas.service';

interface Envelope<T> {
  data: T;
  error: null;
}

/** Tenant quota usage (wave-5). */
@ApiTags('quotas')
@ApiBearerAuth()
@Controller('tenants')
export class QuotasController {
  constructor(private readonly quotas: QuotasService) {}

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
}
