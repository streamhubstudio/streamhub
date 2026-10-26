/**
 * Unit specs for EdgeAppController — the app-scoped edge assignments API.
 *
 * Covers the validation gate (plugin must be installed AND edge-capable), the
 * 404s (unknown app / unknown assignment / cross-app revoke) and the happy path
 * (schedule via the scheduler, list this app's assignments). Scheduler + repo are
 * jest mocks; the registry + install repo are real (temp DB).
 */
import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import * as path from 'path';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { AppPluginsRepository } from '../plugins/app-plugins.repository';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import { EdgeAppController } from './edge-app.controller';
import type { EdgeAssignment } from './edge.types';

const APP = 'live';

function fakeAssignment(over: Partial<EdgeAssignment> = {}): EdgeAssignment {
  return {
    id: 'x1',
    nodeId: 'n1',
    app: APP,
    pluginId: 'refapp',
    streamId: 'gate',
    config: {},
    status: 'offered',
    detail: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

// The edge-capability gate is exercised with synthetic FIXTURE apps (never a
// real shipping app, which may decouple): `refapp` (edge-capable) and `reftool`
// (a worker app WITHOUT worker.edge).
const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', '..', 'test', 'fixtures', 'plugins');

describe('EdgeAppController', () => {
  let ctx: UnitContext;
  let installs: AppPluginsRepository;
  let scheduler: { schedule: jest.Mock; revoke: jest.Mock };
  let assignments: { list: jest.Mock; get: jest.Mock };
  let ctrl: EdgeAppController;
  const prevFixtureRoot = process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT;

  beforeAll(() => {
    process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT = FIXTURE_ROOT;
  });
  afterAll(() => {
    if (prevFixtureRoot === undefined) delete process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT;
    else process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT = prevFixtureRoot;
  });

  beforeEach(() => {
    ctx = makeUnitContext();
    ctx.mocks.apps.get.mockResolvedValue({ id: 1, name: APP } as never);
    installs = new AppPluginsRepository(ctx.db);
    installs.install(APP, 'refapp', { room: 'gate' }, true); // edge-capable (fixture)
    installs.install(APP, 'reftool', {}, true); // local-only worker (non-edge fixture)

    scheduler = { schedule: jest.fn(() => fakeAssignment()), revoke: jest.fn(() => fakeAssignment({ status: 'revoked' })) };
    assignments = { list: jest.fn(() => [fakeAssignment()]), get: jest.fn(() => fakeAssignment()) };
    const registry = new PluginRegistryService();
    registry.discover();

    ctrl = new EdgeAppController(
      scheduler as never,
      assignments as never,
      registry,
      installs,
      ctx.mocks.apps,
    );
  });

  afterEach(() => ctx.cleanup());

  it('schedules an installed, edge-capable plugin', async () => {
    const res = await ctrl.create(APP, { pluginId: 'refapp', streamId: 'gate' });
    expect(res.data.pluginId).toBe('refapp');
    expect(scheduler.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ app: APP, pluginId: 'refapp', streamId: 'gate' }),
    );
  });

  it('rejects a plugin that is not edge-capable', async () => {
    // `reftool` is installed above but has no worker.edge → not edge-capable.
    await expect(
      ctrl.create(APP, { pluginId: 'reftool' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('rejects an edge-capable plugin that is not installed', async () => {
    // Uninstall the edge-capable fixture first — the gate must reject it.
    installs.remove(APP, 'refapp');
    await expect(ctrl.create(APP, { pluginId: 'refapp' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('404s an unknown plugin', async () => {
    await expect(ctrl.create(APP, { pluginId: 'ghost' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('404s an unknown app', async () => {
    ctx.mocks.apps.get.mockResolvedValue(null as never);
    await expect(
      ctrl.create('nope', { pluginId: 'refapp' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lists this app’s assignments', async () => {
    const res = await ctrl.list(APP);
    expect(res.data).toHaveLength(1);
    expect(assignments.list).toHaveBeenCalledWith(APP);
  });

  it('refuses to revoke an assignment belonging to another app', async () => {
    assignments.get.mockReturnValue(fakeAssignment({ app: 'other' }));
    await expect(ctrl.revoke(APP, 'x1')).rejects.toBeInstanceOf(NotFoundException);
    expect(scheduler.revoke).not.toHaveBeenCalled();
  });

  it('revokes an assignment owned by the app', async () => {
    const res = await ctrl.revoke(APP, 'x1');
    expect(res.data).toEqual({ id: 'x1', revoked: true });
    expect(scheduler.revoke).toHaveBeenCalledWith('x1');
  });
});
