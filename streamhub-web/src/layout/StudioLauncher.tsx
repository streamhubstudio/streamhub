/**
 * StudioLauncher — the shell's "jump to a Studio view" menu.
 *
 * A header popover that answers the owner's ask: pick a tenant app, see its
 * INSTALLED Studio apps, expand one to its declared sections (views), click →
 * navigate straight to the deep link (`/apps/:app/studio/:id/:section`). The
 * section list is enumerated from each module's declared `sections` (via
 * `sectionsOf`), so new Studio apps show up with zero edits here.
 *
 * Lazily fetches: the app list + per-app plugin catalog only load once the panel
 * is open. Closes on outside-click, Escape, or navigation.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import {
  HiOutlineViewGridAdd,
  HiOutlineChevronDown,
  HiOutlineChevronRight,
} from 'react-icons/hi'
import { api } from '@/api'
import { usePluginCatalog } from '@/plugins'
import { sectionsOf, studioAppPath } from '@/plugins/state'
import { PluginIcon } from '@/plugins/ui'

export function StudioLauncher() {
  const { t } = useTranslation('shell')
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('launcher.open')}
        title={t('launcher.open')}
        data-testid="studio-launcher-button"
        className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-fg-muted transition hover:bg-surface-raised hover:text-fg"
      >
        <HiOutlineViewGridAdd className="text-xl" />
      </button>
      {open && (
        <div
          role="menu"
          data-testid="studio-launcher-panel"
          className="absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-surface p-3 shadow-xl"
        >
          <LauncherBody onNavigate={() => setOpen(false)} />
        </div>
      )}
    </div>
  )
}

function LauncherBody({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useTranslation('shell')
  const navigate = useNavigate()

  const { data: apps, isLoading: appsLoading } = useQuery({
    queryKey: ['apps'],
    queryFn: ({ signal }) => api.apps.list(signal),
  })
  const [app, setApp] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  // Default to the first app once the list loads (no app selected yet).
  useEffect(() => {
    if (!app && apps && apps.length) setApp(apps[0].name)
  }, [apps, app])

  const { views, isLoading: pluginsLoading } = usePluginCatalog(app)
  const installedApps = useMemo(
    () => views.filter((v) => v.kind === 'app' && v.installed && v.hasFrontend),
    [views],
  )

  function go(pluginId: string, section?: string) {
    navigate(studioAppPath(app, pluginId, section))
    onNavigate()
  }

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-fg">{t('launcher.title')}</h3>

      {/* App picker */}
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
          {t('launcher.app')}
        </span>
        {appsLoading ? (
          <p className="text-xs text-fg-subtle">{t('launcher.loadingApps')}</p>
        ) : !apps || apps.length === 0 ? (
          <p className="text-xs text-fg-muted">{t('launcher.noApps')}</p>
        ) : (
          <select
            aria-label={t('launcher.app')}
            data-testid="launcher-app-select"
            value={app}
            onChange={(e) => {
              setApp(e.target.value)
              setExpanded(null)
            }}
            className="w-full rounded-md border border-border bg-surface-raised px-2 py-1.5 text-sm text-fg"
          >
            {apps.map((a) => (
              <option key={a.name} value={a.name}>
                {a.displayName || a.name}
              </option>
            ))}
          </select>
        )}
      </label>

      {/* Installed Studio apps for the selected app → expand to sections */}
      {app && (
        <div className="mt-3 max-h-80 overflow-y-auto">
          {pluginsLoading ? (
            <p className="px-1 py-2 text-xs text-fg-subtle">{t('launcher.loadingApps')}</p>
          ) : installedApps.length === 0 ? (
            <p className="px-1 py-2 text-xs text-fg-muted">{t('launcher.noInstalled')}</p>
          ) : (
            <ul className="space-y-0.5">
              {installedApps.map((v) => {
                const secs = sectionsOf(v)
                const isOpen = expanded === v.id
                return (
                  <li key={v.id}>
                    <button
                      type="button"
                      data-testid={`launcher-app-${v.id}`}
                      onClick={() => (secs.length ? setExpanded(isOpen ? null : v.id) : go(v.id))}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg-muted transition hover:bg-surface-raised hover:text-fg"
                    >
                      <span className="grid h-6 w-6 shrink-0 place-items-center rounded bg-primary-500/10 text-primary-500">
                        <PluginIcon icon={v.icon} className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium">{v.name}</span>
                      {secs.length > 0 &&
                        (isOpen ? (
                          <HiOutlineChevronDown className="shrink-0 text-fg-subtle" />
                        ) : (
                          <HiOutlineChevronRight className="shrink-0 text-fg-subtle" />
                        ))}
                    </button>
                    {isOpen && secs.length > 0 && (
                      <ul className="mb-1 ml-8 space-y-0.5 border-l border-border pl-2">
                        <li>
                          <button
                            type="button"
                            data-testid={`launcher-open-${v.id}`}
                            onClick={() => go(v.id)}
                            className="block w-full rounded px-2 py-1 text-left text-xs text-fg-subtle transition hover:bg-surface-raised hover:text-fg"
                          >
                            {t('launcher.openApp')}
                          </button>
                        </li>
                        {secs.map((s) => (
                          <li key={s.id}>
                            <button
                              type="button"
                              data-testid={`launcher-section-${v.id}-${s.id}`}
                              onClick={() => go(v.id, s.id)}
                              className="block w-full rounded px-2 py-1 text-left text-xs text-fg-muted transition hover:bg-surface-raised hover:text-fg"
                            >
                              {t(s.labelKey)}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
