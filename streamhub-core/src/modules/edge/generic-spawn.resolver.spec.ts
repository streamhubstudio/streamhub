/**
 * Unit specs for the GenericSpawnResolver — the edge.protocol seam impl.
 *
 * Covers:
 *   - GENERIC delegation: any pluginId resolves via its own worker.spawn(ctx)
 *     against a REMOTE ctx (originUrl = public base), with the framework
 *     STREAMHUB_* edge env injected (app / pluginId / ingest+events URLs);
 *   - a STABLE, cluster-derived ingest token (same for the same app/plugin/room
 *     across calls; different room → different token; a hex HMAC, never the raw
 *     cluster secret);
 *   - a real vision app (occupancy) resolving to `vision_edge --model … --room …`
 *     with the demography key WITHHELD from the frame;
 *   - registration: resolveSpawnSpec() consults the registered resolver and
 *     falls back to the empty spec when cleared;
 *   - an unknown / worker-less plugin → empty spec.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { resolveSpawnSpec, setSpawnResolver } from './edge.protocol';
import { GenericSpawnResolver } from './generic-spawn.resolver';
import { PluginRegistryService } from '../plugins/plugin-registry.service';

const BASE = 'https://vision.example.com';
const TOKEN = 'cluster-secret-xyz';

/** A generic worker plugin whose spawn echoes the ctx it was handed. */
function writeFixture(dir: string): void {
  const gen = path.join(dir, 'genx');
  fs.mkdirSync(gen, { recursive: true });
  fs.writeFileSync(
    path.join(gen, 'plugin.meta.js'),
    `module.exports.default = {
       id:'genx', name:'GenX', description:'', category:'processor',
       ui:'app-tab', needsWorker:true, version:'1.0.0', configSchema:[],
       worker:{ edge:true, spawn(ctx){ return {
         command:'python3', args:['-m','genx','--app',ctx.app],
         env:{ GENX_ORIGIN: ctx.originUrl ?? '', GENX_DATA: ctx.dataDir } }; } } };`,
  );
}

describe('GenericSpawnResolver', () => {
  let ctx: UnitContext;
  let dir: string;
  let registry: PluginRegistryService;
  let resolver: GenericSpawnResolver;

  beforeEach(() => {
    ctx = makeUnitContext({
      PUBLIC_BASE_URL: BASE,
      STREAMHUB_CLUSTER_TOKEN: TOKEN,
    });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'generic-spawn-'));
    writeFixture(dir);
    registry = new PluginRegistryService(dir);
    registry.discover();
    resolver = new GenericSpawnResolver(ctx.config, registry, ctx.mocks.apps);
  });

  afterEach(() => {
    setSpawnResolver(null);
    fs.rmSync(dir, { recursive: true, force: true });
    ctx.cleanup();
  });

  describe('generic delegation + framework edge env', () => {
    it('resolves a plugin via its worker.spawn(ctx) with a remote ctx', () => {
      const spec = resolver.resolve('live', 'genx', { room: 'gate' });
      expect(spec.command).toBe('python3');
      expect(spec.args).toEqual(['-m', 'genx', '--app', 'live']);
      expect(spec.env.GENX_ORIGIN).toBe(BASE); // originUrl handed to the worker
    });

    it('injects the STREAMHUB_* framework env (app / plugin / ingest+events URLs)', () => {
      const env = resolver.resolve('live', 'genx', { room: 'gate' }).env;
      expect(env.STREAMHUB_APP).toBe('live');
      expect(env.STREAMHUB_PLUGIN_ID).toBe('genx');
      expect(env.STREAMHUB_EVENTS_URL).toBe(`${BASE}/api/v1/apps/live/plugins/genx/events`);
      expect(env.STREAMHUB_INGEST_URL).toBe(`${BASE}/api/v1/apps/live/plugins/genx/live`);
    });

    it('derives a STABLE cluster-scoped ingest token (per app/plugin/room)', () => {
      const a = resolver.resolve('live', 'genx', { room: 'gate' }).env.STREAMHUB_INGEST_TOKEN;
      const b = resolver.resolve('live', 'genx', { room: 'gate' }).env.STREAMHUB_INGEST_TOKEN;
      expect(a).toBeTruthy();
      expect(a).toBe(b); // stable across re-offers
      const c = resolver.resolve('live', 'genx', { room: 'lobby' }).env.STREAMHUB_INGEST_TOKEN;
      expect(c).not.toBe(a); // different room → different token
      // A hex HMAC, never the raw cluster secret.
      expect(a).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(resolver.resolve('live', 'genx', {}).env)).not.toContain(TOKEN);
    });

    it('returns an empty spec for an unknown plugin', () => {
      expect(resolver.resolve('live', 'ghost', {})).toEqual({
        command: '',
        args: [],
        env: {},
      });
    });
  });

// COMPOSED-GATED: the vision apps are decoupled vendored apps — these cases
  // run against the composed catalog (CI composes; hermetic checkouts skip).
  const VISION_COMPOSED = fs.existsSync(
    path.join(__dirname, '..', 'plugins-vendor', 'occupancy', 'streamhub.app.json'),
  );
  (VISION_COMPOSED ? describe : describe.skip)('vision apps (via the real registry)', () => {
    let realResolver: GenericSpawnResolver;

    beforeEach(() => {
      const real = new PluginRegistryService();
      real.discover();
      realResolver = new GenericSpawnResolver(ctx.config, real, ctx.mocks.apps);
    });

    it('resolves a vision app to the unified `vision_edge --model …` (mode/room in env)', () => {
      const spec = realResolver.resolve('live', 'occupancy', {
        room: 'gate',
        device: 'cuda',
        settings: { zones: [] },
      });
      // Unified shape: mode/app/room ride in env; the runtime derives the HLS
      // URL from VISION_PUBLIC_BASE + app + room.
      expect(spec.args).toEqual(['-m', 'vision_edge', '--model', 'occupancy']);
      expect(spec.env.VISION_MODE).toBe('edge');
      expect(spec.env.VISION_ROOM).toBe('gate');
      expect(spec.env.VISION_PUBLIC_BASE).toBe(BASE);
      expect(spec.env.STREAMHUB_EVENTS_URL).toBe(
        `${BASE}/api/v1/apps/live/plugins/occupancy/events`,
      );
      expect(spec.env.STREAMHUB_INGEST_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    });

    it('WITHHOLDS the demography API key from the frame', () => {
      const spec = realResolver.resolve('live', 'demography', {
        room: 'gate',
        engine: 'openai',
        ai_api_key: 'sk-super-secret',
        settings: {},
      });
      expect(JSON.stringify(spec.env)).not.toContain('sk-super-secret');
      // Present-but-EMPTY on any remote frame (the `localOnly` semantics).
      expect(spec.env.VISION_AI_API_KEY).toBe('');
    });
  });

  describe('edge.protocol registration', () => {
    it('resolveSpawnSpec delegates to the registered resolver, empty when cleared', () => {
      setSpawnResolver(resolver);
      const spec = resolveSpawnSpec('live', 'genx', { room: 'r' });
      expect(spec.args).toContain('genx');
      setSpawnResolver(null);
      expect(resolveSpawnSpec('live', 'genx', {})).toEqual({
        command: '',
        args: [],
        env: {},
      });
    });
  });
});
