/**
 * Downloadable, self-contained EXAMPLE bundles.
 *
 * Each shipped sample (see `sample-templates.ts`) can be assembled into a
 * standalone, statically-hostable bundle:
 *
 *   <id>/
 *     index.html   ← the SAME rendered template served at /samples/<app>/<file>
 *     config.js     ← window.STREAMHUB_CONFIG — the knobs a user edits
 *     README.md     ← "edit config.js, host anywhere, done"
 *
 * The bundle and the server-rendered page share the EXACT same template source
 * (`TEMPLATES[file]` via `renderPlaceholders`). The ONLY difference is that the
 * bundle prepends `<script src="./config.js"></script>`, whose
 * `window.STREAMHUB_CONFIG` OVERRIDES the values baked into the page at build
 * time (see the config block in `bootstrap()`). So a user drops the folder on
 * ANY static host (S3, Netlify, nginx, GitHub Pages), edits `config.js` to point
 * at their own StreamHub, and it works — no build step, no server fork.
 *
 * Pure module: no NestJS/fs/network deps, so it is unit-testable and importable
 * from the `scripts/build-examples.mjs` generator (via the compiled dist).
 */
import { SAMPLE_FILES, TEMPLATES, renderPlaceholders } from './sample-templates';
import type { SampleTemplateName } from './sample-templates';

/** Runtime config a user must fill so the bundle points at THEIR StreamHub. */
export interface ExampleContext {
  /** App slug. */
  app: string;
  /** Default room (usually the app's room prefix). */
  room: string;
  /** StreamHub public origin — REST + HLS + SDK. No trailing slash. */
  baseUrl: string;
  /** LiveKit signaling ws URL (wss://…). */
  wsUrl: string;
  /** Optional adaptor SDK URL override (defaults to `${baseUrl}/sdk/…`). */
  adaptorUrl?: string;
}

/**
 * Credential model of an example — drives config.js + README guidance.
 *   - `public`    : subscribe-only; uses the PUBLIC play/listen token (no auth).
 *   - `ephemeral` : joins with a pre-minted ephemeral LiveKit JWT (operator link).
 *   - `publisher` : publishes; accepts an ephemeral token OR an `sk_` apiToken
 *                   (dev only) to mint one.
 */
export type ExampleAuthModel = 'public' | 'ephemeral' | 'publisher';

export interface ExampleDescriptor {
  /** Stable id / folder name (the template filename without `.html`). */
  id: string;
  /** Source template filename in `TEMPLATES`. */
  file: SampleTemplateName;
  /** Short human title. */
  title: string;
  /** One-line description. */
  description: string;
  /** Credential model. */
  authModel: ExampleAuthModel;
  /** Config keys the user MUST set for the bundle to work. */
  requiredConfig: string[];
  /** Extra config keys used by this example (optional). */
  optionalConfig: string[];
}

/** The four config keys every bundle needs. */
const CORE_KEYS = ['baseUrl', 'wsUrl', 'app', 'room'];

/** Credential keys added to config.js by auth model. */
function credentialKeys(model: ExampleAuthModel): string[] {
  if (model === 'ephemeral') return ['token'];
  if (model === 'publisher') return ['token', 'apiToken'];
  return [];
}

/**
 * The canonical example catalogue — one entry per shipped sample. Order matches
 * `SAMPLE_FILES`. An invariant test asserts this stays 1:1 with `SAMPLE_FILES`.
 */
export const EXAMPLE_BUNDLES: ExampleDescriptor[] = [
  {
    id: 'webrtc-publish',
    file: 'webrtc-publish.html',
    title: 'WebRTC publish',
    description: 'Publish camera/mic to a room over WebRTC (low latency).',
    authModel: 'publisher',
    requiredConfig: CORE_KEYS,
    optionalConfig: ['token', 'apiToken', 'adaptorUrl'],
  },
  {
    id: 'webrtc-play',
    file: 'webrtc-play.html',
    title: 'WebRTC play',
    description: 'Subscribe/play a live room over WebRTC (low latency).',
    authModel: 'public',
    requiredConfig: CORE_KEYS,
    optionalConfig: ['adaptorUrl'],
  },
  {
    id: 'hls-player',
    file: 'hls-player.html',
    title: 'HLS player',
    description: 'video.js HLS player for a room (higher latency, CDN-friendly).',
    authModel: 'public',
    requiredConfig: CORE_KEYS,
    optionalConfig: [],
  },
  {
    id: 'audio-radio',
    file: 'audio-radio.html',
    title: 'Radio (master + listener)',
    description: 'Audio radio: master goes on air with the mic; listeners tune in.',
    authModel: 'publisher',
    requiredConfig: CORE_KEYS,
    optionalConfig: ['token', 'apiToken', 'adaptorUrl'],
  },
  {
    id: 'cctv-grid',
    file: 'cctv-grid.html',
    title: 'CCTV grid',
    description: 'Low-latency grid of N live cameras (comma-separated rooms).',
    authModel: 'public',
    requiredConfig: CORE_KEYS,
    optionalConfig: ['adaptorUrl'],
  },
  {
    id: 'live-shopping',
    file: 'live-shopping.html',
    title: 'Live shopping',
    description: 'WebRTC viewer + chat/reactions data channel + buy button.',
    authModel: 'public',
    requiredConfig: CORE_KEYS,
    optionalConfig: ['token', 'adaptorUrl'],
  },
  {
    id: 'telemedicine',
    file: 'telemedicine.html',
    title: 'Telemedicine 1:1',
    description: 'Private 1:1 room joined with a pre-minted ephemeral token.',
    authModel: 'ephemeral',
    requiredConfig: CORE_KEYS,
    optionalConfig: ['token', 'adaptorUrl'],
  },
  {
    id: 'radio-player',
    file: 'radio-player.html',
    title: 'Radio player',
    description: 'Embeddable audio-only listener on the public listen token.',
    authModel: 'public',
    requiredConfig: CORE_KEYS,
    optionalConfig: ['adaptorUrl'],
  },
  {
    id: 'conference',
    file: 'conference.html',
    title: 'Conference (N-to-N)',
    description: 'Google-Meet-style meeting: pre-join, tiles, screen share, chat.',
    authModel: 'publisher',
    requiredConfig: CORE_KEYS,
    optionalConfig: ['token', 'apiToken', 'adaptorUrl'],
  },
];

/**
 * Generic placeholder context for the committed `examples/` folder and the
 * default endpoint fallback. Deliberately contains NO real host/tenant — the
 * user replaces these in config.js.
 */
export const PLACEHOLDER_CONTEXT: ExampleContext = {
  app: 'YOUR_APP',
  room: 'demo',
  baseUrl: 'https://your-streamhub.example.com',
  wsUrl: 'wss://your-streamhub.example.com',
};

export function getExample(id: string): ExampleDescriptor | undefined {
  return EXAMPLE_BUNDLES.find((e) => e.id === id);
}

/** Map an ExampleContext to the `{{PLACEHOLDER}}` values a template expects. */
function placeholderMap(ctx: ExampleContext): Record<string, string> {
  const base = (ctx.baseUrl || '').replace(/\/+$/, '');
  return {
    APP: ctx.app,
    ROOM: ctx.room,
    WS_URL: ctx.wsUrl,
    API_URL: `${base}/api/v1`,
    ADAPTOR_URL: ctx.adaptorUrl || `${base}/sdk/streamhub-adaptor.global.js`,
    HLS_URL: `${base}/hls/${ctx.app}`,
  };
}

/** Config-loader script tag injected into the standalone index.html. */
export const CONFIG_SCRIPT_TAG = '<script src="./config.js"></script>';

/**
 * Turn a rendered template into a standalone index.html by loading `config.js`
 * BEFORE any other script (so `window.STREAMHUB_CONFIG` is set before the
 * page's config block reads it). Deterministic single-shot injection before the
 * first `<script` tag.
 */
function toStandaloneHtml(renderedHtml: string): string {
  const idx = renderedHtml.indexOf('<script');
  if (idx === -1) return `${renderedHtml}\n${CONFIG_SCRIPT_TAG}\n`;
  return (
    renderedHtml.slice(0, idx) +
    `${CONFIG_SCRIPT_TAG}\n` +
    renderedHtml.slice(idx)
  );
}

function j(v: string): string {
  return JSON.stringify(v);
}

/** Build the `config.js` for one example (the ONLY file a user edits). */
export function buildConfigJs(
  d: ExampleDescriptor,
  ctx: ExampleContext,
): string {
  const creds = credentialKeys(d.authModel);
  const lines: string[] = [];
  lines.push('// StreamHub example configuration — EDIT THIS FILE.');
  lines.push('//');
  lines.push(`// Example: ${d.title} — ${d.description}`);
  lines.push('//');
  lines.push('// Point this bundle at YOUR StreamHub. Nothing else needs to');
  lines.push('// change: host this folder on any static host (S3, Netlify, nginx,');
  lines.push('// GitHub Pages) and open index.html.');
  lines.push('window.STREAMHUB_CONFIG = {');
  lines.push(`  // StreamHub public origin (REST + HLS + SDK). No trailing slash.`);
  lines.push(`  baseUrl: ${j(ctx.baseUrl)},`);
  lines.push(`  // LiveKit signaling WebSocket URL (wss://…).`);
  lines.push(`  wsUrl: ${j(ctx.wsUrl)},`);
  lines.push(`  // Your app slug.`);
  lines.push(`  app: ${j(ctx.app)},`);
  lines.push(`  // Default room name.`);
  lines.push(`  room: ${j(ctx.room)},`);
  if (creds.includes('token')) {
    lines.push('');
    lines.push('  // Ephemeral LiveKit JWT for publishing/joining. Mint it');
    lines.push('  // server-side and paste it here, OR pass it in the URL hash');
    lines.push('  // (#token=…). Leave empty for subscribe-only usage.');
    lines.push(`  token: '',`);
  }
  if (creds.includes('apiToken')) {
    lines.push('');
    lines.push('  // DEV ONLY: an sk_ management token to mint LiveKit tokens on');
    lines.push('  // the fly. Never ship this to end users — prefer `token` above.');
    lines.push(`  apiToken: '',`);
  }
  lines.push('');
  lines.push('  // Optional: override the adaptor SDK URL (defaults to');
  lines.push('  // baseUrl + "/sdk/streamhub-adaptor.global.js").');
  lines.push(`  // adaptorUrl: '',`);
  lines.push('};');
  lines.push('');
  return lines.join('\n');
}

const AUTH_NOTE: Record<ExampleAuthModel, string> = {
  public:
    'This example is **subscribe-only** and uses the PUBLIC play/listen token — ' +
    'no credential needed, as long as the app has public playback enabled.',
  ephemeral:
    'This example joins a private room with a **pre-minted ephemeral LiveKit ' +
    'JWT**. Mint one server-side (per participant) and either paste it into ' +
    '`config.js` (`token`) or share a link with `#token=…&room=…&ws=…`.',
  publisher:
    'This example **publishes** media. Supply an ephemeral LiveKit JWT ' +
    '(`config.js` `token`, or `#token=…` in the URL). For local dev you may ' +
    'instead set `apiToken` to an `sk_` management token to mint on the fly — ' +
    'never expose that token to end users.',
};

/** Build the per-bundle README.md. */
export function buildReadme(d: ExampleDescriptor, ctx: ExampleContext): string {
  const remote = ctx === PLACEHOLDER_CONTEXT || ctx.baseUrl.includes('example.com');
  return `# StreamHub example — ${d.title}

${d.description}

## Run it

1. Edit **\`config.js\`** and set \`baseUrl\`, \`wsUrl\`, \`app\` and \`room\` to your
   StreamHub instance.${remote ? ' (They currently hold placeholders.)' : ''}
2. Host this folder on **any static host** — S3, Netlify, nginx, GitHub Pages —
   or just open \`index.html\` locally.
3. Done. No build step.

## Files

| File | Purpose |
|------|---------|
| \`index.html\` | The example (identical to the page served at \`/samples/${ctx.app}/${d.file}\`). |
| \`config.js\` | The knobs you edit. Sets \`window.STREAMHUB_CONFIG\`. |

## Authentication

${AUTH_NOTE[d.authModel]}

## Notes

- \`index.html\` loads the **livekit-client** from a pinned CDN
  (\`livekit-client@2.15.7\`) and the optional **streamhub-adaptor** from your own
  StreamHub (\`baseUrl + /sdk/…\`); it falls back to livekit-client if the adaptor
  is not deployed. You may self-host either — see \`adaptorUrl\` in \`config.js\`.
- **CORS:** the browser fetches the play/listen token from \`baseUrl/api/v1/…\`.
  A remote static host is a *different origin*, so your StreamHub must allow
  cross-origin reads on the public token endpoints (StreamHub sends
  \`Access-Control-Allow-Origin: *\` on \`play-token\`/\`listen-token\`). Same-origin
  hosting (serving the bundle from the StreamHub domain) needs no CORS.
`;
}

/** The assembled files of one example bundle (filename → UTF-8 text). */
export type BundleFiles = Record<string, string>;

/**
 * Build the standalone bundle for one example id. Pure: returns the files as
 * strings; the caller decides where/how to persist or zip them.
 */
export function buildExampleBundle(
  id: string,
  ctx: ExampleContext = PLACEHOLDER_CONTEXT,
): { descriptor: ExampleDescriptor; files: BundleFiles } {
  const d = getExample(id);
  if (!d) throw new Error(`unknown example "${id}"`);
  const rendered = renderPlaceholders(TEMPLATES[d.file], placeholderMap(ctx));
  const indexHtml = toStandaloneHtml(rendered);
  return {
    descriptor: d,
    files: {
      'index.html': indexHtml,
      'config.js': buildConfigJs(d, ctx),
      'README.md': buildReadme(d, ctx),
    },
  };
}

/** Build every example bundle, keyed by id (for a combined zip / examples dir). */
export function buildAllBundles(
  ctx: ExampleContext = PLACEHOLDER_CONTEXT,
): Record<string, BundleFiles> {
  const out: Record<string, BundleFiles> = {};
  for (const d of EXAMPLE_BUNDLES) out[d.id] = buildExampleBundle(d.id, ctx).files;
  return out;
}

/** Sanity check kept next to the data: catalogue stays 1:1 with SAMPLE_FILES. */
export const EXAMPLE_IDS: string[] = EXAMPLE_BUNDLES.map((e) => e.id);
export const EXPECTED_SAMPLE_FILES: readonly string[] = SAMPLE_FILES;
