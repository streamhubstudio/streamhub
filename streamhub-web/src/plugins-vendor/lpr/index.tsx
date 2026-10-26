/**
 * Frontend plugin: LPR — License Plate Recognition.
 *
 * Auto-discovered (src/plugins/lpr/index.tsx default-export) — no central
 * edit. Mirrors the streamhub-core `lpr` plugin's config so the Marketplace
 * can configure the worker, and ships an APP-TAB panel with:
 *   - the recent reads table (plate, time, confidence, list-match badge,
 *     snapshot) fed by the authenticated live-data read
 *     (GET /apps/:app/plugins/lpr/data — the worker pushes a rolling ring),
 *   - a whitelist/blacklist editor that PATCHes the plugin config (the
 *     framework restarts the worker with the new lists).
 *
 * All parsing/normalization is in the PURE util.ts (covered by node:test);
 * this file is the thin React shell (poll, table, forms).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { definePlugin } from '@/plugins'
import type { PluginComponentProps } from '../../plugins/types.ts'
import { pluginsApi } from '../../plugins/api.ts'
import { Badge, Button, Card, ErrorBanner, Field, Textarea, errMessage } from '../../plugins/ui.tsx'
import { fetchLprLive, type LprLiveResult } from './api.ts'
import { canonicalListConfig, snapshotName, type LprRead } from './util.ts'

const CAR_ICON =
  'M3 13l1.5-4.5A2 2 0 016.4 7h11.2a2 2 0 011.9 1.5L21 13M5 13h14a1 1 0 011 1v3h-2a2 2 0 11-4 0H9a2 2 0 11-4 0H3v-3a1 1 0 011-1z'

const POLL_MS = 3000

/** Poll the worker's live ring while the tab is mounted. */
function useLprLive(app: string | undefined, room: string): {
  view: LprLiveResult | null
  error: string | null
} {
  const [view, setView] = useState<LprLiveResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!app) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const next = await fetchLprLive(app, room)
        if (alive) {
          setView(next)
          setError(null)
        }
      } catch (e) {
        if (alive) setError(errMessage(e, 'live data unavailable'))
      }
      timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      alive = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [app, room])
  return { view, error }
}

function MatchBadge({ match }: { match: LprRead['listMatch'] }) {
  const { t } = useTranslation('lpr')
  if (match === 'whitelist') return <Badge tone="green">{t('panel.allowed')}</Badge>
  if (match === 'blacklist') return <Badge tone="red">{t('panel.denied')}</Badge>
  return <Badge tone="slate">{t('panel.noMatch')}</Badge>
}

function timeLabel(ts: number): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleTimeString()
}

function ReadsTable({ reads }: { reads: LprRead[] }) {
  const { t } = useTranslation('lpr')
  if (reads.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">{t('panel.empty')}</p>
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
            <th className="py-2 pr-3">{t('panel.colPlate')}</th>
            <th className="py-2 pr-3">{t('panel.colTime')}</th>
            <th className="py-2 pr-3">{t('panel.colConfidence')}</th>
            <th className="py-2 pr-3">{t('panel.colMatch')}</th>
            <th className="py-2">{t('panel.colSnapshot')}</th>
          </tr>
        </thead>
        <tbody>
          {reads.map((r, i) => (
            <tr
              key={`${r.plate}-${r.ts}-${i}`}
              className="border-b border-gray-100 last:border-0 dark:border-gray-800"
            >
              <td className="py-2 pr-3 font-mono font-semibold text-gray-800 dark:text-gray-100">
                {r.plate}
              </td>
              <td className="py-2 pr-3 tabular-nums text-gray-600 dark:text-gray-300">
                {timeLabel(r.ts)}
              </td>
              <td className="py-2 pr-3 tabular-nums text-gray-600 dark:text-gray-300">
                {r.confidence ? `${Math.round(r.confidence * 100)}%` : '—'}
              </td>
              <td className="py-2 pr-3">
                <MatchBadge match={r.listMatch} />
              </td>
              <td
                className="max-w-[14rem] truncate py-2 text-xs text-gray-500 dark:text-gray-400"
                title={r.snapshot ?? undefined}
              >
                {snapshotName(r.snapshot) || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Whitelist/blacklist editor — PATCHes the plugin config on save. */
function ListsEditor({ app, config }: { app: string; config: PluginComponentProps['ctx']['config'] }) {
  const { t } = useTranslation('lpr')
  const [whitelist, setWhitelist] = useState(() =>
    canonicalListConfig(String(config.whitelist ?? '')),
  )
  const [blacklist, setBlacklist] = useState(() =>
    canonicalListConfig(String(config.blacklist ?? '')),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => {
    if (savedTimer.current !== undefined) clearTimeout(savedTimer.current)
  }, [])

  const onSave = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await pluginsApi.config(app, 'lpr', {
        whitelist: canonicalListConfig(whitelist),
        blacklist: canonicalListConfig(blacklist),
      })
      setWhitelist((v) => canonicalListConfig(v))
      setBlacklist((v) => canonicalListConfig(v))
      setSaved(true)
      savedTimer.current = setTimeout(() => setSaved(false), 2500)
    } catch (e) {
      setError(errMessage(e, t('panel.saveError')))
    } finally {
      setBusy(false)
    }
  }, [app, whitelist, blacklist, t])

  return (
    <section className="space-y-3">
      <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-100">
        {t('panel.listsTitle')}
      </h4>
      {error && <ErrorBanner message={error} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('panel.whitelist')} hint={t('panel.listHint')}>
          <Textarea
            rows={5}
            value={whitelist}
            onChange={(e) => setWhitelist(e.target.value)}
            placeholder={'AB123CD\nAA000AA'}
            className="font-mono"
          />
        </Field>
        <Field label={t('panel.blacklist')} hint={t('panel.blacklistHint')}>
          <Textarea
            rows={5}
            value={blacklist}
            onChange={(e) => setBlacklist(e.target.value)}
            placeholder={'XX999XX'}
            className="font-mono"
          />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button variant="accent" onClick={() => void onSave()} disabled={busy}>
          {busy ? t('panel.saving') : t('panel.save')}
        </Button>
        {saved && <span className="text-xs text-emerald-600 dark:text-emerald-400">{t('panel.savedNote')}</span>}
      </div>
    </section>
  )
}

function LprPanel({ ctx }: PluginComponentProps) {
  const { t } = useTranslation('lpr')
  const room = String(ctx.config.room ?? '')
  const { view, error } = useLprLive(ctx.app, room)
  const last = view?.last ?? null

  return (
    <div className="space-y-6">
      {!room && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-500/10 dark:text-amber-200">
          {t('panel.noRoom')}
        </p>
      )}
      {error && <ErrorBanner message={error} />}

      {last && (
        <Card className="p-4">
          <div className="flex flex-wrap items-center gap-4">
            {last.thumb && (
              <img
                src={`data:image/jpeg;base64,${last.thumb}`}
                alt={last.plate}
                className="h-20 rounded-lg object-cover"
              />
            )}
            <div>
              <div className="font-mono text-2xl font-bold text-gray-800 dark:text-gray-100">
                {last.plate}
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                <MatchBadge match={last.listMatch} />
                <span className="tabular-nums">
                  {timeLabel(last.ts)}
                  {last.confidence ? ` · ${Math.round(last.confidence * 100)}%` : ''}
                </span>
              </div>
            </div>
          </div>
        </Card>
      )}

      <section className="space-y-3">
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-100">
          {t('panel.recentTitle')}
        </h4>
        <ReadsTable reads={view?.recent ?? []} />
      </section>

      {ctx.app && <ListsEditor app={ctx.app} config={ctx.config} />}

      <p className="text-xs text-gray-500 dark:text-gray-400">{t('panel.eventsNote')}</p>
    </div>
  )
}

export default definePlugin({
  id: 'lpr',
  kind: 'app',
  edge: true,
  name: 'LPR — License Plate Recognition',
  description:
    "Reads license plates from the app's live stream (open-source fast-alpr), matches whitelist/blacklist and emits plate events.",
  category: 'analytics',
  icon: CAR_ICON,
  version: '0.1.0',
  ui: 'app-tab',
  configSchema: {
    fields: [
      { key: 'room', type: 'string', label: 'Room / stream', required: true },
      {
        key: 'detector',
        type: 'select',
        label: 'Plate detector model',
        default: 'yolo-v9-t-384-license-plate-end2end',
        options: [
          { value: 'yolo-v9-t-256-license-plate-end2end', label: 'YOLOv9-t 256 (fastest)' },
          { value: 'yolo-v9-t-384-license-plate-end2end', label: 'YOLOv9-t 384 (balanced)' },
          { value: 'yolo-v9-t-512-license-plate-end2end', label: 'YOLOv9-t 512 (accurate)' },
        ],
      },
      {
        key: 'ocrModel',
        type: 'select',
        label: 'OCR model',
        default: 'cct-xs-v1-global-model',
        options: [
          { value: 'cct-xs-v1-global-model', label: 'CCT-XS global (fast)' },
          { value: 'cct-s-v1-global-model', label: 'CCT-S global (accurate)' },
        ],
      },
      {
        key: 'confidence',
        type: 'number',
        label: 'Min OCR confidence',
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.05,
      },
      { key: 'fps', type: 'number', label: 'Sample FPS', default: 2, min: 0.1, max: 30, step: 0.5 },
      {
        key: 'dedupeWindowSec',
        type: 'number',
        label: 'Dedupe window (seconds)',
        default: 10,
        min: 0,
        max: 300,
      },
      { key: 'whitelist', type: 'textarea', label: 'Whitelist plates', default: '' },
      { key: 'blacklist', type: 'textarea', label: 'Blacklist plates', default: '' },
      { key: 'callbackUrl', type: 'url', label: 'Direct callback URL', default: '' },
      { key: 'snapshots', type: 'boolean', label: 'Save snapshots', default: true },
      { key: 'cuda', type: 'boolean', label: 'Use CUDA (GPU)', default: false },
    ],
  },
  TabComponent: LprPanel,
})
