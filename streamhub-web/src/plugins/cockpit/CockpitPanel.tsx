/**
 * Cockpit — the CCTV surveillance board panel.
 *
 * A self-contained plugin surface (ui: 'panel'): it picks an app, polls its
 * active streams and lays their PUBLIC embed players out in a configurable,
 * paginated, drag-reorderable grid. Grid size / auto-play / labels default from
 * the plugin config and are then tweakable live (persisted per app in
 * localStorage). All the arithmetic (paging / ordering) is the pure grid.ts.
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api } from '@/api'
import type { Stream } from '@/api'
import type { PluginComponentProps } from '@/plugins'
import { Badge, Button, ErrorBanner, Select, Toggle, errMessage } from '@/plugins/ui'
import {
  GRID_LAYOUTS,
  applyOrder,
  clampPage,
  getLayout,
  normalizeSettings,
  pageCount,
  pageItems,
  moveOrder,
  reconcileOrder,
} from './grid.ts'
import { useCockpitOrder, useCockpitSettings, useSelectedApp } from './store.ts'
import { CockpitCell, CockpitEmptyCell, type CockpitCamera } from './CockpitCell.tsx'

/** Cap the configured column count on narrow viewports (mobile-first). */
function useResponsiveCols(cols: number): number {
  const read = () => {
    const w = typeof window === 'undefined' ? 1280 : window.innerWidth
    if (w < 640) return 1
    if (w < 1024) return Math.min(cols, 2)
    return cols
  }
  const [eff, setEff] = useState(read)
  useEffect(() => {
    const onResize = () => setEff(read())
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cols])
  return eff
}

function cameraOf(s: Stream): CockpitCamera {
  return {
    id: s.streamId,
    room: s.room,
    label: s.participant || s.streamId || s.room,
  }
}

export function CockpitPanel({ ctx }: PluginComponentProps) {
  const { t } = useTranslation(['cockpit', 'common'])

  // Plugin config supplies the DEFAULTS; live tweaks layer on top (per app).
  const configDefaults = useMemo(
    () => normalizeSettings(ctx.config as Record<string, unknown>),
    [ctx.config],
  )

  // --- app selection --------------------------------------------------------
  const appsQuery = useQuery({
    queryKey: ['cockpit-apps'],
    queryFn: ({ signal }) => api.apps.list(signal),
  })
  const appNames = useMemo(
    () => (appsQuery.data ?? []).map((a) => a.name),
    [appsQuery.data],
  )
  const [app, selectApp] = useSelectedApp(appNames)

  // --- settings + order (per app) ------------------------------------------
  const [settings, updateSettings] = useCockpitSettings(app, configDefaults)
  const [order, saveOrder] = useCockpitOrder(app)

  // --- streams --------------------------------------------------------------
  const streamsQuery = useQuery({
    queryKey: ['cockpit-streams', app],
    enabled: Boolean(app),
    queryFn: ({ signal }) => api.streams.list(app, signal),
    refetchInterval: settings.refreshSeconds * 1000,
    placeholderData: keepPreviousData,
  })

  const cameras = useMemo(() => {
    const active = (streamsQuery.data ?? []).filter((s) => s.status === 'active')
    return active.map(cameraOf)
  }, [streamsQuery.data])

  // Reconcile the saved order with the cameras present right now.
  const ids = useMemo(() => cameras.map((c) => c.id), [cameras])
  const reconciled = useMemo(() => reconcileOrder(order, ids), [order, ids])

  // Persist a pruned/idempotent order so removed cameras fall out of storage.
  useEffect(() => {
    if (!app) return
    if (reconciled.length !== order.length || reconciled.some((v, i) => v !== order[i])) {
      saveOrder(reconciled)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app, reconciled.join('|'), order.join('|')])

  const ordered = useMemo(
    () => applyOrder(cameras, reconciled, (c) => c.id),
    [cameras, reconciled],
  )

  // --- paging ---------------------------------------------------------------
  const layout = getLayout(settings.gridSize)
  const perPage = layout.cells
  const [page, setPage] = useState(0)
  const total = pageCount(ordered.length, perPage)
  const safePage = clampPage(page, ordered.length, perPage)

  // Reset to the first page whenever the app or grid size changes.
  useEffect(() => {
    setPage(0)
  }, [app, settings.gridSize])

  const visible = pageItems(ordered, safePage, perPage)
  const cols = useResponsiveCols(layout.cols)

  // --- drag-and-drop --------------------------------------------------------
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)

  function endDrag() {
    setDraggingId(null)
    setDropTargetId(null)
  }
  function handleDrop(overId: string) {
    if (draggingId && draggingId !== overId) {
      saveOrder(moveOrder(reconciled, draggingId, overId))
    }
    endDrag()
  }

  // Empty slots to keep the grid's fixed CCTV shape when under-filled.
  const emptySlots = Math.max(0, perPage - visible.length)

  const streamsError = streamsQuery.isError ? streamsQuery.error : null

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      {/* Controls */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {appNames.length > 1 && (
          <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
            <span className="max-sm:sr-only">{t('controls.app')}</span>
            <Select
              value={app}
              onChange={(e) => selectApp(e.target.value)}
              className="!w-auto !py-1.5 text-xs"
            >
              {appNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </label>
        )}

        <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <span className="max-sm:sr-only">{t('controls.grid')}</span>
          <Select
            value={settings.gridSize}
            onChange={(e) => updateSettings({ gridSize: e.target.value })}
            className="!w-auto !py-1.5 text-xs"
            aria-label={t('controls.grid')}
          >
            {GRID_LAYOUTS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.id === '1x1' ? '1 × 1' : `${l.cols} × ${l.rows} (${l.cells})`}
              </option>
            ))}
          </Select>
        </label>

        <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <Toggle
            checked={settings.autoPlay}
            onChange={(v) => updateSettings({ autoPlay: v })}
          />
          {t('controls.autoPlay')}
        </label>

        <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <Toggle
            checked={settings.showLabels}
            onChange={(v) => updateSettings({ showLabels: v })}
          />
          {t('controls.labels')}
        </label>

        <div className="ml-auto flex items-center gap-2">
          <Badge tone={cameras.length ? 'green' : 'slate'}>
            {t('controls.liveCount', { count: cameras.length })}
          </Badge>
          <Button
            variant="ghost"
            onClick={() => streamsQuery.refetch()}
            disabled={!app}
          >
            {streamsQuery.isFetching ? t('controls.refreshing') : t('common:actions.refresh')}
          </Button>
        </div>
      </div>

      {streamsError && (
        <div className="mb-3">
          <ErrorBanner message={errMessage(streamsError, t('error.streams'))} />
        </div>
      )}

      {/* Board */}
      {appsQuery.isLoading ? (
        <Empty label={t('state.loadingApps')} />
      ) : appNames.length === 0 ? (
        <Empty label={t('state.noApps')} />
      ) : streamsQuery.isLoading ? (
        <Empty label={t('state.loadingStreams')} />
      ) : cameras.length === 0 ? (
        <Empty label={t('state.noStreams')} hint={t('state.noStreamsHint')} />
      ) : (
        <>
          <div
            className="grid gap-2"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          >
            {visible.map((cam) => (
              <CockpitCell
                key={cam.id}
                app={app}
                camera={cam}
                autoPlay={settings.autoPlay}
                showLabels={settings.showLabels}
                dragging={draggingId === cam.id}
                dropTarget={dropTargetId === cam.id && draggingId !== cam.id}
                onDragStart={setDraggingId}
                onDragEnter={setDropTargetId}
                onDragEnd={endDrag}
                onDrop={handleDrop}
              />
            ))}
            {Array.from({ length: emptySlots }).map((_, i) => (
              <CockpitEmptyCell key={`empty-${i}`} />
            ))}
          </div>

          {/* Pagination */}
          {total > 1 && (
            <div className="mt-4 flex items-center justify-center gap-3">
              <Button
                variant="ghost"
                onClick={() => setPage((p) => Math.max(0, clampPage(p, ordered.length, perPage) - 1))}
                disabled={safePage <= 0}
              >
                {t('pager.prev')}
              </Button>
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {t('pager.status', { page: safePage + 1, total })}
              </span>
              <Button
                variant="ghost"
                onClick={() => setPage((p) => clampPage(p, ordered.length, perPage) + 1)}
                disabled={safePage >= total - 1}
              >
                {t('pager.next')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Empty({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-5 py-14 text-center dark:border-gray-700 dark:bg-gray-900/40">
      <p className="text-sm text-gray-500 dark:text-gray-400">{label}</p>
      {hint && <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">{hint}</p>}
    </div>
  )
}
