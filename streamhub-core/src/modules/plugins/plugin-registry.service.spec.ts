/**
 * Unit specs for PluginRegistryService (auto-discovery).
 *
 * Two flavors:
 *  - default root → discovers the REAL shipped built-in plugins (proves the
 *    glob wiring maps to src/plugins under ts-jest).
 *  - a temp fixture root → covers malformed / duplicate / worker-less-worker
 *    handling WITHOUT crashing.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PluginRegistryService } from './plugin-registry.service';

describe('PluginRegistryService — built-in discovery', () => {
  let registry: PluginRegistryService;

  beforeEach(() => {
    registry = new PluginRegistryService(); // default src/plugins root
    registry.discover();
  });

  it('auto-discovers the shipped built-in plugins', () => {
    const ids = registry.listManifests().map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['yolo', 'watermark', 'timestamp']));
  });

  it('manifests are serializable (worker closure stripped)', () => {
    // `yolo` is the shipped needsWorker processor.
    const yolo = registry.getManifest('yolo');
    expect(yolo?.needsWorker).toBe(true);
    // no `worker` function leaks onto the manifest
    expect((yolo as Record<string, unknown>).worker).toBeUndefined();
    expect(() => JSON.stringify(yolo)).not.toThrow();
  });

  it('keeps the worker closure on the full meta', () => {
    const meta = registry.getMeta('yolo');
    expect(typeof meta?.worker?.spawn).toBe('function');
  });

  it('listManifests is sorted by name', () => {
    const names = registry.listManifests().map((m) => m.name);
    expect([...names]).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

describe('PluginRegistryService — fixture root', () => {
  let dir: string;

  const write = (folder: string, body: string): void => {
    const d = path.join(dir, folder);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'plugin.meta.js'), body);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-reg-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('loads valid plugins and skips malformed ones without throwing', () => {
    write(
      'good',
      `module.exports.default = { id:'good', name:'Good', description:'', category:'tool', ui:'panel', configSchema:[] };`,
    );
    // id !== folder → skipped
    write(
      'mismatch',
      `module.exports.default = { id:'other', name:'X', description:'', category:'tool', ui:'panel', configSchema:[] };`,
    );
    // bad category → skipped
    write(
      'badcat',
      `module.exports.default = { id:'badcat', name:'X', description:'', category:'nope', ui:'panel', configSchema:[] };`,
    );
    // needsWorker without worker.spawn → skipped
    write(
      'noworker',
      `module.exports.default = { id:'noworker', name:'X', description:'', category:'processor', ui:'player-overlay', needsWorker:true, configSchema:[] };`,
    );

    const registry = new PluginRegistryService(dir);
    expect(() => registry.discover()).not.toThrow();
    const ids = registry.listManifests().map((m) => m.id);
    expect(ids).toEqual(['good']);
  });

  it('deduplicates by id (first wins, no crash)', () => {
    write(
      'dup',
      `module.exports.default = { id:'dup', name:'Dup', description:'', category:'tool', ui:'panel', configSchema:[] };`,
    );
    const registry = new PluginRegistryService(dir);
    registry.discover();
    expect(registry.has('dup')).toBe(true);
  });

  it('returns empty when the directory is missing', () => {
    const registry = new PluginRegistryService(path.join(dir, 'does-not-exist'));
    registry.discover();
    expect(registry.listManifests()).toEqual([]);
  });
});
