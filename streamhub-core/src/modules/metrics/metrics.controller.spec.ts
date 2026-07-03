/**
 * Unit — metrics/MetricsController (Fase-0 M8 default-deny).
 *
 * The scrape endpoint is @Public (no Bearer), so METRICS_TOKEN is its only lock.
 * Default-deny: with NO token configured the endpoint 404s (not exposed); with a
 * token it requires a matching Bearer header or `?token=`.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';

import { ConfigService } from '../../shared/config/config.service';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

function makeReq(opts: { authHeader?: string; queryToken?: string } = {}): Request {
  return {
    headers: opts.authHeader ? { authorization: opts.authHeader } : {},
    query: opts.queryToken ? { token: opts.queryToken } : {},
    res: { setHeader: () => undefined },
  } as unknown as Request;
}

function makeController(metricsToken?: string): MetricsController {
  const metrics = {
    contentType: 'text/plain; version=0.0.4',
    scrape: async () => 'streamhub_up 1',
  } as unknown as MetricsService;
  const config = {
    env: (name: string) => (name === 'METRICS_TOKEN' ? metricsToken : undefined),
  } as unknown as ConfigService;
  return new MetricsController(metrics, config);
}

describe('metrics/MetricsController (M8 default-deny)', () => {
  it('404 when METRICS_TOKEN is not set (default-deny, does not expose)', async () => {
    const c = makeController(undefined);
    await expect(c.scrape(makeReq())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('403 when a token is configured but the request omits it', async () => {
    const c = makeController('secret');
    await expect(c.scrape(makeReq())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('403 when the presented token does not match', async () => {
    const c = makeController('secret');
    await expect(
      c.scrape(makeReq({ authHeader: 'Bearer wrong' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('200 with the correct Bearer token → serves metrics', async () => {
    const c = makeController('secret');
    await expect(c.scrape(makeReq({ authHeader: 'Bearer secret' }))).resolves.toBe(
      'streamhub_up 1',
    );
  });

  it('200 with the correct ?token= query param → serves metrics', async () => {
    const c = makeController('secret');
    await expect(c.scrape(makeReq({ queryToken: 'secret' }))).resolves.toBe(
      'streamhub_up 1',
    );
  });
});
