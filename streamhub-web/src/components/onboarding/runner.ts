/**
 * Onboarding plan runner — turns the pure {@link PlanAction} descriptors into
 * their EXISTING REST calls, one per action, best-effort (a failure is recorded
 * and the rest still run). Also owns the onboarding-state persistence: a
 * config.yaml `onboarding:` block written through the raw-config API.
 *
 * Kept out of the React component so the mapping is easy to reason about; the
 * component just renders progress from the returned {@link ActionResult}s.
 */
import { api } from '@/api'
import { pluginsApi } from '@/plugins/api'
import {
  readOnboarding,
  upsertOnboardingBlock,
  type OnboardingState,
} from '@/lib/onboarding'
import type { PlanAction } from '@/lib/onboardingPlan'

export interface ActionResult {
  action: PlanAction
  ok: boolean
  error?: string
  /** ingress.passthrough payoff: the RTMP push URL + `ptk_` stream key. */
  detail?: { rtmpUrl?: string; streamKey?: string; hlsUrl?: string }
}

async function runAction(app: string, action: PlanAction): Promise<ActionResult> {
  try {
    switch (action.type) {
      case 'config.recording':
        await api.apps.update(app, { recordingEnabled: action.enabled })
        return { action, ok: true }
      case 'config.adaptive':
        await api.apps.updateConfig(app, { adaptive: action.enabled })
        return { action, ok: true }
      case 'features':
        await api.apps.update(app, { features: action.features })
        return { action, ok: true }
      case 'plugin.install':
        await pluginsApi.install(app, action.id)
        return { action, ok: true }
      case 'tag.create':
        await api.tags.create(app, {
          slug: action.slug,
          label: action.label,
          kind: 'custom',
        })
        return { action, ok: true }
      case 'ingress.passthrough': {
        const ing = await api.ingress.create(app, {
          inputType: 'rtmp',
          mode: 'passthrough',
        })
        return {
          action,
          ok: true,
          detail: {
            rtmpUrl: ing.rtmp_url,
            streamKey: ing.stream_key ?? ing.streamKey,
            hlsUrl: ing.hls_url,
          },
        }
      }
      default:
        return { action, ok: true }
    }
  } catch (err) {
    return { action, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Run every action in order, invoking `onProgress` after each so the UI can
 * stream a per-item ✓/✗. Never throws — collects results instead.
 */
export async function runPlan(
  app: string,
  actions: PlanAction[],
  onProgress?: (done: number, total: number, last: ActionResult) => void,
): Promise<ActionResult[]> {
  const results: ActionResult[] = []
  for (let i = 0; i < actions.length; i++) {
    const res = await runAction(app, actions[i])
    results.push(res)
    onProgress?.(i + 1, actions.length, res)
  }
  return results
}

/**
 * Persist the onboarding block into the app's config.yaml via the raw-config
 * round-trip (read → splice onboarding → write). Best-effort at the call site:
 * if it throws, the wizard still closes (the setup entry point simply re-offers).
 */
export async function persistOnboarding(
  app: string,
  state: OnboardingState,
): Promise<void> {
  const raw = await api.apps.getConfigRaw(app)
  const yaml = upsertOnboardingBlock(raw.yaml, state)
  await api.apps.putConfigRaw(app, yaml)
}

/**
 * Read the onboarding block out of the app's config.yaml. Returns null when the
 * app has never been onboarded OR the raw config can't be read (e.g. a viewer
 * without `config:read`) — the caller treats null as "not yet resolved" but the
 * banner only prompts when it can positively read a pending/absent state.
 */
export async function loadOnboarding(
  app: string,
  signal?: AbortSignal,
): Promise<OnboardingState | null> {
  const raw = await api.apps.getConfigRaw(app, signal)
  return readOnboarding(raw.yaml)
}
