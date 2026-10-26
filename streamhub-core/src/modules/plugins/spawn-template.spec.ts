/**
 * Unit + FIDELITY specs for the declarative spawn-template interpreter.
 *
 * The grammar tests lock down the placeholder / coalesce / ternary / map rules;
 * the fidelity tests are the load-bearing ones for the whole decoupling: they
 * feed the SHIPPED declarative manifests (src/plugins/<id>/streamhub.app.json)
 * through the interpreter and assert the result is byte-for-byte identical to
 * what the code-based `plugin.meta.ts` `worker.spawn(ctx)` returns. That is the
 * guarantee that a remote package can drop its executable JS and still spawn its
 * worker EXACTLY as before.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { PluginWorkerContext } from './plugin.contract';
import { defaultConfig } from './plugin-config.util';
import {
  interpretWorkerTemplate,
  renderTemplate,
  stringifyConfigValue,
} from './spawn-template';
import refappMeta from '../../../test/fixtures/plugins/refapp/plugin.meta';

const baseCtx = (over: Partial<PluginWorkerContext> = {}): PluginWorkerContext => ({
  app: 'live',
  config: {},
  appDir: '/data/apps/live',
  dataDir: '/data',
  livekitUrl: 'wss://lk.example:7880',
  ...over,
});

const opts = { workerDir: '/opt/worker', pluginPython: 'python3', publicBase: '' };

describe('renderTemplate — placeholder grammar', () => {
  it('substitutes the scalar context refs', () => {
    const ctx = baseCtx();
    expect(renderTemplate('{{app}}', ctx, opts)).toBe('live');
    expect(renderTemplate('{{appDir}}/lpr', ctx, opts)).toBe('/data/apps/live/lpr');
    expect(renderTemplate('{{dataDir}}/models/lpr', ctx, opts)).toBe('/data/models/lpr');
    expect(renderTemplate('{{livekitUrl}}', ctx, opts)).toBe('wss://lk.example:7880');
    expect(renderTemplate('{{workerDir}}', ctx, opts)).toBe('/opt/worker');
    expect(renderTemplate('{{pluginPython}}', ctx, opts)).toBe('python3');
  });

  it('stringifies config values like String(...)', () => {
    expect(stringifyConfigValue('x')).toBe('x');
    expect(stringifyConfigValue(0.5)).toBe('0.5');
    expect(stringifyConfigValue(true)).toBe('true');
    expect(stringifyConfigValue(false)).toBe('false');
    expect(stringifyConfigValue(undefined)).toBe('');
    expect(stringifyConfigValue(null)).toBe('');
    const ctx = baseCtx({ config: { room: 'gate', fps: 2, on: true, missing: undefined } });
    expect(renderTemplate('{{config.room}}', ctx, opts)).toBe('gate');
    expect(renderTemplate('{{config.fps}}', ctx, opts)).toBe('2');
    expect(renderTemplate('{{config.on}}', ctx, opts)).toBe('true');
    expect(renderTemplate('{{config.missing}}', ctx, opts)).toBe('');
  });

  it('ternary filter: truthy → then, falsy (,"false","0") → else', () => {
    const on = baseCtx({ config: { cuda: true } });
    const off = baseCtx({ config: { cuda: false } });
    expect(renderTemplate('{{ config.cuda | ternary:cuda:cpu }}', on, opts)).toBe('cuda');
    expect(renderTemplate('{{ config.cuda | ternary:cuda:cpu }}', off, opts)).toBe('cpu');
    // '0' and '' are falsy too.
    expect(renderTemplate('{{ config.n | ternary:y:n }}', baseCtx({ config: { n: 0 } }), opts)).toBe('n');
    expect(renderTemplate('{{ config.s | ternary:y:n }}', baseCtx({ config: { s: '' } }), opts)).toBe('n');
  });

  it('map filter: table lookup with a * default', () => {
    const tpl = '{{ config.model | map:nano=yolov8n,small=yolov8s,*=yolov8n }}';
    expect(renderTemplate(tpl, baseCtx({ config: { model: 'nano' } }), opts)).toBe('yolov8n');
    expect(renderTemplate(tpl, baseCtx({ config: { model: 'small' } }), opts)).toBe('yolov8s');
    expect(renderTemplate(tpl, baseCtx({ config: { model: 'huge' } }), opts)).toBe('yolov8n');
  });

  it('coalesce (??): first non-empty wins, else falls through', () => {
    expect(renderTemplate('{{ originUrl ?? publicBase }}', baseCtx({ originUrl: 'https://o' }), opts)).toBe('https://o');
    expect(
      renderTemplate('{{ originUrl ?? publicBase }}', baseCtx(), { ...opts, publicBase: 'https://p' }),
    ).toBe('https://p');
    expect(renderTemplate("{{ config.x ?? 'fallback' }}", baseCtx(), opts)).toBe('fallback');
  });

  it('localOnly filter: value renders locally, is WITHHELD on a remote ctx (edge/grid)', () => {
    const tpl = '{{ config.apiKey | localOnly }}';
    const local = baseCtx({ config: { apiKey: 'sk-secret' } });
    expect(renderTemplate(tpl, local, opts)).toBe('sk-secret');
    // Remote by originUrl (edge resolver) — the secret must NOT ride the frame.
    const viaOrigin = baseCtx({ config: { apiKey: 'sk-secret' }, originUrl: 'https://origin' });
    expect(renderTemplate(tpl, viaOrigin, opts)).toBe('');
    // Remote by node identity (grid dispatch) — same withholding.
    const viaNode = baseCtx({ config: { apiKey: 'sk-secret' } });
    (viaNode as { node?: unknown }).node = { id: 'gpu1' };
    expect(renderTemplate(tpl, viaNode, opts)).toBe('');
  });

  it('env.<NAME> reads the injected process env', () => {
    const ctx = baseCtx();
    expect(renderTemplate('{{env.MY_VAR}}', ctx, { ...opts, env: { MY_VAR: 'hi' } })).toBe('hi');
    expect(renderTemplate('{{env.ABSENT}}', ctx, { ...opts, env: {} })).toBe('');
  });

  it('configJson emits the whole config as JSON', () => {
    const ctx = baseCtx({ config: { a: 1, b: 'x' } });
    expect(renderTemplate('{{configJson}}', ctx, opts)).toBe('{"a":1,"b":"x"}');
  });
});

describe('interpretWorkerTemplate — spec assembly', () => {
  it('tokenizes entry BEFORE substitution — a value cannot inject an arg', () => {
    const spec = interpretWorkerTemplate(
      { needsWorker: true, entry: '{{pluginPython}} -m mod --app {{app}}' },
      baseCtx({ app: 'a b c' }),
      opts,
    );
    expect(spec.command).toBe('python3');
    // 'a b c' stays ONE argument despite its spaces.
    expect(spec.args).toEqual(['-m', 'mod', '--app', 'a b c']);
  });

  it('defaults cwd to {{workerDir}} and renders env templates', () => {
    const spec = interpretWorkerTemplate(
      { needsWorker: true, entry: 'python3 -m mod', env: { DIR: '{{appDir}}/x' } },
      baseCtx(),
      opts,
    );
    expect(spec.cwd).toBe('/opt/worker');
    expect(spec.env).toEqual({ DIR: '/data/apps/live/x' });
  });
});

// In-tree apps keep their authored manifest at src/plugins/<id>/; the DECOUPLED
// apps (lpr, …) ship only as a vendored release (F1 exodus), extracted to
// vendor/apps/<id>/ by scripts/apps-pull.mjs. The living FIDELITY witness is the
// synthetic `refapp` fixture (test/fixtures/plugins/refapp/) — it never decouples,
// so it always has BOTH a code meta and a declarative manifest to diff. Resolve
// in-tree first, then the vendor dir (`lpr`), then the test fixtures (`refapp`).
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
function manifestPath(id: string): string | null {
  const inTree = path.join(__dirname, '..', '..', 'plugins', id, 'streamhub.app.json');
  if (fs.existsSync(inTree)) return inTree;
  const vendored = path.join(REPO_ROOT, 'vendor', 'apps', id, 'streamhub.app.json');
  if (fs.existsSync(vendored)) return vendored;
  const fixture = path.join(
    __dirname, '..', '..', '..', 'test', 'fixtures', 'plugins', id, 'streamhub.app.json',
  );
  if (fs.existsSync(fixture)) return fixture;
  return null;
}
/** Load a shipped declarative manifest's worker block. */
function loadWorker(id: string): Record<string, unknown> {
  const p = manifestPath(id);
  if (!p) {
    throw new Error(
      `no shipped manifest for '${id}' (run scripts/apps-pull.mjs to compose vendored apps)`,
    );
  }
  return JSON.parse(fs.readFileSync(p, 'utf8')).worker;
}
// lpr is composed only when apps-pull has vendored the release (CI / token).
const lprComposed = manifestPath('lpr') !== null;

describe('FIDELITY — declarative manifest === code-based meta spawn', () => {
  // lpr is the DECOUPLED pilot — its built-in meta was removed (it loads only
  // via vendor), so there is no code meta to diff against. This GOLDEN locks the
  // interpreted spawn of its shipped declarative manifest to the exact spec the
  // old code meta produced; `presence` below stays in-tree as the living witness
  // that the interpreter reproduces a real `worker.spawn(ctx)` byte-for-byte.
  (lprComposed ? it : it.skip)('lpr: the shipped declarative manifest interprets to the pinned spawn spec', () => {
    const ctx = baseCtx({
      app: 'myapp',
      appDir: '/data/apps/myapp',
      dataDir: '/data',
      livekitUrl: 'wss://lk.example:7880',
      config: {
        room: '',
        detector: 'yolo-v9-t-384-license-plate-end2end',
        ocrModel: 'cct-xs-v1-global-model',
        confidence: 0.5,
        fps: 2,
        dedupeWindowSec: 10,
        whitelist: '',
        blacklist: '',
        callbackUrl: '',
        snapshots: true,
        cuda: false,
      },
    });
    const spec = interpretWorkerTemplate(loadWorker('lpr'), ctx, {
      workerDir: '/opt/lpr-worker',
      pluginPython: 'python3',
      publicBase: '',
      env: {},
    });
    expect(spec).toEqual({
      command: 'python3',
      args: ['-m', 'lpr_worker', '--app', 'myapp'],
      cwd: '/opt/lpr-worker',
      env: {
        PYTHONPATH: '/opt/lpr-worker',
        PYTHONUNBUFFERED: '1',
        LPR_APP: 'myapp',
        LPR_ROOM: '',
        LPR_DETECTOR: 'yolo-v9-t-384-license-plate-end2end',
        LPR_OCR_MODEL: 'cct-xs-v1-global-model',
        LPR_CONFIDENCE: '0.5',
        LPR_FPS: '2',
        LPR_DEDUPE_SEC: '10',
        LPR_WHITELIST: '',
        LPR_BLACKLIST: '',
        LPR_CALLBACK_URL: '',
        LPR_SNAPSHOTS: 'true',
        LPR_DEVICE: 'cpu',
        LPR_DATA_DIR: '/data/apps/myapp/lpr',
        LPR_MODEL_DIR: '/data/models/lpr',
        LPR_HLS_DIR: '/data/apps/myapp/hls',
        LPR_PUBLIC_BASE: '',
        LPR_LIVEKIT_URL: 'wss://lk.example:7880',
      },
    });
  });

  // The LIVING witness: `refapp` is a synthetic fixture that ships BOTH a code
  // `plugin.meta.ts` and a declarative `streamhub.app.json`, and (unlike a real
  // app) never decouples — so this always proves the interpreter reproduces a
  // real `worker.spawn(ctx)` byte-for-byte.
  it('refapp: interpreted spawn equals the real meta.worker.spawn(ctx)', () => {
    const ctx = baseCtx({ app: 'myapp', config: defaultConfig(refappMeta), appDir: '/data/apps/myapp' });
    const real = refappMeta.worker!.spawn(ctx);
    const interpreted = interpretWorkerTemplate(loadWorker('refapp'), ctx, {
      workerDir: real.cwd as string,
    });
    expect(interpreted).toEqual(real);
  });

  it('refapp: the ternary + config refs render into the env (cuda → device)', () => {
    const ctx = baseCtx({
      app: 'myapp',
      config: { ...defaultConfig(refappMeta), cuda: true, room: 'gate', confidence: 0.7 },
      appDir: '/data/apps/myapp',
    });
    const real = refappMeta.worker!.spawn(ctx);
    const interpreted = interpretWorkerTemplate(loadWorker('refapp'), ctx, {
      workerDir: real.cwd as string,
    });
    expect(interpreted).toEqual(real);
    expect(interpreted.env?.REFAPP_DEVICE).toBe('cuda');
    expect(interpreted.env?.REFAPP_ROOM).toBe('gate');
  });
});
