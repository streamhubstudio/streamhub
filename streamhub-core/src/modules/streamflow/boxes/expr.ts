/**
 * SAFE typed condition/switch evaluation (Streamflow logic boxes).
 *
 * NO arbitrary JS / eval: a condition is a list of {field, op, value} rules
 * combined with AND ('all') or OR ('any'). `field` is a dotted path into the run
 * bag; `value` is a literal (itself template-resolvable by the caller). This is
 * the "validate the analysis" primitive — deterministic and injection-free.
 */
import { getPath, resolveValue } from './path';

export type CompareOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'not_contains'
  | 'matches'
  | 'exists'
  | 'not_exists'
  | 'truthy'
  | 'falsy';

export interface Rule {
  field: string;
  op: CompareOp;
  value?: unknown;
}

export interface ConditionConfig {
  /** Combine rules with AND ('all', default) or OR ('any'). */
  match?: 'all' | 'any';
  rules?: Rule[];
}

/** Evaluate one rule against the bag. Never throws. */
export function evalRule(rule: Rule, bag: unknown): boolean {
  const actual = getPath(bag, rule.field);
  const expected = resolveValue(rule.value, bag);
  switch (rule.op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'not_exists':
      return actual === undefined || actual === null;
    case 'truthy':
      return !!actual;
    case 'falsy':
      return !actual;
    case 'eq':
      return looseEq(actual, expected);
    case 'ne':
      return !looseEq(actual, expected);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return numCompare(rule.op, actual, expected);
    case 'contains':
      return containsOp(actual, expected);
    case 'not_contains':
      return !containsOp(actual, expected);
    case 'matches':
      return matchesOp(actual, expected);
    default:
      return false;
  }
}

/** Evaluate a full condition config → boolean. Empty rules → true. */
export function evalCondition(config: ConditionConfig, bag: unknown): boolean {
  const rules = Array.isArray(config?.rules) ? config.rules : [];
  if (!rules.length) return true;
  const results = rules.map((r) => evalRule(r, bag));
  return config?.match === 'any'
    ? results.some(Boolean)
    : results.every(Boolean);
}

export interface SwitchCase {
  value: unknown;
  /** Outgoing port for this case (defaults to String(value)). */
  port?: string;
}

export interface SwitchConfig {
  field: string;
  cases?: SwitchCase[];
  /** Port when no case matches (default 'default'). */
  default?: string;
}

/** Pick the outgoing port for a switch box. */
export function evalSwitch(config: SwitchConfig, bag: unknown): string {
  const actual = getPath(bag, config.field);
  const cases = Array.isArray(config?.cases) ? config.cases : [];
  for (const c of cases) {
    if (looseEq(actual, resolveValue(c.value, bag))) {
      return (c.port ?? String(c.value ?? '')).trim() || 'default';
    }
  }
  return (config?.default ?? 'default').trim() || 'default';
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const an = toNum(a);
  const bn = toNum(b);
  if (an !== null && bn !== null) return an === bn;
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return String(a) === String(b);
  }
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function numCompare(op: 'gt' | 'gte' | 'lt' | 'lte', a: unknown, b: unknown): boolean {
  const an = toNum(a);
  const bn = toNum(b);
  if (an === null || bn === null) return false;
  switch (op) {
    case 'gt':
      return an > bn;
    case 'gte':
      return an >= bn;
    case 'lt':
      return an < bn;
    case 'lte':
      return an <= bn;
  }
}

function containsOp(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) return actual.some((x) => looseEq(x, expected));
  if (typeof actual === 'string') return actual.includes(String(expected ?? ''));
  if (actual && typeof actual === 'object') {
    return Object.prototype.hasOwnProperty.call(actual, String(expected));
  }
  return false;
}

function matchesOp(actual: unknown, pattern: unknown): boolean {
  const p = String(pattern ?? '');
  if (!p || p.length > 512) return false; // bound the pattern length
  try {
    return new RegExp(p).test(String(actual ?? ''));
  } catch {
    return false;
  }
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
