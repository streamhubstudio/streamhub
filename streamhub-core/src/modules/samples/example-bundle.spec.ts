/**
 * Unit spec — downloadable EXAMPLE bundle builder (example-bundle.ts).
 *
 * Pure string invariants over the in-repo TEMPLATES — nothing dials the network,
 * a DB, or the filesystem. Locks down:
 *   - the catalogue stays 1:1 with the shipped SAMPLE_FILES,
 *   - every bundle is a self-contained, config-driven page (index.html +
 *     config.js + README.md), sharing the SAME template source as the served page,
 *   - config.js carries every required config key,
 *   - NO secrets / real host leak into the generic (placeholder) bundle,
 *   - a per-app build wires config.js to that app with no leftover placeholders.
 */
import {
  CONFIG_SCRIPT_TAG,
  EXAMPLE_BUNDLES,
  PLACEHOLDER_CONTEXT,
  buildAllBundles,
  buildExampleBundle,
  getExample,
  type ExampleContext,
} from './example-bundle';
import { SAMPLE_FILES } from './sample-templates';

const IDS = EXAMPLE_BUNDLES.map((e) => e.id);

describe('example-bundle — catalogue', () => {
  it('is 1:1 with the shipped SAMPLE_FILES', () => {
    const files = EXAMPLE_BUNDLES.map((e) => e.file).sort();
    expect(files).toEqual([...SAMPLE_FILES].sort());
    expect(EXAMPLE_BUNDLES).toHaveLength(SAMPLE_FILES.length);
  });

  it('every id maps back to its template file (id = file minus .html)', () => {
    for (const e of EXAMPLE_BUNDLES) {
      expect(e.file).toBe(`${e.id}.html`);
      expect(getExample(e.id)).toBe(e);
    }
  });

  it('every descriptor requires the four core config keys', () => {
    for (const e of EXAMPLE_BUNDLES) {
      for (const k of ['baseUrl', 'wsUrl', 'app', 'room']) {
        expect(e.requiredConfig).toContain(k);
      }
    }
  });
});

describe('example-bundle — build (generic/placeholder context)', () => {
  it.each(IDS)('%s produces index.html + config.js + README.md', (id) => {
    const { files } = buildExampleBundle(id);
    expect(Object.keys(files).sort()).toEqual([
      'README.md',
      'config.js',
      'index.html',
    ]);
  });

  it.each(IDS)('%s index.html is a self-contained, config-driven document', (id) => {
    const html = buildExampleBundle(id).files['index.html'];
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
    // Loads config.js and reads window.STREAMHUB_CONFIG.
    expect(html).toContain(CONFIG_SCRIPT_TAG);
    expect(html).toContain('window.STREAMHUB_CONFIG');
    // config.js is loaded BEFORE the livekit-client so CFG is set in time.
    if (html.includes('livekit-client')) {
      expect(html.indexOf(CONFIG_SCRIPT_TAG)).toBeLessThan(
        html.indexOf('livekit-client'),
      );
    }
    // No unresolved template placeholders remain.
    expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it.each(IDS)('%s config.js exposes window.STREAMHUB_CONFIG + required keys', (id) => {
    const d = getExample(id)!;
    const cfg = buildExampleBundle(id).files['config.js'];
    expect(cfg).toContain('window.STREAMHUB_CONFIG');
    for (const k of d.requiredConfig) {
      expect(cfg).toContain(`${k}:`);
    }
    // Publisher/ephemeral examples surface a credential knob.
    if (d.authModel === 'ephemeral' || d.authModel === 'publisher') {
      expect(cfg).toContain('token:');
    }
    if (d.authModel === 'publisher') {
      expect(cfg).toContain('apiToken:');
    }
  });

  it.each(IDS)('%s leaks no real host / secret in the generic bundle', (id) => {
    const { files } = buildExampleBundle(id);
    const blob = files['index.html'] + '\n' + files['config.js'];
    // Placeholder host only — never a real tenant/deployment domain.
    expect(blob).toContain('your-streamhub.example.com');
    expect(blob).not.toContain('digitalhub.com.ar');
    // No management token or minted JWT baked in.
    expect(blob).not.toMatch(/sk_[A-Za-z0-9]/);
    expect(blob).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    // Credential fields, when present, ship EMPTY.
    if (files['config.js'].includes('token:')) {
      expect(files['config.js']).toMatch(/token:\s*''/);
    }
  });

  it('README tells the user to edit config.js and host anywhere', () => {
    const readme = buildExampleBundle('webrtc-play').files['README.md'];
    expect(readme).toContain('config.js');
    expect(readme.toLowerCase()).toContain('static host');
  });
});

describe('example-bundle — build (per-app context)', () => {
  const ctx: ExampleContext = {
    app: 'acme',
    room: 'lobby',
    baseUrl: 'https://media.acme.io',
    wsUrl: 'wss://media.acme.io',
  };

  it('wires config.js to the app with no placeholders left', () => {
    const cfg = buildExampleBundle('webrtc-play', ctx).files['config.js'];
    expect(cfg).toContain(`app: "acme"`);
    expect(cfg).toContain(`room: "lobby"`);
    expect(cfg).toContain(`baseUrl: "https://media.acme.io"`);
    expect(cfg).toContain(`wsUrl: "wss://media.acme.io"`);
    expect(cfg).not.toContain('your-streamhub.example.com');
  });

  it('index.html bakes the app URLs as the config-absent fallback', () => {
    const html = buildExampleBundle('hls-player', ctx).files['index.html'];
    // Fallback literals resolve to the app (used only if config.js is absent).
    expect(html).toContain("'https://media.acme.io/hls/acme'");
    expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});

describe('example-bundle — buildAllBundles', () => {
  it('returns a bundle for every id', () => {
    const all = buildAllBundles(PLACEHOLDER_CONTEXT);
    expect(Object.keys(all).sort()).toEqual([...IDS].sort());
    for (const id of IDS) {
      expect(Object.keys(all[id])).toContain('index.html');
    }
  });

  it('throws on an unknown id', () => {
    expect(() => buildExampleBundle('nope')).toThrow(/unknown example/);
  });
});
