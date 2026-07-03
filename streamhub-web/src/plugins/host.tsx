/**
 * Plugin-host — mounts installed + active plugins into the app.
 *
 * A host surface (AppDetail, a plugin panel page, or a player) drops in a single
 * `<PluginSlot placement="…" ctx={…} />`. The slot:
 *   1. reads the merged catalog (usePluginsByPlacement),
 *   2. picks the right component per plugin (TabComponent / PanelComponent /
 *      OverlayComponent) based on its declared `ui`,
 *   3. renders each inside an error boundary so one misbehaving plugin can't
 *      take down the host surface,
 *   4. hands every plugin a `PluginContext` (app/room + its merged config).
 *
 * Because everything flows through the auto-discovery registry, NO central file
 * lists the plugins — new ones appear automatically.
 */
import { Component, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { usePluginsByPlacement } from './usePlugins.ts'
import type {
  PluginComponent,
  PluginContext,
  PluginPlacement,
  PluginView,
} from './types.ts'

// --- per-plugin error boundary ---------------------------------------------

class PluginErrorBoundary extends Component<
  { pluginId: string; fallback: (id: string) => ReactNode; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error(`[plugins] "${this.props.pluginId}" crashed:`, error)
  }

  render() {
    if (this.state.error) return this.props.fallback(this.props.pluginId)
    return this.props.children
  }
}

function BoundaryFallback({ pluginId }: { pluginId: string }) {
  const { t } = useTranslation('marketplace')
  return (
    <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-danger">
      {t('host.crashed', { id: pluginId })}
    </div>
  )
}

// --- component selection ----------------------------------------------------

function componentFor(view: PluginView): PluginComponent | undefined {
  const reg = view.registered
  if (!reg) return undefined
  switch (view.ui) {
    case 'app-tab':
      return reg.TabComponent
    case 'panel':
      return reg.PanelComponent
    case 'player-overlay':
      return reg.OverlayComponent
    default:
      return undefined
  }
}

// --- public slot ------------------------------------------------------------

export interface PluginSlotProps {
  placement: PluginPlacement
  /** Host context (app/room). `config` is filled per-plugin by the slot. */
  ctx?: Omit<PluginContext, 'config'>
  /**
   * Wrapper around each mounted plugin (e.g. a section heading / card). Receives
   * the view so the host can label it. Defaults to a bare fragment.
   */
  wrapper?: (view: PluginView, node: ReactNode) => ReactNode
  /** Rendered when no active plugin matches the placement. */
  empty?: ReactNode
  /**
   * Anonymous (public) surface — e.g. the /play + /embed players with no login.
   * Reads the no-auth overlay endpoint so overlays render without a 401. Only
   * meaningful for `placement="player-overlay"`. Default false (authenticated).
   */
  public?: boolean
}

/**
 * Render every active plugin for `placement`. Safe to mount anywhere: with no
 * matching plugins it renders `empty` (or nothing).
 *
 * Plugins are per-app, so the slot reads the app from `ctx.app` and fetches that
 * app's install state. Without an app (`ctx.app` empty) nothing is active, so it
 * renders `empty`.
 */
export function PluginSlot({
  placement,
  ctx,
  wrapper,
  empty,
  public: isPublic = false,
}: PluginSlotProps) {
  const views = usePluginsByPlacement(ctx?.app ?? '', placement, {
    public: isPublic,
  })

  if (views.length === 0) return <>{empty ?? null}</>

  return (
    <>
      {views.map((view) => {
        const Comp = componentFor(view)
        if (!Comp) return null
        const node = (
          <PluginErrorBoundary
            key={view.id}
            pluginId={view.id}
            fallback={(id) => <BoundaryFallback pluginId={id} />}
          >
            <Comp ctx={{ ...ctx, config: view.config }} pluginId={view.id} />
          </PluginErrorBoundary>
        )
        return wrapper ? (
          <div key={view.id}>{wrapper(view, node)}</div>
        ) : (
          <div key={view.id}>{node}</div>
        )
      })}
    </>
  )
}

/**
 * Convenience list of the active plugins for a placement, scoped to `app` (for
 * hosts that want to render their own tab bar rather than a stacked slot).
 */
export function usePluginSlots(
  app: string,
  placement: PluginPlacement,
  opts: { public?: boolean } = {},
): PluginView[] {
  return usePluginsByPlacement(app, placement, opts)
}
