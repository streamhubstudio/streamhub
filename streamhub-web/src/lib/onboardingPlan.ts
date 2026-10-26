/**
 * Onboarding wizard — step graph + plan builder (PURE, node:test'd).
 *
 * The UI is a thin shell over this module: it collects `WizardAnswers`, asks
 * {@link stepsForPurpose} which steps to show (tailored by the chosen purpose),
 * and on "Finalizar" turns the answers into an ordered list of {@link PlanAction}
 * descriptors via {@link buildPlan}. The wizard's runner maps each descriptor to
 * exactly one EXISTING REST call (see the mapping table in the feature report):
 *
 *   config.recording  → PATCH  /apps/:app        { recordingEnabled }
 *   config.adaptive   → PATCH  /apps/:app/config { adaptive }
 *   features          → PATCH  /apps/:app        { features }
 *   plugin.install    → POST   /apps/:app/plugins/:id/install
 *   tag.create        → POST   /apps/:app/tags   { slug, label, kind }
 *   ingress.passthrough → POST /apps/:app/ingress { inputType:'rtmp', mode:'passthrough' }
 *
 * Nothing here touches the network — keeping the decision logic exhaustively
 * unit-testable and the React layer dumb.
 */
import type { AppFeatures } from '@/api'
import type { OnboardingPurpose } from './onboarding'

export type ViewerScale = 'small' | 'medium' | 'large'

/** The vision models offered in step 4 — each maps 1:1 to a per-app plugin id. */
export const VISION_MODELS = [
  'occupancy',
  'counting',
  'crowd',
  'demography',
  'lpr',
  'perimeter',
  'presence',
] as const
export type VisionModel = (typeof VISION_MODELS)[number]

export interface WizardAnswers {
  purpose?: OnboardingPurpose
  /** Step 2 — record sessions to VOD. */
  recording?: boolean
  /** Step 3 — expected concurrent viewers (drives adaptive delivery guidance). */
  viewers?: ViewerScale
  /** Step 4 — vision plugin ids to install. */
  visionModels?: VisionModel[]
  /** Step 4 gate — a non-surveillance app can opt IN to the vision step. */
  visionOptIn?: boolean
  /** Step 5 — free-text tag labels (slugs are derived). */
  tags?: string[]
}

export type StepId =
  | 'purpose'
  | 'recording'
  | 'viewers'
  | 'vision'
  | 'tags'
  | 'extras'
  | 'summary'

export const ALL_PURPOSES: readonly OnboardingPurpose[] = [
  'surveillance',
  'radio',
  'events',
  'meetings',
  'live-shopping',
  'general',
]

/** Static, per-purpose metadata the UI (and tests) read. */
export interface PurposeMeta {
  /** Does this purpose show the video-oriented "viewers/adaptive" step? */
  viewers: boolean
  /** Is the vision step shown by default (surveillance) — else opt-in only? */
  visionByDefault: boolean
  /** Does the purpose have a bespoke "extras" step (radio ingress, etc.)? */
  extras: boolean
  /** Blog recipe slug on https://streamhub.studio/blog for the closing screen. */
  recipe: string
  /** Optional in-app deep link (relative to /apps/:app) shown as a next step. */
  deepLink?: (app: string) => string
}

export const PURPOSE_META: Record<OnboardingPurpose, PurposeMeta> = {
  surveillance: {
    viewers: true,
    visionByDefault: true,
    extras: false,
    recipe: 'perimeter-intrusion-detection-recipe',
    deepLink: (app) => `/apps/${encodeURIComponent(app)}?tab=ingress`,
  },
  radio: {
    viewers: false,
    visionByDefault: false,
    extras: true,
    recipe: 'run-a-24-7-radio-station',
    deepLink: (app) => `/radio/${encodeURIComponent(app)}`,
  },
  events: {
    viewers: true,
    visionByDefault: false,
    extras: true,
    recipe: 'stream-an-art-exhibition-multi-camera',
    deepLink: (app) => `/broadcast/${encodeURIComponent(app)}`,
  },
  meetings: {
    viewers: false,
    visionByDefault: false,
    extras: true,
    recipe: 'webinars-with-recording-and-transcripts',
    deepLink: (app) => `/meeting/${encodeURIComponent(app)}`,
  },
  'live-shopping': {
    viewers: true,
    visionByDefault: false,
    extras: true,
    recipe: 'build-a-live-shopping-channel',
    deepLink: (app) => `/broadcast/${encodeURIComponent(app)}`,
  },
  general: {
    viewers: true,
    visionByDefault: false,
    extras: false,
    recipe: '',
    deepLink: (app) => `/apps/${encodeURIComponent(app)}?tab=streams`,
  },
}

/**
 * The ordered steps to present for a given purpose + answers. `purpose`
 * undefined → only the first step (nothing is tailored yet). The vision step
 * appears for surveillance, or when a non-surveillance operator opted in.
 */
export function stepsForPurpose(
  purpose: OnboardingPurpose | undefined,
  answers: Pick<WizardAnswers, 'visionOptIn'> = {},
): StepId[] {
  if (!purpose) return ['purpose']
  const meta = PURPOSE_META[purpose]
  const steps: StepId[] = ['purpose', 'recording']
  if (meta.viewers) steps.push('viewers')
  if (meta.visionByDefault || answers.visionOptIn) steps.push('vision')
  if (meta.visionByDefault || answers.visionOptIn) steps.push('tags')
  if (meta.extras) steps.push('extras')
  steps.push('summary')
  return steps
}

/** kebab-case a free-text label into a valid tag slug (matches core's regex). */
export function kebab(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '') // a mid-word slice could leave a trailing hyphen
}

export type PlanAction =
  | { type: 'config.recording'; enabled: boolean }
  | { type: 'config.adaptive'; enabled: boolean }
  | { type: 'features'; features: Partial<AppFeatures> }
  | { type: 'plugin.install'; id: string }
  | { type: 'tag.create'; slug: string; label: string }
  | { type: 'ingress.passthrough' }

/** Map the viewer scale to whether adaptive (simulcast) delivery is worth it. */
export function adaptiveForViewers(scale: ViewerScale): boolean {
  // A tiny audience gets single-layer (lower CPU); medium/large benefits from
  // the simulcast ladder so heterogeneous networks each get a fitting rendition.
  return scale !== 'small'
}

/**
 * Turn the collected answers into an ordered, de-duplicated list of API actions.
 * Order: config toggles → vision plugins → tags → purpose extras. The wizard
 * runs them best-effort (one failure never aborts the rest).
 */
export function buildPlan(answers: WizardAnswers): PlanAction[] {
  const actions: PlanAction[] = []
  const purpose = answers.purpose
  const meta = purpose ? PURPOSE_META[purpose] : undefined

  if (answers.recording !== undefined) {
    actions.push({ type: 'config.recording', enabled: answers.recording })
  }

  if (meta?.viewers && answers.viewers) {
    actions.push({ type: 'config.adaptive', enabled: adaptiveForViewers(answers.viewers) })
  }

  const showVision = Boolean(meta?.visionByDefault || answers.visionOptIn)
  if (showVision && answers.visionModels?.length) {
    for (const id of dedupe(answers.visionModels)) {
      actions.push({ type: 'plugin.install', id })
    }
  }

  if (showVision && answers.tags?.length) {
    const seen = new Set<string>()
    for (const label of answers.tags) {
      const trimmed = label.trim()
      const slug = kebab(trimmed)
      if (!slug || seen.has(slug)) continue
      seen.add(slug)
      actions.push({ type: 'tag.create', slug, label: trimmed })
    }
  }

  // Purpose-specific extras.
  if (purpose === 'radio') {
    actions.push({ type: 'plugin.install', id: 'radio' })
    actions.push({ type: 'ingress.passthrough' })
  } else if (purpose === 'events') {
    actions.push({
      type: 'features',
      features: { chat: true, reactions: true, viewerCounter: true },
    })
    actions.push({ type: 'plugin.install', id: 'quality' })
  } else if (purpose === 'live-shopping') {
    actions.push({
      type: 'features',
      features: { reactions: true, viewerCounter: true },
    })
  }

  return actions
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr))
}
