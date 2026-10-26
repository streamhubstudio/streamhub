/**
 * Onboarding state persistence — pure helpers over the app's raw config.yaml.
 *
 * WHERE it lives: a top-level `onboarding:` block inside the app's config.yaml,
 * read/written through the EXISTING raw-config API (GET/PUT
 * /apps/:app/config/raw). The core tolerates unknown top-level keys
 * (validateRawConfig only shape-checks the blocks it models) AND carries them
 * through every structured save (AppsService.mergeDisk copies unmodelled
 * top-level keys verbatim — see the "PRESERVE operator-authored blocks" note),
 * so an `onboarding:` block survives later PATCH /config edits untouched. That
 * makes the raw-config round-trip the cleanest existing persistence mechanism —
 * no core change and no YAML dependency in the browser bundle.
 *
 * We only ever write this block ourselves, so its shape is fixed (a plain block
 * mapping — the style js-yaml.dump emits on the core side too). The reader is
 * deliberately forgiving (tolerates quoting) but assumes that block form; a
 * hand-authored flow mapping simply reads back as "not onboarded", which just
 * re-offers the wizard (safe degradation).
 *
 * These functions are pure (string in → string/state out) and fully unit-tested
 * under node:test (onboarding.spec.ts).
 */

export type OnboardingStatus = 'pending' | 'completed' | 'dismissed'

export type OnboardingPurpose =
  | 'surveillance'
  | 'radio'
  | 'events'
  | 'meetings'
  | 'live-shopping'
  | 'general'

export interface OnboardingState {
  status: OnboardingStatus
  /** The purpose the operator picked in step 1 (absent if they skipped early). */
  purpose?: OnboardingPurpose
  /** ISO timestamp of when the wizard was completed/dismissed. */
  completedAt?: string
}

const BLOCK_KEY = 'onboarding'
const PURPOSES: readonly OnboardingPurpose[] = [
  'surveillance',
  'radio',
  'events',
  'meetings',
  'live-shopping',
  'general',
]
const STATUSES: readonly OnboardingStatus[] = ['pending', 'completed', 'dismissed']

/** Strip a single layer of matching single/double quotes around a scalar. */
function unquote(v: string): string {
  const t = v.trim()
  if (t.length >= 2) {
    const a = t[0]
    const b = t[t.length - 1]
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      return t.slice(1, -1)
    }
  }
  return t
}

/** A line that belongs to the block body (indented child). */
function isIndented(line: string): boolean {
  return /^\s+\S/.test(line)
}

/**
 * Read the `onboarding:` block out of a raw config.yaml. Returns null when the
 * block is absent or carries no recognizable `status`.
 */
export function readOnboarding(rawYaml: string): OnboardingState | null {
  if (!rawYaml) return null
  const lines = rawYaml.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^${BLOCK_KEY}:\\s*(.*)$`).test(l))
  if (start === -1) return null

  // Collect the indented child lines directly under `onboarding:`.
  const body: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    if (isIndented(lines[i])) body.push(lines[i])
    else break
  }

  const pick = (key: string): string | undefined => {
    for (const line of body) {
      const m = line.match(new RegExp(`^\\s+${key}:\\s*(.+?)\\s*$`))
      if (m) return unquote(m[1])
    }
    return undefined
  }

  const rawStatus = pick('status')
  if (!rawStatus) return null
  const status = (STATUSES as readonly string[]).includes(rawStatus)
    ? (rawStatus as OnboardingStatus)
    : 'pending'

  const rawPurpose = pick('purpose')
  const purpose =
    rawPurpose && (PURPOSES as readonly string[]).includes(rawPurpose)
      ? (rawPurpose as OnboardingPurpose)
      : undefined

  const completedAt = pick('completed_at')

  return { status, purpose, completedAt }
}

/** Serialize the state into a config.yaml `onboarding:` block (trailing newline). */
function renderBlock(state: OnboardingState): string {
  const out = [`${BLOCK_KEY}:`, `  status: ${state.status}`]
  if (state.purpose) out.push(`  purpose: ${state.purpose}`)
  if (state.completedAt) out.push(`  completed_at: "${state.completedAt}"`)
  return out.join('\n') + '\n'
}

/**
 * Return `rawYaml` with the `onboarding:` block set to `state` — replacing any
 * existing block in place, or appending one at the end. Everything else in the
 * file is preserved verbatim.
 */
export function upsertOnboardingBlock(rawYaml: string, state: OnboardingState): string {
  const lines = (rawYaml ?? '').split('\n')
  const start = lines.findIndex((l) => new RegExp(`^${BLOCK_KEY}:\\s*(.*)$`).test(l))

  let kept: string[]
  if (start === -1) {
    kept = lines
  } else {
    let end = start + 1
    while (end < lines.length && isIndented(lines[end])) end++
    kept = [...lines.slice(0, start), ...lines.slice(end)]
  }

  const head = kept.join('\n').replace(/\s*$/, '')
  const block = renderBlock(state)
  return head ? `${head}\n${block}` : block
}

/** True once the operator has finished OR dismissed the wizard (won't re-offer). */
export function isOnboardingResolved(state: OnboardingState | null): boolean {
  return state?.status === 'completed' || state?.status === 'dismissed'
}
