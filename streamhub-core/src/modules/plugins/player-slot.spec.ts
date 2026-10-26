/**
 * Unit — the `player` UI slot (swappable media-player provider).
 *
 * Locks down the contract extension that lets a plugin PROVIDE the media player:
 *  - the registry accepts a `ui: 'player'` manifest (and still rejects garbage
 *    slots), and toManifest passes the slot through untouched;
 *  - the shipped `vidstack` built-in is discovered as a worker-less `tool` in the
 *    `player` slot, with every config field defaulted (contract invariant).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PluginMeta, toManifest } from './plugin.contract';
import { PluginRegistryService } from './plugin-registry.service';

function write(dir: string, id: string, body: string): void {
  const folder = path.join(dir, id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'plugin.meta.js'), body);
}

describe('plugin `player` UI slot', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'player-slot-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('registry accepts a `player` slot and rejects an unknown one', () => {
    write(
      dir,
      'prov',
      `module.exports.default = { id:'prov', name:'Prov', description:'',
         category:'tool', ui:'player', configSchema:[] };`,
    );
    write(
      dir,
      'bad',
      `module.exports.default = { id:'bad', name:'Bad', description:'',
         category:'tool', ui:'video', configSchema:[] };`,
    );
    const registry = new PluginRegistryService(dir);
    registry.discover();
    expect(registry.has('prov')).toBe(true);
    expect(registry.getManifest('prov')?.ui).toBe('player');
    expect(registry.has('bad')).toBe(false);
  });

  it('toManifest passes the `player` slot through', () => {
    const meta: PluginMeta = {
      id: 'prov',
      name: 'Prov',
      description: '',
      category: 'tool',
      ui: 'player',
      configSchema: [],
    };
    expect(toManifest(meta)).toMatchObject({ ui: 'player', needsWorker: false });
  });

  it('discovers the shipped `vidstack` provider (worker-less tool, all defaults set)', () => {
    const registry = new PluginRegistryService(
      path.resolve(__dirname, '..', '..', 'plugins'),
    );
    registry.discover();
    const m = registry.getManifest('vidstack');
    expect(m).toBeDefined();
    expect(m).toMatchObject({
      ui: 'player',
      category: 'tool',
      needsWorker: false,
      workerPlacement: 'local',
    });
    for (const f of m!.configSchema) {
      expect(f.default).not.toBeUndefined();
    }
  });
});
