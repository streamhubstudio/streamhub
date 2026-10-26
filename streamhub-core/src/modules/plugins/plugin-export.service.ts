/**
 * STUDIO APP EXPORTER — turns an installed, exportable Studio App into a
 * self-contained tarball an operator can run on their OWN infra and point back
 * at any StreamHub over HTTPS.
 *
 * `GET /apps/:app/plugins/:id/export` → `application/gzip`
 * `streamhub-app-<id>-<version>.tar.gz`, layout:
 *
 *   <id>/
 *     worker/            ← verbatim copy of the repo-root worker package
 *     Dockerfile         ← generated (python:3.11-slim + requirements + CMD)
 *     docker-compose.yml ← generated (one service, env_file .env)
 *     .env.example       ← every env var worker.spawn() injects, as PLACEHOLDERS
 *     README.md          ← generated quickstart + how it talks back
 *     LICENSE            ← repo license (best-effort)
 *
 * The env list is derived by CALLING the meta's PURE `worker.spawn(ctx)` with a
 * SYNTHETIC context (placeholder app/dirs/config defaults) and reading the
 * returned `env` keys — so there is NO per-plugin export code, and real
 * tokens/secrets/hostnames from the live install are NEVER embedded (secrets
 * blanked, `*_PUBLIC_BASE` forced to a placeholder host).
 *
 * The bundle is packed with a tiny, dependency-free USTAR writer over Node's
 * built-in zlib (deterministic: fixed mtime/uid/gid) — no `tar` dependency and
 * no better-sqlite3 involvement (a Studio App's `.db` is never opened or copied).
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import {
  APPS_SERVICE,
  AppsServiceContract,
  LOGS_SERVICE,
  LogsServiceContract,
} from '../../shared/contracts';
import { AppPluginsRepository } from './app-plugins.repository';
import { defaultConfig } from './plugin-config.util';
import {
  PluginMeta,
  PluginWorkerContext,
  toManifest,
} from './plugin.contract';
import { PluginRegistryService } from './plugin-registry.service';

/** One file in the export bundle. */
export interface TarEntry {
  /** Full path inside the archive (e.g. `lpr/worker/requirements.txt`). */
  name: string;
  body: Buffer;
  /** Unix mode; defaults to 0o644. */
  mode?: number;
}

/** Placeholder tenant used to render the synthetic spawn context. */
const PLACEHOLDER_APP = 'myapp';
/** Placeholder StreamHub origin — NEVER the live install's real host. */
const PLACEHOLDER_PUBLIC_BASE = 'https://your-streamhub.example.com';
const PLACEHOLDER_LIVEKIT = 'wss://your-streamhub.example.com:7880';

/** Skip whole directories that are build/cache/VCS noise, never worker source. */
const EXCLUDED_DIRS = new Set([
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.git',
  '.venv',
  'venv',
  'env',
  'node_modules',
  '.idea',
  '.vscode',
  'build',
  'dist',
]);

/** Files never bundled: compiled python, any SQLite db, OS junk. */
function isExcludedFile(name: string): boolean {
  if (name === '.DS_Store') return true;
  if (/\.py[cod]$/.test(name)) return true;
  if (/\.db(-journal|-wal|-shm)?$/.test(name)) return true;
  return false;
}

/** Anything bigger than this is treated as a model/weights binary and skipped. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Env keys that must be blanked regardless of their config-field type. */
const SECRET_KEY_RE =
  /secret|token|password|passwd|credential|api[_-]?key|apikey|private[_-]?key/i;

@Injectable()
export class PluginExportService {
  constructor(
    private readonly registry: PluginRegistryService,
    private readonly repo: AppPluginsRepository,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
    @Inject(LOGS_SERVICE) private readonly logs: LogsServiceContract,
  ) {}

  /**
   * Produce the gzip tarball for an INSTALLED, EXPORTABLE app. Guards mirror the
   * design: 404 app/plugin unknown, 400 not-exportable or not-installed, 503
   * when the worker source cannot be located. Audit-logged like the other
   * config-write operations on the plugin.
   */
  async export(
    app: string,
    id: string,
  ): Promise<{ filename: string; body: Buffer }> {
    const appRec = await this.apps.get(app);
    if (!appRec) throw new NotFoundException(`app '${app}' not found`);

    const meta = this.registry.getMeta(id);
    if (!meta) throw new NotFoundException(`plugin '${id}' not found`);

    const manifest = toManifest(meta);
    if (!manifest.exportable) {
      throw new BadRequestException(`plugin '${id}' is not exportable`);
    }
    if (!this.repo.get(app, id)) {
      throw new BadRequestException(
        `plugin '${id}' is not installed in app '${app}'`,
      );
    }

    const srcDir = resolveWorkerDir(meta.export!.workerDir!, meta.id);
    if (!srcDir) {
      throw new ServiceUnavailableException(
        `worker source for '${id}' not found — set STREAMHUB_WORKER_SRC_ROOT or ` +
          'run from a repo checkout',
      );
    }

    const entries = composePluginBundle(meta, id, srcDir);
    const body = packTarGz(entries);
    const filename = `streamhub-app-${id}-${manifest.version}.tar.gz`;

    this.logs.write(
      'info',
      `plugin:${id}`,
      `exported standalone app bundle from '${app}' (${filename}, ${body.length} bytes)`,
      { app },
      appRec.id,
    );
    return { filename, body };
  }
}

// =============================================================================
// Bundle composition (pure — no DI, no install guards). Exported for unit tests.
// =============================================================================

/**
 * Build the ordered list of bundle entries for `meta` given its worker SOURCE
 * dir. Deterministic: worker files are walked in sorted order, then the
 * generated files in a fixed order. Reads only from `srcDir` (+ the repo
 * LICENSE); opens no database.
 */
export function composePluginBundle(
  meta: PluginMeta,
  id: string,
  srcDir: string,
): TarEntry[] {
  const spec = meta.worker!.spawn(syntheticCtx(meta));
  const workerModule = deriveModule(spec.args ?? [], id);

  const entries: TarEntry[] = collectWorkerFiles(srcDir, id);
  entries.push(text(`${id}/Dockerfile`, generateDockerfile(workerModule)));
  entries.push(text(`${id}/docker-compose.yml`, generateCompose(id)));
  entries.push(text(`${id}/.env.example`, generateEnvExample(meta, id, spec.env ?? {})));
  entries.push(
    text(`${id}/README.md`, generateReadme(meta, id, workerModule, spec.env ?? {})),
  );

  const license = resolveRepoLicense(srcDir);
  if (license) entries.push({ name: `${id}/LICENSE`, body: license });

  return entries;
}

/** The synthetic spawn context — placeholder tenant/dirs + schema defaults. */
function syntheticCtx(meta: PluginMeta): PluginWorkerContext {
  return {
    app: PLACEHOLDER_APP,
    config: defaultConfig(meta),
    appDir: `/data/apps/${PLACEHOLDER_APP}`,
    dataDir: '/data',
    livekitUrl: PLACEHOLDER_LIVEKIT,
  };
}

/** The python module the worker runs, from `python -m <module>` spawn args. */
function deriveModule(args: string[], id: string): string {
  const i = args.indexOf('-m');
  if (i >= 0 && args[i + 1]) return args[i + 1];
  // Fallback: the conventional package name (people-counter → people_counter_worker).
  return `${id.replace(/-/g, '_')}_worker`;
}

/** Recursively collect worker files into `<id>/worker/**`, sorted, filtered. */
function collectWorkerFiles(srcDir: string, id: string): TarEntry[] {
  const out: TarEntry[] = [];
  const walk = (abs: string, rel: string): void => {
    const dirents = fs
      .readdirSync(abs, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirents) {
      if (d.isDirectory()) {
        if (EXCLUDED_DIRS.has(d.name) || d.name.endsWith('.egg-info')) continue;
        walk(path.join(abs, d.name), rel ? `${rel}/${d.name}` : d.name);
      } else if (d.isFile()) {
        if (isExcludedFile(d.name)) continue;
        const full = path.join(abs, d.name);
        const st = fs.statSync(full);
        // Skip model/weights binaries so the bundle stays source-only + light.
        if (st.size > MAX_FILE_BYTES) continue;
        const name = `${id}/worker/${rel ? `${rel}/` : ''}${d.name}`;
        out.push({ name, body: fs.readFileSync(full) });
      }
      // symlinks / sockets / etc. are ignored.
    }
  };
  walk(srcDir, '');
  return out;
}

// ---- generated files --------------------------------------------------------

function generateDockerfile(workerModule: string): string {
  return `# Auto-generated by StreamHub Studio export — standalone worker image.
# Rebuild after editing worker/ or worker/requirements.txt.
FROM python:3.11-slim

WORKDIR /app

# Runtime libs the CV workers rely on: glib for opencv-python-headless, ffmpeg
# for HLS reads + evidence clips, ca-certificates for HTTPS callbacks.
RUN apt-get update && apt-get install -y --no-install-recommends \\
        ca-certificates ffmpeg libglib2.0-0 \\
    && rm -rf /var/lib/apt/lists/*

# Dependencies first so the heavy pip layer stays cached across code edits.
COPY worker/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --upgrade pip \\
    && pip install --no-cache-dir -r requirements.txt

# Worker source.
COPY worker/ ./

CMD ["python", "-m", "${workerModule}"]
`;
}

function generateCompose(id: string): string {
  return `# Auto-generated by StreamHub Studio export.
# Copy .env.example to .env, fill it in, then: docker compose up --build
services:
  ${id}:
    build: .
    env_file: .env
    restart: unless-stopped
`;
}

/**
 * Render `.env.example` from the keys the meta's `worker.spawn()` injects, as
 * SAFE PLACEHOLDERS. Secrets and `*_HLS_DIR` are blanked; `*_PUBLIC_BASE` points
 * at a placeholder host; config-derived non-secret defaults are kept; two
 * framework identity vars are appended.
 */
function generateEnvExample(
  meta: PluginMeta,
  id: string,
  env: Record<string, string>,
): string {
  const lines: string[] = [
    `# .env.example — ${meta.name} (standalone worker exported from StreamHub Studio)`,
    '#',
    '# Copy to .env and fill in the blanks. NEVER commit your real .env.',
    '# Every value below is a placeholder — no real host, token or secret is embedded.',
    '',
    '# --- Framework identity ---',
    `STREAMHUB_APP=${PLACEHOLDER_APP}`,
    `STREAMHUB_PLUGIN_ID=${id}`,
    '',
    '# --- Worker configuration ---',
  ];

  for (const [key, rawValue] of Object.entries(env)) {
    const { value, comment } = classifyEnv(key, rawValue);
    if (comment) lines.push(`# ${comment}`);
    lines.push(`${key}=${value}`);
  }
  lines.push('');
  return scrubHostnames(lines.join('\n'));
}

/** Decide the exported placeholder value + comment for one spawn env key. */
function classifyEnv(
  key: string,
  value: string,
): { value: string; comment?: string } {
  if (key === 'PYTHONPATH') {
    return { value: '/app', comment: 'Container workdir holding the worker package.' };
  }
  if (key.endsWith('_HLS_DIR')) {
    return {
      value: '',
      comment:
        'Off-host: leave EMPTY so the worker falls back to *_PUBLIC_BASE. The ' +
        'shared HLS disk only exists on the StreamHub host, not on yours.',
    };
  }
  if (key.endsWith('_PUBLIC_BASE')) {
    return {
      value: PLACEHOLDER_PUBLIC_BASE,
      comment:
        'Base URL of the StreamHub server this worker pulls HLS from ' +
        '(it appends /hls/<app>/<room>/index.m3u8).',
    };
  }
  if (key.endsWith('_LIVEKIT_URL')) {
    return {
      value: PLACEHOLDER_LIVEKIT,
      comment:
        'Only needed if the worker subscribes to LiveKit directly; HLS is the ' +
        'normal input.',
    };
  }
  if (key.endsWith('_CALLBACK_URL')) {
    return {
      value: '',
      comment:
        'Your HTTPS endpoint to receive this app’s events (POST). See the ' +
        'README for the X-StreamHub-Signature HMAC plane.',
    };
  }
  if (key.endsWith('_CALLBACK_SECRET')) {
    return {
      value: '',
      comment:
        'Shared secret: events are signed X-StreamHub-Signature: sha256=<HMAC-' +
        'SHA256 of the raw body>. Set your own; verify it on your endpoint.',
    };
  }
  if (SECRET_KEY_RE.test(key)) {
    return { value: '', comment: 'Secret — set your own; never commit it.' };
  }
  return { value };
}

/** Belt-and-suspenders: strip the live install's real origin if it leaked in. */
function scrubHostnames(text: string): string {
  const real = (process.env.PUBLIC_BASE_URL ?? '').trim();
  if (real && real !== PLACEHOLDER_PUBLIC_BASE) {
    return text.split(real).join(PLACEHOLDER_PUBLIC_BASE);
  }
  return text;
}

function generateReadme(
  meta: PluginMeta,
  id: string,
  workerModule: string,
  env: Record<string, string>,
): string {
  const keys = Object.keys(env);
  const publicBaseKey = keys.find((k) => k.endsWith('_PUBLIC_BASE'));
  const callbackUrlKey = keys.find((k) => k.endsWith('_CALLBACK_URL'));
  const callbackSecretKey = keys.find((k) => k.endsWith('_CALLBACK_SECRET'));

  const talkBack = callbackSecretKey
    ? `Set **${callbackUrlKey}** to your HTTPS endpoint and **${callbackSecretKey}** to a
shared secret. Every event is POSTed to that URL and signed:

    X-StreamHub-Signature: sha256=<HMAC-SHA256 of the raw request body, hex>

Verify it on your side with the same secret before trusting the payload.`
    : callbackUrlKey
      ? `Set **${callbackUrlKey}** to your HTTPS endpoint. Events are POSTed there as
raw JSON. (Running standalone this direct POST is unsigned; the *signed*
webhook + MQTT fan-out is a StreamHub-framework feature that applies only when
the worker runs co-located inside a StreamHub install.)`
      : `This worker feeds its results back through the StreamHub framework live/events
channel, which only applies when it runs co-located inside a StreamHub install.
Standalone, wire your own sink in \`worker/\` (see *Extending* below).`;

  const pointAt = publicBaseKey
    ? `Point **${publicBaseKey}** at your StreamHub origin (e.g.
\`${PLACEHOLDER_PUBLIC_BASE}\`) and leave the \`*_HLS_DIR\` variable empty — the
worker pulls \`/hls/<app>/<room>/index.m3u8\` over HTTPS. No shared disk or
loopback is required, so this runs anywhere with network access to your server.`
    : `Point the worker at your StreamHub origin over HTTPS (see \`.env.example\`).`;

  return `# ${meta.name} — standalone worker

> Exported from **StreamHub Studio** as a self-contained app. Run it on your own
> infrastructure and point it back at any StreamHub over HTTPS.

${meta.description}

## What's in here

    ${id}/
      worker/            the Python worker package (source + requirements.txt + tests)
      Dockerfile         python:3.11-slim + requirements + \`python -m ${workerModule}\`
      docker-compose.yml one service, reads .env
      .env.example       every setting, as safe placeholders
      README.md          this file
      LICENSE            the project license

## Quickstart

    cp .env.example .env
    # edit .env — set the StreamHub origin, room, and (optionally) your callback
    docker compose up --build

That builds the image and starts the worker. Logs stream to stdout.

## Pointing it at your StreamHub

${pointAt}

## How it talks back

${talkBack}

## Configuration

Open \`.env.example\`: it lists every variable the worker reads, with a comment
on each. Placeholders are safe to commit; your filled-in \`.env\` is not.

## Extending

The worker is plain Python — edit files under \`worker/\`, add dependencies to
\`worker/requirements.txt\`, and rebuild (\`docker compose up --build\`). Its tests
live in \`worker/tests\` (\`pytest\`).

## License

See \`LICENSE\`. StreamHub components are AGPL-3.0-only unless noted otherwise in
the worker's own README.
`;
}

// ---- source resolution ------------------------------------------------------

/**
 * Resolve a worker SOURCE dir. Order: the VENDORED package's own worker (when
 * `pluginId` names a composed decoupled app — version-pinned by apps.lock.json,
 * so it beats any stale operator copy) → `STREAMHUB_WORKER_SRC_ROOT/<dir>` →
 * `/opt/worker-src/<dir>` → repo-root (dev / bare-node). Returns null if none
 * is a directory.
 */
export function resolveWorkerDir(
  workerDir: string,
  pluginId?: string,
): string | null {
  const candidates: string[] = [];
  // Composed decoupled app: apps-pull copies the worker INSIDE the vendored
  // package (plugins-vendor/<id>/worker — dist/ at runtime, src/ under ts-jest).
  if (pluginId) {
    candidates.push(
      path.resolve(__dirname, '..', '..', 'plugins-vendor', pluginId, 'worker'),
    );
  }
  const root = process.env.STREAMHUB_WORKER_SRC_ROOT;
  if (root) candidates.push(path.join(root, workerDir));
  candidates.push(path.join('/opt/worker-src', workerDir));
  // From dist/modules/plugins (or src/modules/plugins under ts-jest), climb 4
  // to the repo root — the same anchor the plugin metas use for their workers.
  candidates.push(path.resolve(__dirname, '..', '..', '..', '..', workerDir));
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Best-effort repo LICENSE, checked alongside the worker-src roots + repo root. */
function resolveRepoLicense(srcDir: string): Buffer | null {
  const candidates: string[] = [];
  const root = process.env.STREAMHUB_WORKER_SRC_ROOT;
  if (root) candidates.push(path.join(root, 'LICENSE'));
  candidates.push('/opt/worker-src/LICENSE');
  candidates.push(path.join(srcDir, '..', 'LICENSE')); // repo-root sibling
  candidates.push(path.resolve(__dirname, '..', '..', '..', '..', 'LICENSE'));
  for (const c of candidates) {
    try {
      const st = fs.statSync(c);
      if (st.isFile() && st.size <= MAX_FILE_BYTES) return fs.readFileSync(c);
    } catch {
      /* try next */
    }
  }
  return null;
}

// =============================================================================
// Minimal, deterministic USTAR + gzip writer (no external `tar` dependency).
// =============================================================================

function text(name: string, body: string): TarEntry {
  return { name, body: Buffer.from(body, 'utf8') };
}

/** Pack entries into a gzipped USTAR archive. Deterministic (mtime/uid/gid=0). */
export function packTarGz(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    blocks.push(tarHeader(e));
    blocks.push(e.body);
    const rem = e.body.length % 512;
    if (rem !== 0) blocks.push(Buffer.alloc(512 - rem, 0));
  }
  blocks.push(Buffer.alloc(1024, 0)); // two zero blocks terminate the archive
  return zlib.gzipSync(Buffer.concat(blocks), { level: 9 });
}

/** One 512-byte USTAR header block for a regular file. */
function tarHeader(entry: TarEntry): Buffer {
  const h = Buffer.alloc(512, 0);
  const { name, prefix } = splitName(entry.name);
  h.write(name, 0, 100, 'utf8');
  writeOctal(h, 100, 8, entry.mode ?? 0o644);
  writeOctal(h, 108, 8, 0); // uid
  writeOctal(h, 116, 8, 0); // gid
  writeOctal(h, 124, 12, entry.body.length);
  writeOctal(h, 136, 12, 0); // mtime — fixed for determinism
  h.fill(' ', 148, 156); // checksum placeholder (8 spaces)
  h.write('0', 156, 1, 'ascii'); // typeflag: regular file
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  if (prefix) h.write(prefix, 345, 155, 'utf8');

  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  const cs = sum.toString(8).padStart(6, '0');
  h.write(cs, 148, 6, 'ascii');
  h.write('\0', 154, 1, 'ascii');
  h.write(' ', 155, 1, 'ascii');
  return h;
}

/** Write `value` as a NUL-terminated, zero-padded octal field. */
function writeOctal(buf: Buffer, offset: number, len: number, value: number): void {
  const s = value.toString(8).padStart(len - 1, '0');
  buf.write(s, offset, len - 1, 'ascii');
  buf.write('\0', offset + len - 1, 1, 'ascii');
}

/**
 * Split a path into USTAR name(≤100)/prefix(≤155). Short names go verbatim;
 * longer ones split on a '/' boundary. Throws if it cannot fit (no bundle path
 * comes close, but fail loud rather than truncate).
 */
function splitName(full: string): { name: string; prefix: string } {
  if (Buffer.byteLength(full) <= 100) return { name: full, prefix: '' };
  const parts = full.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    const prefix = parts.slice(0, i + 1).join('/');
    const name = parts.slice(i + 1).join('/');
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) {
      return { name, prefix };
    }
  }
  throw new Error(`path too long for tar: ${full}`);
}
