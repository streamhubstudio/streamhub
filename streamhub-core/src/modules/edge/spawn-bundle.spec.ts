/**
 * Specs for the APP-VERSIONING edge seam: the generic resolver exposes a pinned
 * install's bundle ref (id/version/sha256/url off the master), and toAssignFrame
 * attaches it to the assign frame ONLY when present (back-compat otherwise).
 */
import { makeTestConfig } from '../../../test/helpers';
import { mockAppsService } from '../../../test/helpers/service-mocks';
import { AppPluginsRepository } from '../plugins/app-plugins.repository';
import { AppstoreService } from '../plugins/appstore/appstore.service';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import { GenericSpawnResolver } from './generic-spawn.resolver';
import {
  resolveBundleRef,
  setSpawnResolver,
  toAssignFrame,
} from './edge.protocol';
import type { EdgeAssignment } from './edge.types';

const registry = {
  getMeta: () => undefined,
} as unknown as PluginRegistryService;

function makeResolver(pin: string | null, sha: string | null): GenericSpawnResolver {
  const { config } = makeTestConfig({
    PUBLIC_BASE_URL: 'https://master.example.com',
  });
  const appstore = {
    versionSha256: () => sha,
  } as unknown as AppstoreService;
  const appPlugins = {
    get: () => ({ workerVersion: pin }),
  } as unknown as AppPluginsRepository;
  return new GenericSpawnResolver(
    config,
    registry,
    mockAppsService(),
    appstore,
    appPlugins,
  );
}

const ASSIGNMENT: EdgeAssignment = {
  id: 'as_1',
  nodeId: 'node_1',
  app: 'live',
  pluginId: 'counting',
  streamId: 'cam-1',
  config: { room: 'cam-1' },
  status: 'pending',
  detail: null,
  createdAt: '',
  updatedAt: '',
};

describe('edge app-versioning seam', () => {
  afterEach(() => setSpawnResolver(null));

  it('resolveBundle returns the pinned bundle ref (url + sha256)', () => {
    const bundle = makeResolver('2.9.0', 'deadbeef').resolveBundle('live', 'counting');
    expect(bundle).toEqual({
      pluginId: 'counting',
      version: '2.9.0',
      sha256: 'deadbeef',
      url: 'https://master.example.com/api/v1/plugins/counting/versions/2.9.0/bundle',
    });
  });

  it('resolveBundle returns null when the install is not pinned', () => {
    expect(makeResolver(null, 'x').resolveBundle('live', 'counting')).toBeNull();
  });

  it('resolveBundle returns null when the pinned version vanished (no sha256)', () => {
    expect(makeResolver('2.9.0', null).resolveBundle('live', 'counting')).toBeNull();
  });

  it('toAssignFrame attaches the bundle when the resolver provides one', () => {
    setSpawnResolver(makeResolver('2.9.0', 'deadbeef'));
    const frame = toAssignFrame(ASSIGNMENT);
    expect(frame.assignment.bundle).toEqual(
      expect.objectContaining({ pluginId: 'counting', version: '2.9.0', sha256: 'deadbeef' }),
    );
  });

  it('toAssignFrame omits the bundle for an unpinned install', () => {
    setSpawnResolver(makeResolver(null, null));
    const frame = toAssignFrame(ASSIGNMENT);
    expect(frame.assignment.bundle).toBeUndefined();
  });

  it('resolveBundleRef tolerates a resolver without resolveBundle (foundation)', () => {
    setSpawnResolver({ resolve: () => ({ command: '', args: [], env: {} }) });
    expect(resolveBundleRef('live', 'counting')).toBeNull();
  });
});
