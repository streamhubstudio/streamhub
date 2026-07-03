/**
 * Pure helpers that turn a plugin's `ConfigSchema` into a form model:
 * default/initial values, input coercion, and validation (i18n-agnostic codes).
 *
 * No React, no DOM — unit-tested with node:test (see schema.spec.ts).
 */
import type {
  ConfigField,
  ConfigSchema,
  ConfigValidation,
  ConfigValues,
} from './types.ts'

/** The zero/empty value used when a field has no `default`. */
export function emptyForField(field: ConfigField): string | number | boolean {
  switch (field.type) {
    case 'boolean':
      return false
    case 'number':
      // Empty numeric fields are represented as '' at the input layer, but the
      // value model uses `undefined` (see buildInitialValues). This is only the
      // fallback for a required-with-no-default number: 0.
      return 0
    case 'select':
      return field.options?.[0]?.value ?? ''
    default:
      return ''
  }
}

/** Resolve the effective default for a field (declared default or empty). */
export function defaultForField(
  field: ConfigField,
): string | number | boolean | undefined {
  if (field.default !== undefined) return field.default
  if (field.type === 'boolean') return false
  return undefined
}

/**
 * Build the initial value bag: schema defaults overlaid with any stored values.
 * Only keys declared in the schema are kept (unknown stored keys are dropped).
 */
export function buildInitialValues(
  schema: ConfigSchema | undefined,
  current?: ConfigValues,
): ConfigValues {
  const out: ConfigValues = {}
  if (!schema) return out
  for (const field of schema.fields) {
    const stored = current?.[field.key]
    if (stored !== undefined) {
      out[field.key] = stored
    } else {
      const def = defaultForField(field)
      if (def !== undefined) out[field.key] = def
    }
  }
  return out
}

/**
 * Coerce a raw form input (usually a string from an <input>) into the typed
 * value the field expects. An empty string becomes `undefined` (unset) for
 * every non-boolean type so "cleared" fields don't serialize as "".
 */
export function coerceValue(
  field: ConfigField,
  raw: string | number | boolean,
): string | number | boolean | undefined {
  if (field.type === 'boolean') return Boolean(raw)
  if (field.type === 'number') {
    if (raw === '' || raw === undefined || raw === null) return undefined
    const n = typeof raw === 'number' ? raw : Number(raw)
    return Number.isNaN(n) ? NaN : n
  }
  const s = String(raw)
  return s === '' ? undefined : s
}

/**
 * Validate a value bag against the schema. Returns i18n-agnostic error codes
 * keyed by field; the caller maps codes → localized messages.
 */
export function validateValues(
  schema: ConfigSchema | undefined,
  values: ConfigValues,
): ConfigValidation {
  const errors: ConfigValidation['errors'] = {}
  if (!schema) return { valid: true, errors }

  for (const field of schema.fields) {
    const v = values[field.key]
    const missing =
      v === undefined ||
      v === '' ||
      (field.type === 'boolean' ? false : v === null)

    if (field.required && missing) {
      errors[field.key] = 'required'
      continue
    }
    if (missing) continue

    if (field.type === 'number') {
      const n = typeof v === 'number' ? v : Number(v)
      if (Number.isNaN(n)) {
        errors[field.key] = 'nan'
        continue
      }
      if (field.min !== undefined && n < field.min) {
        errors[field.key] = 'min'
        continue
      }
      if (field.max !== undefined && n > field.max) {
        errors[field.key] = 'max'
        continue
      }
    }

    if (field.type === 'select' && field.options) {
      const ok = field.options.some((o) => o.value === v)
      if (!ok) errors[field.key] = 'notInOptions'
    }
  }

  return { valid: Object.keys(errors).length === 0, errors }
}

/** Strip `undefined` entries so the payload only carries set values. */
export function pruneValues(values: ConfigValues): ConfigValues {
  const out: ConfigValues = {}
  for (const [k, v] of Object.entries(values)) {
    if (v !== undefined) out[k] = v
  }
  return out
}
