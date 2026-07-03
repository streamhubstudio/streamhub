import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  NotFoundException,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../../shared/auth/public.decorator';
import { ConfigService } from '../../shared/config/config.service';
import { MetricsService } from './metrics.service';

/**
 * Prometheus scrape endpoint.
 *
 * Mounted at the ROOT path `/metrics` (excluded from the `api/v1` global prefix
 * in main.ts) to match the ecosystem convention Prometheus/Grafana expect.
 * `@Public()` bypasses the Bearer auth guard so a scraper needs no app token.
 *
 * Fase-0 M8 (default-deny): the endpoint is DISABLED unless `METRICS_TOKEN` is
 * set. Without a token `/metrics` returns 404 (it does not even reveal it
 * exists), so a fresh install never leaks internal metrics publicly. With a
 * token, a matching `Bearer <token>` header (or `?token=`) is required.
 */
@ApiExcludeController()
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-cache, no-store, must-revalidate')
  async scrape(@Req() req: Request): Promise<string> {
    this.assertAuthorized(req);
    // The controller sets the exposition content-type explicitly so Prometheus
    // parses it (text/plain; version=0.0.4).
    req.res?.setHeader('Content-Type', this.metrics.contentType);
    return this.metrics.scrape();
  }

  private assertAuthorized(req: Request): void {
    const token = this.config.env('METRICS_TOKEN');
    // Default-deny (M8): no token configured → the endpoint is not enabled. 404
    // rather than 403 so its existence isn't confirmed to an anonymous scanner.
    if (!token) {
      throw new NotFoundException();
    }
    const auth = req.headers.authorization ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const query =
      typeof req.query?.token === 'string' ? req.query.token : '';
    if (bearer !== token && query !== token) {
      throw new ForbiddenException('invalid metrics token');
    }
  }
}
