/**
 * Unit — edge/EdgeWatchdogService. Liveness flips fire the notifier seam
 * (online↔offline, baseline silent) and a node WS-down past the grace triggers
 * scheduler failover. Gateway + scheduler + notifier are fakes; the DB is real.
 */
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { EdgeGateway } from './edge.gateway';
import { EdgeSchedulerService } from './edge-scheduler.service';
import { EdgeWatchdogService, FAILOVER_GRACE_MS } from './edge-watchdog.service';
import type { EdgeNotifier } from './edge-notifier';

function insertNode(ctx: UnitContext, id: string, ageSeconds: number): void {
  ctx.db
    .global()
    .prepare(
      "INSERT INTO nodes (id, name, type, status, last_seen_at) " +
        "VALUES (?, ?, 'edge', 'active', datetime('now', ?))",
    )
    .run(id, id, `-${ageSeconds} seconds`);
}

describe('edge/EdgeWatchdogService', () => {
  let ctx: UnitContext;
  let connected: boolean;
  let downSince: number | null;
  let gateway: Pick<EdgeGateway, 'isConnected' | 'disconnectedSince'>;
  let scheduler: { handleNodeDown: jest.Mock };
  let notifier: { notify: jest.Mock };
  let wd: EdgeWatchdogService;

  beforeEach(() => {
    ctx = makeUnitContext();
    connected = true;
    downSince = null;
    gateway = {
      isConnected: jest.fn(() => connected),
      disconnectedSince: jest.fn(() => downSince),
    };
    scheduler = { handleNodeDown: jest.fn() };
    notifier = { notify: jest.fn().mockResolvedValue(undefined) };
    wd = new EdgeWatchdogService(
      ctx.db,
      gateway as unknown as EdgeGateway,
      scheduler as unknown as EdgeSchedulerService,
      notifier as unknown as EdgeNotifier,
    );
  });
  afterEach(() => ctx.cleanup());

  it('seeds the baseline silently, then fires node.offline / node.online on flips', async () => {
    insertNode(ctx, 'n1', 5); // fresh + connected → online

    await wd.tick(); // baseline online — no notify
    expect(notifier.notify).not.toHaveBeenCalled();

    // Drop the WS and age the last heartbeat past the stale window → offline.
    connected = false;
    downSince = Date.now();
    ctx.db
      .global()
      .prepare("UPDATE nodes SET last_seen_at = datetime('now', '-200 seconds') WHERE id = 'n1'")
      .run();
    await wd.tick();
    expect(notifier.notify).toHaveBeenCalledWith(
      'node.offline',
      expect.objectContaining({ nodeId: 'n1' }),
    );

    // Reconnect → online again.
    notifier.notify.mockClear();
    connected = true;
    await wd.tick();
    expect(notifier.notify).toHaveBeenCalledWith(
      'node.online',
      expect.objectContaining({ nodeId: 'n1' }),
    );
  });

  it('does NOT flip while the HTTP heartbeat keeps a WS-less node fresh', async () => {
    insertNode(ctx, 'n1', 5);
    connected = false; // never on WS, but heartbeat is fresh → still online
    await wd.tick(); // baseline online
    await wd.tick();
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('fails a node over once it has been WS-down past the grace', async () => {
    insertNode(ctx, 'n1', 5);
    connected = false;
    downSince = Date.now() - (FAILOVER_GRACE_MS + 1000);
    await wd.tick();
    expect(scheduler.handleNodeDown).toHaveBeenCalledWith('n1');
  });

  it('does NOT fail over inside the grace window', async () => {
    insertNode(ctx, 'n1', 5);
    connected = false;
    downSince = Date.now() - 1000; // 1s < 45s grace
    await wd.tick();
    expect(scheduler.handleNodeDown).not.toHaveBeenCalled();
  });
});
