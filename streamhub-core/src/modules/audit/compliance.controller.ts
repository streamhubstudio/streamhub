import { Controller, ForbiddenException, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { AuthContext, CurrentAuth } from '../../shared/auth-context';
import { ComplianceReport, ComplianceService } from './compliance.service';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}

function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

/**
 * Read-only compliance posture surface. Reports which ISO 27002 §8
 * technological controls are ACTIVE on this deployment (live evidence for an
 * auditor / the "is this tuning applied?" panel). Global scope only.
 */
@ApiTags('system')
@ApiBearerAuth()
@Controller('system')
export class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  @Get('compliance')
  @ApiOperation({
    summary:
      'Security/compliance posture: each product control → live state → the ' +
      'ISO 27002:2022 §8 control it maps to. Read-only, global-scope ' +
      '(superadmin) surface. No secrets in the output.',
  })
  @ApiOkResponse({
    description: '{ data: { checkedAt, summary, controls: ComplianceControl[] } }',
  })
  report(@CurrentAuth() ctx?: AuthContext): Envelope<ComplianceReport> {
    this.requireGlobal(ctx);
    return ok(this.compliance.report());
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
