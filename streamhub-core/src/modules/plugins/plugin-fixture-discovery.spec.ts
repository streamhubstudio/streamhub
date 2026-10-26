/**
 * The TEST-ONLY fixture-app discovery seam (STREAMHUB_PLUGIN_FIXTURE_ROOT).
 *
 * This env var lets specs discover the stable synthetic reference apps
 * (`refapp`, `reftool`) under test/fixtures/plugins/ as in-tree plugins, so a
 * spec that just needs "some exportable/edge/non-edge worker app" to exercise a
 * behaviour never has to lean on a REAL shipping app (which may decouple to its
 * own repo). Production never sets the var, so the fixtures never leak into the
 * real catalog — asserted here.
 */
import * as path from 'path';
import { PluginRegistryService } from './plugin-registry.service';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', '..', 'test', 'fixtures', 'plugins');

describe('PluginRegistryService — fixture-app discovery', () => {
  const prev = process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT;
  afterAll(() => {
    if (prev === undefined) delete process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT;
    else process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT = prev;
  });

  it('does NOT discover the fixtures when the env is unset (prod-safe)', () => {
    delete process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT;
    const r = new PluginRegistryService();
    r.discover();
    expect(r.has('refapp')).toBe(false);
    expect(r.has('reftool')).toBe(false);
    expect(r.has('refoverlay')).toBe(false);
    // The real in-tree catalog is unaffected.
    expect(r.has('cockpit')).toBe(true);
  });

  it('discovers refapp (edge, exportable) + reftool (non-edge) + refoverlay (overlay) when the env points at the fixtures', () => {
    process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT = FIXTURE_ROOT;
    const r = new PluginRegistryService();
    r.discover();

    const refapp = r.getManifest('refapp');
    expect(refapp?.kind).toBe('app');
    expect(refapp?.exportable).toBe(true);
    expect(refapp?.edge).toBe(true);
    expect(refapp?.storage).toEqual({ db: 'refapp.db' });

    const reftool = r.getManifest('reftool');
    expect(reftool?.kind).toBe('app');
    expect(reftool?.edge).toBe(false);

    // refoverlay: a player-overlay plugin carrying a secret callbackUrl.
    const refoverlay = r.getManifest('refoverlay');
    expect(refoverlay?.ui).toBe('player-overlay');
    expect(refoverlay?.kind).toBe('plugin');

    // Fixtures are ADDITIVE — the real in-tree apps are still there.
    expect(r.has('cockpit')).toBe(true);
  });
});
