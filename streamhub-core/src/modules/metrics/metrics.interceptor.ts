import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import type { Request, Response } from 'express';

import { MetricsService } from './metrics.service';

/**
 * Global HTTP interceptor feeding the request counter + latency histogram.
 *
 * The route LABEL is the matched Express route pattern (e.g.
 * `/apps/:app/streams/:id`) — never the concrete URL — so path parameters do not
 * blow up label cardinality. Requests that never match a controller route (SPA
 * fallback, 404s) collapse to `unmatched`. Only HTTP contexts are measured; RPC
 * / WS contexts pass through untouched.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const method = req.method;
    const start = process.hrtime.bigint();
    this.metrics.httpStart();

    return next.handle().pipe(
      finalize(() => {
        const durationS =
          Number(process.hrtime.bigint() - start) / 1e9;
        this.metrics.observeHttp(
          method,
          this.routeOf(req),
          res.statusCode,
          durationS,
        );
      }),
    );
  }

  /** Matched route pattern with its base path, or `unmatched`. */
  private routeOf(req: Request): string {
    const routePath = (req.route as { path?: string } | undefined)?.path;
    if (!routePath) return 'unmatched';
    const base = req.baseUrl || '';
    const full = `${base}${routePath}`.replace(/\/+/g, '/');
    return full || routePath;
  }
}
