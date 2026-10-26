/**
 * Unit specs for VisionAppService — the ONE read/settings service parametrized
 * by model. Covers config resolution (defaults → override), settings round-trip,
 * per-model overview (today count + edge-assignment count + enabled state), the
 * pipeline aggregate across the four apps, and the unknown-model 404.
 *
 * Real DB + real registry/install/tags; the edge assignments repo + gateway are
 * jest mocks (no cluster infra).
 */
import { NotFoundException } from '@nestjs/common';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { AppPluginsRepository } from '../plugins/app-plugins.repository';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import { TagsRepository } from '../tags/tags.repository';
import { VisionAppService } from './vision.service';
import { VisionStore } from './vision.store';
import type { EdgeAssignment } from '../edge/edge.types';

const APP = 'live';

describe('VisionAppService', () => {
  let ctx: UnitContext;
  let store: VisionStore;
  let installs: AppPluginsRepository;
  let assignments: { list: jest.Mock };
  let gateway: { isConnected: jest.Mock };
  let svc: VisionAppService;

  const appDir = (): string => ctx.mocks.apps.appDir(APP);

  beforeEach(() => {
    ctx = makeUnitContext();
    ctx.mocks.apps.get.mockResolvedValue({ id: 1, name: APP } as never);
    ctx.mocks.apps.appDir.mockImplementation(() => `${ctx.dataDir}/apps/${APP}`);

    store = new VisionStore();
    installs = new AppPluginsRepository(ctx.db);
    assignments = { list: jest.fn(() => [] as EdgeAssignment[]) };
    gateway = { isConnected: jest.fn(() => false) };
    const registry = new PluginRegistryService();
    registry.discover();
    const tags = new TagsRepository(ctx.db);

    svc = new VisionAppService(
      store,
      registry,
      installs,
      tags,
      assignments as never,
      gateway as never,
      ctx.db,
      ctx.mocks.apps,
    );
  });

  afterEach(() => {
    store.onModuleDestroy();
    ctx.cleanup();
  });

  it('404s an unknown model', async () => {
    await expect(svc.overview(APP, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('stores + resolves a per-room settings override (defaults → override)', async () => {
    const put = await svc.putSettings(APP, 'occupancy', 'gate', {
      zones: [{ id: 'z1', tag: '', detect: 'personas', points: [[0, 0], [1, 0], [1, 1]] }],
    });
    expect(put.model).toBe('occupancy');
    expect(put.resolved.zones).toHaveLength(1);
    const got = await svc.getSettings(APP, 'occupancy', 'gate');
    expect((got.config as { zones: unknown[] }).zones).toHaveLength(1);
  });

  it('overview reports enabled state + today count + edge-assignment count', async () => {
    installs.install(APP, 'occupancy', { device: 'cpu' }, true);
    store.recordOccupancy(APP, appDir(), 'gate', 'occupancy.session_started', { zone: 'z1' });
    assignments.list.mockReturnValue([
      { pluginId: 'occupancy', status: 'running' } as EdgeAssignment,
      { pluginId: 'counting', status: 'running' } as EdgeAssignment,
    ]);
    const ov = await svc.overview(APP, 'occupancy');
    expect(ov).toMatchObject({ model: 'occupancy', enabled: true, today: 1, assignments: 1 });
  });

  it('pipelineVision aggregates enabled models + assignments across the apps', () => {
    installs.install(APP, 'occupancy', {}, true);
    installs.install(APP, 'counting', {}, false); // installed but disabled
    assignments.list.mockReturnValue([
      { pluginId: 'occupancy', status: 'running' } as EdgeAssignment,
      { pluginId: 'occupancy', status: 'pending' } as EdgeAssignment,
      { pluginId: 'lpr', status: 'running' } as EdgeAssignment, // not a vision model
    ]);
    const v = svc.pipelineVision(APP);
    expect(v.enabledModels).toEqual(['occupancy']);
    expect(v.assignments).toEqual({ running: 1, pending: 1 });
  });
});
