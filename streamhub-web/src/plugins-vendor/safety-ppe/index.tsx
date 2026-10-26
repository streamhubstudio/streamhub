/**
 * safety-ppe plugin (frontend) — PPE compliance monitor as an APP TAB.
 *
 * Auto-discovered by src/plugins/discovery.ts. Three sections:
 *   - VIOLATIONS: live table (time, zone, missing item, confidence, snapshot)
 *     polled from the plugin logs endpoint — the worker emits one structured
 *     `violation` JSON line per fired event; the durable archive lives in
 *     <DATA_DIR>/safety-ppe.db on the server.
 *   - ZONES: editor for the normalized work-zone rects (config `zones`).
 *   - SCHEDULE & RULES: work hours/days + sustain/cooldown knobs.
 * Zone/schedule edits persist via the standard plugin config PATCH, which
 * also restarts the worker with the fresh config.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { request } from '@/api/http'
import { Button } from '@/ui'
import { pluginsApi } from '../../plugins/api.ts'
import { definePlugin } from '../../plugins/types.ts'
import type { ConfigValues, PluginComponentProps } from '../../plugins/types.ts'
import {
  clamp01,
  isValidDays,
  isValidHours,
  parseViolationLogs,
  parseZones,
  serializeZones,
} from './logic.ts'
import type { ViolationRow, WorkerLogLine, ZoneDraft } from './logic.ts'

const POLL_MS = 5000

interface LogsResponse {
  pluginId?: string
  worker?: { status?: string }
  workerLogs?: WorkerLogLine[]
}

function fmtTime(tsSeconds: number): string {
  if (!tsSeconds) return '—'
  return new Date(tsSeconds * 1000).toLocaleString()
}

function MissingBadge({ item }: { item: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300">
      {item === 'helmet' ? 'no helmet' : item === 'vest' ? 'no vest' : item}
    </span>
  )
}

function Card({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5 dark:border-gray-700 dark:bg-gray-800">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {aside}
      </div>
      {children}
    </div>
  )
}

const inputCls =
  'w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm text-fg ' +
  'dark:border-gray-700 dark:bg-gray-700'

function SafetyPpeTab({ ctx }: PluginComponentProps) {
  const app = ctx.app ?? ''

  // -- violations table (poll worker logs) ---------------------------------
  const [rows, setRows] = useState<ViolationRow[]>([])
  const [workerStatus, setWorkerStatus] = useState<string>('unknown')
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    if (!app) return
    let alive = true
    const controller = new AbortController()
    async function load() {
      try {
        const res = await request<LogsResponse>(
          `/apps/${encodeURIComponent(app)}/plugins/safety-ppe/logs`,
          { query: { limit: 500 }, signal: controller.signal },
        )
        if (!alive) return
        setRows(parseViolationLogs(res?.workerLogs ?? []))
        setWorkerStatus(res?.worker?.status ?? 'stopped')
        setLoadError(false)
      } catch {
        if (alive) setLoadError(true)
      }
    }
    void load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      alive = false
      controller.abort()
      clearInterval(timer)
    }
  }, [app])

  // -- zones + schedule editor (config PATCH) ------------------------------
  const [zones, setZones] = useState<ZoneDraft[]>(() => parseZones(ctx.config?.zones))
  const [workHours, setWorkHours] = useState(String(ctx.config?.workHours ?? ''))
  const [workDays, setWorkDays] = useState(String(ctx.config?.workDays ?? ''))
  const [sustainFrames, setSustainFrames] = useState(Number(ctx.config?.sustainFrames ?? 3))
  const [cooldownSeconds, setCooldownSeconds] = useState(Number(ctx.config?.cooldownSeconds ?? 120))
  const [saving, setSaving] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'ok' | 'error'>('idle')

  const hoursOk = isValidHours(workHours)
  const daysOk = isValidDays(workDays)

  const setZone = useCallback((i: number, patch: Partial<ZoneDraft>) => {
    setZones((zs) => zs.map((z, idx) => (idx === i ? { ...z, ...patch } : z)))
  }, [])

  const save = useCallback(async () => {
    if (!app) return
    setSaving(true)
    setSaveState('idle')
    try {
      const config: ConfigValues = {
        ...ctx.config,
        zones: serializeZones(zones),
        workHours: workHours.trim(),
        workDays: workDays.trim(),
        sustainFrames,
        cooldownSeconds,
      }
      await pluginsApi.config(app, 'safety-ppe', config)
      setSaveState('ok')
    } catch {
      setSaveState('error')
    } finally {
      setSaving(false)
    }
  }, [app, ctx.config, zones, workHours, workDays, sustainFrames, cooldownSeconds])

  const statusBadge = useMemo(() => {
    const running = workerStatus === 'running' || workerStatus === 'starting'
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700 ring-1 ring-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:ring-gray-700">
        <span className={`h-1.5 w-1.5 rounded-full ${running ? 'animate-pulse bg-primary-500' : 'bg-gray-300 dark:bg-gray-600'}`} />
        worker: {workerStatus}
      </span>
    )
  }, [workerStatus])

  if (!app) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-6 text-center shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          safety-ppe renders inside an app.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-[12px] leading-snug text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-300">
        <strong>Experimental.</strong> Detections come from a community-trained
        model with self-reported accuracy — treat events as advisory signals,
        not as a certified safety system.
      </p>

      <Card title="Violations" aside={statusBadge}>
        {loadError && (
          <p className="mb-2 text-xs text-amber-600 dark:text-amber-400">
            Could not load the plugin logs — is the plugin installed and enabled?
          </p>
        )}
        {rows.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No violations in the recent worker log window. The full history is
            kept server-side in <code className="font-mono text-xs">safety-ppe.db</code>.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  <th className="py-2 pr-4 font-medium">Time</th>
                  <th className="py-2 pr-4 font-medium">Zone</th>
                  <th className="py-2 pr-4 font-medium">Missing</th>
                  <th className="py-2 pr-4 font-medium">Confidence</th>
                  <th className="py-2 font-medium">Snapshot</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.ts}-${r.zone}-${i}`} className="border-b border-gray-100 last:border-0 dark:border-gray-700/60">
                    <td className="py-2 pr-4 whitespace-nowrap text-fg">{fmtTime(r.ts)}</td>
                    <td className="py-2 pr-4 text-fg">{r.zone}</td>
                    <td className="py-2 pr-4">
                      <span className="flex flex-wrap gap-1">
                        {r.missing.map((m) => (
                          <MissingBadge key={m} item={m} />
                        ))}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-gray-600 dark:text-gray-300">
                      {(r.confidence * 100).toFixed(0)}%
                    </td>
                    <td className="max-w-[220px] truncate py-2 font-mono text-xs text-gray-500 dark:text-gray-400" title={r.snapshot}>
                      {r.snapshot || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          title="Work zones"
          aside={
            <Button
              variant="default"
              size="sm"
              onClick={() => setZones((zs) => [...zs, { name: `zone-${zs.length + 1}`, x: 0, y: 0, w: 1, h: 1 }])}
            >
              Add zone
            </Button>
          }
        >
          <p className="mb-3 text-[11px] leading-snug text-gray-500 dark:text-gray-400">
            Frame-relative rects (0–1). A person belongs to a zone when their
            feet (bottom-center of the detection box) are inside it. No zones =
            the whole frame is monitored as zone “all”.
          </p>
          {zones.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Monitoring the full frame (zone “all”).
            </p>
          ) : (
            <div className="flex flex-col gap-2 overflow-x-auto">
              <div className="grid min-w-[420px] grid-cols-[1fr_repeat(4,64px)_32px] items-center gap-2 text-[11px] font-medium text-gray-500 dark:text-gray-400">
                <span>Name</span>
                <span>x</span>
                <span>y</span>
                <span>w</span>
                <span>h</span>
                <span />
              </div>
              {zones.map((z, i) => (
                <div key={i} className="grid min-w-[420px] grid-cols-[1fr_repeat(4,64px)_32px] items-center gap-2">
                  <input
                    className={inputCls}
                    value={z.name}
                    onChange={(e) => setZone(i, { name: e.target.value })}
                    placeholder="dock"
                  />
                  {(['x', 'y', 'w', 'h'] as const).map((k) => (
                    <input
                      key={k}
                      className={inputCls}
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={z[k]}
                      onChange={(e) => setZone(i, { [k]: clamp01(Number(e.target.value)) })}
                    />
                  ))}
                  <button
                    type="button"
                    aria-label={`Remove zone ${z.name}`}
                    className="rounded-md px-2 py-1 text-sm text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-700"
                    onClick={() => setZones((zs) => zs.filter((_, idx) => idx !== i))}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Schedule & rules">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                Work hours (HH:MM-HH:MM, empty = always)
              </span>
              <input
                className={inputCls}
                value={workHours}
                onChange={(e) => setWorkHours(e.target.value)}
                placeholder="08:00-18:00"
              />
              {!hoursOk && (
                <span className="mt-1 block text-[11px] text-amber-600 dark:text-amber-400">
                  Invalid — the worker will treat this as “always on”.
                </span>
              )}
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                Work days (empty = every day)
              </span>
              <input
                className={inputCls}
                value={workDays}
                onChange={(e) => setWorkDays(e.target.value)}
                placeholder="mon-fri"
              />
              {!daysOk && (
                <span className="mt-1 block text-[11px] text-amber-600 dark:text-amber-400">
                  Invalid — the worker will treat this as “every day”.
                </span>
              )}
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                Sustain frames (fires after N+1 consecutive)
              </span>
              <input
                className={inputCls}
                type="number"
                min={0}
                max={60}
                value={sustainFrames}
                onChange={(e) => setSustainFrames(Math.max(0, Math.min(60, Number(e.target.value) || 0)))}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                Cooldown per zone+item (seconds)
              </span>
              <input
                className={inputCls}
                type="number"
                min={5}
                max={3600}
                value={cooldownSeconds}
                onChange={(e) => setCooldownSeconds(Math.max(5, Math.min(3600, Number(e.target.value) || 5)))}
              />
            </label>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Button variant="solid" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save zones & schedule'}
            </Button>
            {saveState === 'ok' && (
              <span className="text-xs text-primary-600 dark:text-primary-400">
                Saved — the worker restarts with the new config.
              </span>
            )}
            {saveState === 'error' && (
              <span className="text-xs text-red-600 dark:text-red-400">Save failed.</span>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}

export default definePlugin({
  id: 'safety-ppe',
  kind: 'app',
  name: 'Safety PPE Monitor',
  description:
    'EXPERIMENTAL: flags persons without helmet / hi-viz vest in configured ' +
    'work zones during work hours, with evidence snapshots. Advisory only.',
  category: 'monitoring',
  ui: 'app-tab',
  version: '0.1.0',
  // Hard hat glyph (stroke path).
  icon: 'M4 15a8 8 0 0116 0M4 15h16M4 15v2h16v-2M10 7.5V5h4v2.5',
  configSchema: {
    fields: [
      { key: 'room', type: 'string', label: 'Room / stream', default: '', required: true, placeholder: 'live' },
      { key: 'requireHelmet', type: 'boolean', label: 'Require helmet', default: true },
      { key: 'requireVest', type: 'boolean', label: 'Require safety vest', default: true },
      {
        key: 'zones',
        type: 'textarea',
        label: 'Work zones (JSON — use the tab editor)',
        default: '',
        placeholder: '[{"name":"dock","rect":[0.1,0.2,0.5,0.7]}]',
      },
      { key: 'workHours', type: 'string', label: 'Work hours', default: '', placeholder: '08:00-18:00' },
      { key: 'workDays', type: 'string', label: 'Work days', default: '', placeholder: 'mon-fri' },
      { key: 'sustainFrames', type: 'number', label: 'Sustain frames', default: 3, min: 0, max: 60 },
      { key: 'cooldownSeconds', type: 'number', label: 'Cooldown (seconds)', default: 120, min: 5, max: 3600 },
      { key: 'confidence', type: 'number', label: 'Detection confidence', default: 0.35, min: 0, max: 1, step: 0.05 },
      { key: 'association', type: 'number', label: 'Association threshold', default: 0.5, min: 0.05, max: 1, step: 0.05 },
      { key: 'fps', type: 'number', label: 'Sample FPS', default: 1, min: 0.1, max: 10, step: 0.1 },
      { key: 'cuda', type: 'boolean', label: 'Use CUDA (GPU)', default: false },
      { key: 'callbackUrl', type: 'url', label: 'Violation webhook URL', default: '' },
      { key: 'callbackSecret', type: 'secret', label: 'Webhook HMAC secret', default: '' },
      {
        key: 'modelUrl',
        type: 'url',
        label: 'Model URL (ONNX)',
        default: 'https://huggingface.co/Hexmon/vyra-yolo-ppe-detection/resolve/main/best.onnx',
      },
    ],
  },
  TabComponent: SafetyPpeTab,
})
