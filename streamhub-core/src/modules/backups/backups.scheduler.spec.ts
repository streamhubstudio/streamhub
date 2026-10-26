/**
 * Unit — backups/BackupsScheduler (daily BullMQ wiring).
 *
 * Runs against the in-memory bullmq fake (jest moduleNameMapper) — a job
 * added while a Worker is registered executes inline, so the suite can assert
 * the scheduled job actually produces snapshots WITHOUT Redis.
 *
 * Invariants locked down:
 *  - onModuleInit registers the daily repeatable job and its execution runs a
 *    full backup (snapshots exist afterwards),
 *  - a stale/empty backup dir also triggers the boot catch-up run,
 *  - STREAMHUB_BACKUPS_ENABLED=false disables the scheduler entirely (no
 *    queue, no snapshots),
 *  - destroy closes queue + worker without throwing.
 */
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { BackupsScheduler } from './backups.scheduler';
import { BackupsService } from './backups.service';

const ENV_KEYS = ['STREAMHUB_BACKUPS_ENABLED', 'STREAMHUB_BACKUP_CRON'];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The fake queue runs processors out-of-band and the backup pipeline does real
 * (temp-dir) file I/O — poll until the condition holds or time out.
 */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return; // let the assertion report
    await sleep(10);
  }
}

/** Let the fake queue's inline (microtask) processors settle. */
const settle = (): Promise<void> => sleep(20);

describe('backups/BackupsScheduler', () => {
  let ctx: UnitContext;
  let service: BackupsService;
  let scheduler: BackupsScheduler;
  const original: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of ENV_KEYS) original[k] = process.env[k];
  });

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    ctx = makeUnitContext();
    ctx.db.global().prepare('INSERT INTO apps (name) VALUES (?)').run('live');
    ctx.db.appDb('live');
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
    service = ctx.newService(BackupsService, ctx.config, ctx.db, ctx.mocks.logs);
    scheduler = ctx.newService(BackupsScheduler, ctx.config, service);
  }

  it('schedules the daily job on init and it produces snapshots for every db', async () => {
    build();
    scheduler.onModuleInit();
    await waitFor(
      () =>
        service.listSnapshots('streamhub').length > 0 &&
        service.listSnapshots('app-live').length > 0,
    );

    // No snapshot existed → catch-up + the (inline-executed) daily add both
    // ran through the SAME processor: at least one snapshot per db.
    expect(service.listSnapshots('streamhub').length).toBeGreaterThanOrEqual(1);
    expect(service.listSnapshots('app-live').length).toBeGreaterThanOrEqual(1);
  });

  it('uses the runBackup pipeline (audit log written with the job name)', async () => {
    build();
    scheduler.onModuleInit();
    await waitFor(() => ctx.mocks.logs.write.mock.calls.length > 0);
    expect(ctx.mocks.logs.write).toHaveBeenCalledWith(
      'info',
      'backups',
      expect.stringMatching(/backup run \((daily|catch-up)\)/),
      expect.any(Object),
    );
  });

  it('is fully disabled with STREAMHUB_BACKUPS_ENABLED=false', async () => {
    process.env.STREAMHUB_BACKUPS_ENABLED = 'false';
    build();
    expect(service.settings.enabled).toBe(false);
    scheduler.onModuleInit();
    await settle();
    expect(service.listSnapshots('streamhub')).toHaveLength(0);
    expect(service.listSnapshots('app-live')).toHaveLength(0);
  });

  it('falls back to the default cron on an invalid STREAMHUB_BACKUP_CRON', () => {
    process.env.STREAMHUB_BACKUP_CRON = 'every day at 3am';
    build();
    expect(service.settings.cron).toBe('30 3 * * *');
    process.env.STREAMHUB_BACKUP_CRON = '0 4 * * 1';
    build();
    expect(service.settings.cron).toBe('0 4 * * 1');
  });

  it('destroy closes queue + worker without throwing', async () => {
    build();
    scheduler.onModuleInit();
    await settle();
    await expect(scheduler.onModuleDestroy()).resolves.toBeUndefined();
  });
});
