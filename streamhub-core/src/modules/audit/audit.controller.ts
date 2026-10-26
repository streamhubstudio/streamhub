import { Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { AuthContext, CurrentAuth } from '../../shared/auth-context';
import {
  AuditChainReport,
  AuditEntry,
  AuditResult,
  AuditService,
} from './audit.service';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}

function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

const RESULTS: ReadonlySet<string> = new Set(['success', 'failure', 'deny']);

/**
 * Security audit trail read API (ISO 27002 §8.15/§8.16). GLOBAL scope only —
 * the trail spans tenants, so app-scoped principals are rejected via the same
 * requireGlobal gate the other superadmin surfaces (/system, /security) use.
 * Read-only by design: the trail is append-only and has NO write/delete API.
 */
@ApiTags('system')
@ApiBearerAuth()
@Controller('system')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get('audit')
  @ApiOperation({
    summary:
      'Query the append-only security audit trail (newest first). ' +
      'Filters: action prefix, exact actor id, result, from/to ISO dates. ' +
      'Global-scope (superadmin) surface.',
  })
  @ApiQuery({ name: 'action', required: false, description: 'Action prefix, e.g. auth.' })
  @ApiQuery({ name: 'actor', required: false, description: 'Exact actor id.' })
  @ApiQuery({ name: 'result', required: false, enum: ['success', 'failure', 'deny'] })
  @ApiQuery({ name: 'from', required: false, description: 'ISO lower bound (inclusive).' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO upper bound (inclusive).' })
  @ApiQuery({ name: 'limit', required: false, description: 'Page size (default 50, max 500).' })
  @ApiQuery({ name: 'offset', required: false, description: 'Page offset (default 0).' })
  @ApiOkResponse({
    description: '{ data: { entries: AuditEntry[], total, limit, offset } }',
  })
  list(
    @Query('action') action?: string,
    @Query('actor') actor?: string,
    @Query('result') result?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @CurrentAuth() ctx?: AuthContext,
  ): Envelope<{
    entries: AuditEntry[];
    total: number;
    limit: number;
    offset: number;
  }> {
    this.requireGlobal(ctx);
    return ok(
      this.audit.query({
        action: action?.trim() || undefined,
        actor: actor?.trim() || undefined,
        result: RESULTS.has(result ?? '') ? (result as AuditResult) : undefined,
        from: from?.trim() || undefined,
        to: to?.trim() || undefined,
        limit: this.int(limit),
        offset: this.int(offset),
      }),
    );
  }

  @Get('audit/verify')
  @ApiOperation({
    summary:
      'Verify the audit-trail hash chain (tamper evidence). Returns ' +
      '{ ok, checked, brokenAt } over the most recent entries.',
  })
  @ApiOkResponse({ description: '{ data: { ok, checked, brokenAt } }' })
  verify(@CurrentAuth() ctx?: AuthContext): Envelope<AuditChainReport> {
    this.requireGlobal(ctx);
    return ok(this.audit.verifyChain());
  }

  private int(raw?: string): number | undefined {
    if (raw === undefined || raw.trim() === '') return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isNaN(n) ? undefined : n;
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
