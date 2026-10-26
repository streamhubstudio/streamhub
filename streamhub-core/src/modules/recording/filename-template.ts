/**
 * Filename / S3-key templating for recordings + snapshots (StoreHub-style, our
 * `${}` dialect). A per-app config template (`recording.filename_template` for
 * MP4s, `recording.snapshot_template` for JPEGs) is expanded into a SINGLE safe
 * filename segment — never a path — so a template can NEVER traverse out of the
 * recordings/snapshots dir or the app's S3 prefix.
 *
 * Supported tokens (AntMedia uses `%streamId%`/`%r%`-style; we use `${}`):
 *   - `${app}`          — app slug
 *   - `${streamId}`     — stream id (canonical `${room}/${identity}` or a slug)
 *   - `${room}`         — LiveKit / passthrough room name
 *   - `${type}`         — output type without the dot (`mp4` | `jpg` | …)
 *   - `${ts}`           — unix epoch SECONDS at render time
 *   - `${date:FORMAT}`  — formatted UTC timestamp; FORMAT tokens:
 *                         yyyy yy MM dd HH mm ss (everything else is literal)
 *   - `${var.NAME}`     — per-app variable (config `variables:` map); missing → ''
 *
 * Unknown `${…}` tokens expand to an empty string (never left verbatim, so a
 * typo can't leak `${` into a key). The final string is sanitized to
 * `[A-Za-z0-9._-]`, path separators and `..` neutralized, length-capped. An
 * empty result (template rendered to nothing safe) returns '' so callers fall
 * back to the built-in naming.
 */

/** Values a template can reference. `now` defaults to render-time. */
export interface TemplateTokens {
  app: string;
  streamId: string;
  room: string;
  /** Output type WITHOUT the leading dot, e.g. `mp4` | `jpg`. */
  type: string;
  /** Per-app `variables:` map (config). Missing keys expand to ''. */
  variables?: Record<string, string>;
  /** Injectable clock for `${ts}` / `${date:…}` (tests pass a fixed Date). */
  now?: Date;
}

/** Two-digit zero pad. */
function p2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Expand a `${date:FORMAT}` spec against a UTC date. Recognized field tokens are
 * replaced longest-first so `yyyy` wins over `yy`; any other characters (`-` `:`
 * `_` literals) pass through untouched. Sanitization downstream turns unsafe
 * separators into `-`, so a `yyyy/MM/dd` never yields a real path.
 */
export function formatDate(fmt: string, date: Date): string {
  const map: Array<[string, string]> = [
    ['yyyy', String(date.getUTCFullYear())],
    ['yy', String(date.getUTCFullYear()).slice(-2)],
    ['MM', p2(date.getUTCMonth() + 1)],
    ['dd', p2(date.getUTCDate())],
    ['HH', p2(date.getUTCHours())],
    ['mm', p2(date.getUTCMinutes())],
    ['ss', p2(date.getUTCSeconds())],
  ];
  // Single left-to-right scan so an already-substituted digit is never re-matched.
  let out = '';
  let i = 0;
  while (i < fmt.length) {
    const hit = map.find(([tok]) => fmt.startsWith(tok, i));
    if (hit) {
      out += hit[1];
      i += hit[0].length;
    } else {
      out += fmt[i];
      i += 1;
    }
  }
  return out;
}

/** Resolve one `${…}` inner expression to its raw (pre-sanitize) string. */
function resolveToken(expr: string, tokens: TemplateTokens, now: Date): string {
  const trimmed = expr.trim();
  if (trimmed.startsWith('date:')) {
    return formatDate(trimmed.slice('date:'.length), now);
  }
  if (trimmed.startsWith('var.')) {
    const name = trimmed.slice('var.'.length);
    const v = tokens.variables?.[name];
    return v == null ? '' : String(v);
  }
  switch (trimmed) {
    case 'app':
      return tokens.app ?? '';
    case 'streamId':
      return tokens.streamId ?? '';
    case 'room':
      return tokens.room ?? '';
    case 'type':
      return tokens.type ?? '';
    case 'ts':
      return String(Math.floor(now.getTime() / 1000));
    default:
      return ''; // unknown token → empty (never leak the literal ${…})
  }
}

/**
 * Sanitize a rendered template into a single filesystem-/S3-safe segment.
 * Everything outside `[A-Za-z0-9._-]` (path separators, spaces, quotes, control
 * chars…) collapses to `-`; `..` runs collapse to `.` so no traversal survives;
 * leading/trailing `.`/`-` are trimmed; length capped. Returns '' when nothing
 * safe remains (caller falls back to the default naming).
 */
export function sanitizeSegment(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.') // defensive: kill any `..` (traversal) sequence
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 200)
    .replace(/[.\-]+$/g, ''); // re-trim after the length cap
}

/**
 * Render a filename template to a safe STEM (no extension). Returns '' when the
 * template is empty/blank OR renders to nothing safe — callers treat '' as
 * "use the built-in naming", so an unset/garbage template is always a no-op
 * fallback, never a broken filename.
 */
export function renderFilenameTemplate(
  template: string | undefined,
  tokens: TemplateTokens,
): string {
  const tpl = (template ?? '').trim();
  if (!tpl) return '';
  const now = tokens.now ?? new Date();
  const expanded = tpl.replace(/\$\{([^}]*)\}/g, (_m, expr: string) =>
    resolveToken(expr, tokens, now),
  );
  return sanitizeSegment(expanded);
}
