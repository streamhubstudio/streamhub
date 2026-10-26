/**
 * Unit — metrics-history/MetricsHistoryScheduler (hourly BullMQ wiring).
 *
 * Runs against the in-memory bullmq fake (jest moduleNameMapper) — a job added
 * while a Worker is registered executes inline, so the suite asserts the
 * scheduled job actually samples the host WITHOUT Redis. Invariants:
 *  - onModuleInit registers the hourly repeatable job and its execution writes
 *    a sample row (an empty table always triggers the boot catch-up too),
 *  - STREAMHUB_METRICS_HISTORY_ENABLED=false disables the scheduler entirely
 *    (no queue, no samples),
 *  - an invalid cron falls back to the hourly default,
 *  - destroy closes queue + worker without throwing.
 */
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { MetricsHistoryScheduler } from './metrics-history.scheduler';
import { MetricsHistoryService } from './metrics-history.service';

const ENV_KEYS = [
  'STREAMHUB_METRICS_HISTORY_ENABLED',
  'STREAMHUB_METRICS_HISTORY_CRON',
];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return;
    await sleep(10);
  }
}

const settle = (): Promise<void> => sleep(20);

describe('metrics-history/MetricsHistoryScheduler', () => {
  let ctx: UnitContext;
  let service: MetricsHistoryService;
  let scheduler: MetricsHistoryScheduler;
  const original: Record<string, string | undefined> = {};

  function sampleCount(): number {
    return (
      ctx.db
        .global()
        .prepare('SELECT COUNT(*) AS n FROM resource_samples')
        .get() as { n: number }
    ).n;
  }

  beforeAll(() => {
    for (const k of ENV_KEYS) original[k] = process.env[k];
  });

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    ctx = makeUnitContext();
  });

  afterEach(async () => {
    await scheduler?.onModuleDestroy();
    ctx.cleanup();
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  function build(): void {
    service = ctx.newService(MetricsHistoryService, ctx.config, ctx.db);
    service.onModuleInit();
    scheduler = ctx.newService(MetricsHistoryScheduler, ctx.config, service);
  }

  it('schedules the hourly job on init and it writes a sample', async () => {
    build();
    scheduler.onModuleInit();
    await waitFor(() => sampleCount() > 0);
    expect(sampleCount()).toBeGreaterThanOrEqual(1);
  });

  it('is fully disabled with STREAMHUB_METRICS_HISTORY_ENABLED=false', async () => {
    process.env.STREAMHUB_METRICS_HISTORY_ENABLED = 'false';
    build();
    expect(service.settings.enabled).toBe(false);
    scheduler.onModuleInit();
    await settle();
    expect(sampleCount()).toBe(0);
  });

  it('falls back to the default cron on an invalid pattern', () => {
    process.env.STREAMHUB_METRICS_HISTORY_CRON = 'every hour please';
    build();
    expect(service.settings.cron).toBe('0 * * * *');
    process.env.STREAMHUB_METRICS_HISTORY_CRON = '15 * * * *';
    build();
    expect(service.settings.cron).toBe('15 * * * *');
  });

  it('destroy closes queue + worker without throwing', async () => {
    build();
    scheduler.onModuleInit();
    await settle();
    await expect(scheduler.onModuleDestroy()).resolves.toBeUndefined();
  });
});
