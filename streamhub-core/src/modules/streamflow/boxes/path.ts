/**
 * SAFE path get/set + template resolution for the run bag (Streamflow).
 *
 * No `eval`, no `Function`, no prototype access: dotted paths are split and
 * walked key-by-key, and any `__proto__` / `prototype` / `constructor` segment
 * is refused so a template can never reach up the prototype chain or pollute it.
 * Array indices work via numeric segments (`a.0.b`).
 */

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** Split a dotted path into segments, dropping empties. */
export function splitPath(path: string): string[] {
  return String(path)
    .split('.')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Read a value at a dotted path; undefined when any segment is missing/unsafe. */
export function getPath(bag: unknown, path: string): unknown {
  const segments = splitPath(path);
  let cur: unknown = bag;
  for (const seg of segments) {
    if (FORBIDDEN_KEYS.has(seg)) return undefined;
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0) return undefined;
      cur = cur[idx];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Set a value at a dotted path on a plain object, creating intermediate plain
 * objects as needed. Refuses forbidden keys (returns without mutating). Returns
 * the same (mutated) root for convenience.
 */
export function setPath(
  root: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const segments = splitPath(path);
  if (!segments.length) return root;
  if (segments.some((s) => FORBIDDEN_KEYS.has(s))) return root;
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const next = cur[seg];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      cur[seg] = {};
    }
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segments[segments.length - 1]] = value;
  return root;
}

const FULL_TEMPLATE = /^\{\{\s*([^}]+?)\s*\}\}$/;
const INLINE_TEMPLATE = /\{\{\s*([^}]+?)\s*\}\}/g;

/**
 * Resolve a config value against the bag:
 *  - a string that is EXACTLY `{{ path }}` → the resolved value (any type);
 *  - a string with embedded `{{ path }}` → string interpolation (missing →
 *    empty, objects → JSON);
 *  - arrays/plain objects → deep-resolved element-wise;
 *  - anything else → returned unchanged.
 */
export function resolveValue(value: unknown, bag: unknown): unknown {
  if (typeof value === 'string') {
    const full = FULL_TEMPLATE.exec(value);
    if (full) return getPath(bag, full[1]);
    if (value.includes('{{')) {
      return value.replace(INLINE_TEMPLATE, (_m, p1: string) =>
        stringify(getPath(bag, p1)),
      );
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, bag));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      out[k] = resolveValue(v, bag);
    }
    return out;
  }
  return value;
}

/** Coerce a resolved value to a string for inline interpolation. */
function stringify(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

/** Resolve a value to a string (empty when missing). */
export function resolveString(value: unknown, bag: unknown): string {
  const r = resolveValue(value, bag);
  return stringify(r);
}
