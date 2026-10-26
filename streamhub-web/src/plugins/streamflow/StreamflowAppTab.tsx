/**
 * StreamflowAppTab — mounts the streamflow Studio App's primary surface as a
 * first-class TAB inside AppDetail (not only via the Studio deep link).
 *
 * It resolves the app's plugin catalog, finds the active streamflow `app-tab`
 * view, and renders its `TabComponent` through the shared `componentFor` inside a
 * per-plugin error boundary — exactly like the Studio page, but hosted in the app
 * tab bar. The workflows/editor/runs/secrets SECTIONS stay deep-linkable: the
 * host passes `ctx.section` + `ctx.onSectionChange` (bound to a URL param by
 * AppDetail), so `useSection` runs controlled just as it does full-page.
 */
import { usePluginCatalog } from '../usePlugins.ts'
import { componentFor, PluginErrorBoundary, BoundaryFallback } from '../host.tsx'
import { streamflowTabView } from './appTab.ts'

export interface StreamflowAppTabProps {
  app: string
  section?: string
  onSection?: (section: string) => void
}

export function StreamflowAppTab({ app, section, onSection }: StreamflowAppTabProps) {
  const { views } = usePluginCatalog(app)
  const view = streamflowTabView(views)
  if (!view) return null
  const Comp = componentFor(view)
  if (!Comp) return null
  return (
    <PluginErrorBoundary
      pluginId={view.id}
      fallback={(id) => <BoundaryFallback pluginId={id} />}
    >
      <Comp
        ctx={{ app, config: view.config, section, onSectionChange: onSection }}
        pluginId={view.id}
      />
    </PluginErrorBoundary>
  )
}
