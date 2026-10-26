/**
 * Per-stream settings resolution (module `tags`).
 *
 * A stream's EFFECTIVE settings are a deep merge of three layers, lowest
 * precedence first:
 *   1. model defaults      — the vision model's built-in defaults,
 *   2. tag configs         — the `config_json` of each tag applied to the stream
 *                            (in order; a later tag wins over an earlier one),
 *   3. per-stream overrides — explicit overrides on the stream row.
 *
 * Merge rules (Vision-Edge design §E):
 *   - plain objects are merged RECURSIVELY (a nested key set only in a lower
 *     layer survives),
 *   - arrays are REPLACED wholesale (never concatenated) — a higher layer's
 *     array is the final value,
 *   - primitives / null replace lower layers,
 *   - the result is a deep CLONE — no input object/array is shared into the
 *     output, so callers can mutate freely.
 *
 * Pure + dependency-free so it is trivially unit-testable and reusable by the
 * (wave-2) vision scheduler when it resolves an assignment's config.
 */

/** True for a mergeable mapping (excludes arrays and null). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-clone any JSON-ish value (objects/arrays cloned, primitives returned). */
function cloneValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(cloneValue);
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = cloneValue(val);
    return out;
  }
  return v;
}

/**
 * Deep-merge `over` onto a CLONE of `base`. Objects merge recursively; arrays
 * and primitives from `over` replace whatever `base` had. Never mutates either
 * argument.
 */
export function deepMergeSettings(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(base)) out[k] = cloneValue(v);
  for (const [k, v] of Object.entries(over)) {
    const prev = out[k];
    out[k] =
      isPlainObject(prev) && isPlainObject(v)
        ? deepMergeSettings(prev, v)
        : cloneValue(v);
  }
  return out;
}

/**
 * Resolve a stream's effective settings by merging model defaults → tag configs
 * (in order) → per-stream overrides. Non-object layers are treated as empty so
 * a malformed `config_json` never throws. Returns a fresh object every call.
 */
export function resolveStreamSettings(
  modelDefaults: Record<string, unknown> | undefined,
  tagConfigs: Array<Record<string, unknown>> | undefined,
  streamOverrides: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const layers: unknown[] = [
    modelDefaults ?? {},
    ...(tagConfigs ?? []),
    streamOverrides ?? {},
  ];
  return layers.reduce<Record<string, unknown>>(
    (acc, layer) =>
      deepMergeSettings(acc, isPlainObject(layer) ? layer : {}),
    {},
  );
}
