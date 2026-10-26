import {
  Controller,
  ForbiddenException,
  Get,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { AuthContext, CurrentAuth } from '../../shared/auth-context';
import {
  DEFAULT_RANGE,
  MetricKey,
  MetricsHistoryResponse,
  MetricsHistoryService,
} from './metrics-history.service';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}

function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

const VALID_METRICS: readonly MetricKey[] = ['cpu', 'mem', 'disk', 'net'];

/**
 * In-app host resource-usage history (CPU / RAM / Disk / Network sampled hourly,
 * 30-day retention). GLOBAL scope only — gated by the SAME `requireGlobal` rule
 * as /system/settings and /system/backups (superadmin surface). Complementary
 * to the Prometheus `/metrics` scrape endpoint, which is the heavyweight path.
 */
@ApiTags('system')
@ApiBearerAuth()
@Controller('system/metrics')
export class MetricsHistoryController {
  constructor(private readonly history: MetricsHistoryService) {}

  @Get('history')
  @ApiOperation({
    summary:
      'Time-bucketed host resource-usage history (CPU / RAM / Disk / Network) ' +
      'at 1-hour precision for a dot chart. Global-scope (superadmin) surface. ' +
      'Pass ?metric=cpu|mem|disk|net to narrow to one series (default: all); ' +
      '?range=24h|7d|30d|90d (default 30d).',
  })
  @ApiQuery({ name: 'range', required: false, enum: ['24h', '7d', '30d', '90d'] })
  @ApiQuery({ name: 'metric', required: false, enum: VALID_METRICS })
  @ApiOkResponse({ description: '{ data: MetricsHistoryResponse }' })
  get(
    @Query('range') range?: string,
    @Query('metric') metric?: string,
    @CurrentAuth() ctx?: AuthContext,
  ): Envelope<MetricsHistoryResponse> {
    this.requireGlobal(ctx);
    const m = (VALID_METRICS as readonly string[]).includes(metric ?? '')
      ? (metric as MetricKey)
      : undefined;
    return ok(this.history.history(range || DEFAULT_RANGE, m));
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
