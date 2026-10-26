/**
 * DECLARATIVE SPAWN-TEMPLATE INTERPRETER — the security cornerstone of the
 * app-decoupling work (internal design notes §3).
 *
 * A REMOTE / vendored Studio App package ships NO executable JavaScript for the
 * core. Instead of a `worker.spawn(ctx)` CLOSURE, its manifest declares the
 * worker as a pure DATA template:
 *
 *   { "entry": "{{pluginPython}} -m lpr_worker --app {{app}}",
 *     "cwd":   "{{workerDir}}",
 *     "env":   { "PYTHONPATH": "{{workerDir}}", "LPR_DEVICE": "{{ config.cuda | ternary:cuda:cpu }}", … } }
 *
 * `interpretWorkerTemplate` turns that template + a PluginWorkerContext into the
 * SAME `PluginWorkerSpec` a code-based meta would return — but by pure string
 * substitution over a tiny, non-Turing-complete grammar. The core never `eval`s
 * or `require`s anything a package carries, so a malicious package can only
 * choose the STRINGS of its own subprocess env/args, never run arbitrary JS
 * inside the core process.
 *
 * GRAMMAR (inside `{{ … }}`):
 *   - refs:      app appDir dataDir livekitUrl originUrl publicBase workerDir
 *                pluginPython configJson  config.<key>  env.<NAME>
 *                'literal' / "literal"
 *   - coalesce:  ref ?? ref ?? 'fallback'   (first non-empty wins)
 *   - filters:   ref | ternary:<then>:<else>        (truthy → then, else → else)
 *                ref | map:k=v,k=v,*=default         (table lookup, * = default)
 * Text outside `{{ }}` is literal; a template may embed many placeholders
 * (e.g. "{{appDir}}/lpr"). See spawn-template.spec.ts for the full behavior and
 * the lpr/presence fidelity fixtures that lock it to the real metas' output.
 */
import type {
  PluginWorkerContext,
  PluginWorkerSpec,
} from './plugin.contract';

/** The worker block of an app manifest (see app-manifest.ts). */
export interface AppManifestWorker {
  needsWorker?: boolean;
  /**
   * Command line as ONE string, whitespace-tokenized into [command, ...args]
   * BEFORE placeholder substitution (so a substituted value can never inject an
   * extra argument). Either `entry` OR `command`+`args` must be present.
   */
  entry?: string;
  /** Explicit command (alternative to `entry`). */
  command?: string;
  /** Explicit args (alternative to `entry`). Each token is a template. */
  args?: string[];
  /** Working directory template (defaults to `{{workerDir}}`). */
  cwd?: string;
  /** Env map: key → template string. */
  env?: Record<string, string>;
  /** Worker source dir (package-relative or absolute). Resolved by the caller. */
  workerDir?: string;
  /** Same placement/grid/edge semantics as a code-based worker descriptor. */
  placement?: 'local' | 'grid';
  grid?: {
    gpu?: boolean;
    minVramGb?: number;
    capabilities?: string[];
    regions?: string[];
  };
  edge?: boolean;
  /** Path to the worker's requirements.txt (informational; used by export/CI). */
  requirements?: string;
}

/** Everything the interpreter needs beyond the runtime PluginWorkerContext. */
export interface SpawnTemplateOptions {
  /** Absolute worker source dir → `{{workerDir}}`. Required. */
  workerDir: string;
  /** `{{pluginPython}}` — defaults to `env.PLUGIN_PYTHON ?? 'python3'`. */
  pluginPython?: string;
  /** `{{publicBase}}` — defaults to `env.PUBLIC_BASE_URL ?? ''`. */
  publicBase?: string;
  /**
   * Process environment the `env.<NAME>` refs (and the pluginPython/publicBase
   * defaults) read from. Defaults to `process.env`; injectable for tests.
   */
  env?: NodeJS.ProcessEnv;
}

/** Stringify a config value EXACTLY like `String(...)` does in the code metas. */
export function stringifyConfigValue(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/** Truthiness for `ternary`: '', 'false', '0' are falsy — everything else true. */
function isTruthyToken(value: string): boolean {
  return value !== '' && value !== 'false' && value !== '0';
}

/**
 * Resolve a single REF (no filter, no coalesce). A quoted literal yields its
 * content; a path yields its value ('' when absent). Never throws — an unknown
 * ref resolves to '' so a template typo degrades to empty rather than crashing.
 */
function resolveRef(
  ref: string,
  ctx: PluginWorkerContext,
  opts: Required<Pick<SpawnTemplateOptions, 'workerDir'>> & SpawnTemplateOptions,
): string {
  const r = ref.trim();
  if (!r) return '';
  // Quoted literal.
  if (
    (r.startsWith("'") && r.endsWith("'")) ||
    (r.startsWith('"') && r.endsWith('"'))
  ) {
    return r.slice(1, -1);
  }
  const env = opts.env ?? process.env;
  if (r.startsWith('config.')) {
    return stringifyConfigValue(ctx.config?.[r.slice('config.'.length)]);
  }
  if (r.startsWith('env.')) {
    return String(env[r.slice('env.'.length)] ?? '');
  }
  switch (r) {
    case 'app':
      return ctx.app ?? '';
    case 'appDir':
      return ctx.appDir ?? '';
    case 'dataDir':
      return ctx.dataDir ?? '';
    case 'livekitUrl':
      return ctx.livekitUrl ?? '';
    case 'originUrl':
      return ctx.originUrl ?? '';
    case 'publicBase':
      return opts.publicBase ?? String(env.PUBLIC_BASE_URL ?? '');
    case 'workerDir':
      return opts.workerDir;
    case 'pluginPython':
      return opts.pluginPython ?? String(env.PLUGIN_PYTHON ?? 'python3');
    case 'configJson':
      return JSON.stringify(ctx.config ?? {});
    default:
      return '';
  }
}

/** Apply the optional `ternary:` / `map:` / `localOnly` filter to a resolved source value. */
function applyFilter(value: string, filter: string, remote: boolean): string {
  const trimmed = filter.trim();
  const colon = trimmed.indexOf(':');
  const name = (colon === -1 ? trimmed : trimmed.slice(0, colon)).trim();
  const rest = colon === -1 ? '' : trimmed.slice(colon + 1);

  if (name === 'localOnly') {
    // SECURITY filter: the value renders ONLY for a co-located (local) spawn
    // and is withheld (empty) whenever the context is REMOTE (edge/grid — the
    // resolver set ctx.originUrl or ctx.node). This is how a declarative
    // manifest expresses "this secret never rides an edge frame" (e.g. the
    // demography vision app's ai_api_key) — the structural equivalent of a
    // code spawn's remote branch simply omitting the key.
    return remote ? '' : value;
  }
  if (name === 'ternary') {
    // ternary:<then>:<else>
    const sep = rest.indexOf(':');
    const thenV = (sep === -1 ? rest : rest.slice(0, sep)).trim();
    const elseV = sep === -1 ? '' : rest.slice(sep + 1).trim();
    return isTruthyToken(value) ? thenV : elseV;
  }
  if (name === 'map') {
    // map:k=v,k=v,*=default
    const table = new Map<string, string>();
    for (const pair of rest.split(',')) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      table.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return table.get(value) ?? table.get('*') ?? '';
  }
  // Unknown filter → pass the value through unchanged (fail open on the value,
  // never crash the spawn over a manifest typo).
  return value;
}

/** Evaluate the body of ONE `{{ … }}` placeholder to its string value. */
function evalExpr(
  body: string,
  ctx: PluginWorkerContext,
  opts: SpawnTemplateOptions & { workerDir: string },
): string {
  // Split a single optional filter off the tail (`source | filter`).
  const pipe = body.indexOf('|');
  const sourceExpr = (pipe === -1 ? body : body.slice(0, pipe)).trim();
  const filter = pipe === -1 ? null : body.slice(pipe + 1);

  // Coalesce chain: first non-empty ref wins.
  let value = '';
  for (const ref of splitTopLevel(sourceExpr, '??')) {
    value = resolveRef(ref, ctx, opts);
    if (value !== '') break;
  }
  if (filter === null) return value;
  const remote = Boolean(ctx.originUrl || ctx.node);
  return applyFilter(value, filter, remote);
}

/**
 * Split on a delimiter that does NOT appear inside quotes. Only needed for the
 * `??` coalesce operator; our refs never embed `??` in a quoted literal in
 * practice, but the quote-awareness keeps a literal like `'a??b'` intact.
 */
function splitTopLevel(expr: string, delim: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: string | null = null;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      buf += c;
      continue;
    }
    if (expr.startsWith(delim, i)) {
      out.push(buf);
      buf = '';
      i += delim.length - 1;
      continue;
    }
    buf += c;
  }
  out.push(buf);
  return out;
}

/** Substitute every `{{ … }}` placeholder in a template string. */
export function renderTemplate(
  template: string,
  ctx: PluginWorkerContext,
  opts: SpawnTemplateOptions & { workerDir: string },
): string {
  return template.replace(/\{\{([^}]*)\}\}/g, (_m, body: string) =>
    evalExpr(body, ctx, opts),
  );
}

/**
 * Interpret a declarative worker template into a concrete PluginWorkerSpec —
 * the drop-in, zero-eval equivalent of a code-based `worker.spawn(ctx)`.
 *
 * `entry` is tokenized on whitespace BEFORE substitution, so command/args are
 * fixed by the template author and a substituted value can never split into
 * extra arguments. `env` values and `cwd` are rendered as templates.
 */
export function interpretWorkerTemplate(
  worker: AppManifestWorker,
  ctx: PluginWorkerContext,
  options: SpawnTemplateOptions,
): PluginWorkerSpec {
  const opts = { ...options, workerDir: options.workerDir };

  let command: string;
  let args: string[];
  if (worker.entry && worker.entry.trim()) {
    const tokens = worker.entry.trim().split(/\s+/);
    command = renderTemplate(tokens[0], ctx, opts);
    args = tokens.slice(1).map((t) => renderTemplate(t, ctx, opts));
  } else {
    command = renderTemplate(worker.command ?? '', ctx, opts);
    args = (worker.args ?? []).map((t) => renderTemplate(t, ctx, opts));
  }

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(worker.env ?? {})) {
    env[k] = renderTemplate(v, ctx, opts);
  }

  const cwd = renderTemplate(worker.cwd ?? '{{workerDir}}', ctx, opts);

  return { command, args, env, cwd };
}
