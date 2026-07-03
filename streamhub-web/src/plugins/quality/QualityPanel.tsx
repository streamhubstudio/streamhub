/**
 * Quality / Stream Health — the panel surface (ui: 'panel').
 *
 * Runs a client-side connection-quality test against the server and distills it
 * into a traffic light. ALL grading is the pure health.logic.ts (unit-tested);
 * this component is a thin shell that (1) fires the impure bandwidth runner,
 * (2) feeds the raw numbers to `classifyHealth`, and (3) renders the lamps +
 * per-metric rows. See bandwidth.ts for exactly where each number comes from.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { API_BASE } from '@/api'
import type { PluginComponentProps } from '@/plugins'
import { Badge, Button, Card, ErrorBanner, errMessage } from '@/plugins/ui'
import {
  classifyHealth,
  formatKbps,
  formatMbps,
  formatMs,
  mbpsToKbps,
  resolveThresholds,
  type HealthMetrics,
  type HealthReport,
  type LightOrUnknown,
} from './health.logic.ts'
import { measureLatency, runDownloadTest, runUploadTest } from './bandwidth.ts'

/** Fixed upload payload (only used when an upload_url is configured). */
const UPLOAD_BYTES = 2 * 1024 * 1024

const LAMP_ON: Record<'green' | 'yellow' | 'red', string> = {
  green: 'bg-emerald-500 shadow-[0_0_12px_2px] shadow-emerald-500/60',
  yellow: 'bg-amber-400 shadow-[0_0_12px_2px] shadow-amber-400/60',
  red: 'bg-red-500 shadow-[0_0_12px_2px] shadow-red-500/60',
}
const LAMP_OFF: Record<'green' | 'yellow' | 'red', string> = {
  green: 'bg-emerald-500/15',
  yellow: 'bg-amber-400/15',
  red: 'bg-red-500/15',
}

/** The 3-lamp traffic light. `active` is the currently-lit lamp (or none). */
function TrafficLight({ active }: { active: LightOrUnknown }) {
  const order: Array<'red' | 'yellow' | 'green'> = ['red', 'yellow', 'green']
  return (
    <div className="inline-flex flex-col items-center gap-2 rounded-2xl bg-gray-900 px-3 py-3 dark:bg-black/60">
      {order.map((lamp) => (
        <span
          key={lamp}
          className={`h-8 w-8 rounded-full transition-all ${
            active === lamp ? LAMP_ON[lamp] : LAMP_OFF[lamp]
          }`}
          aria-hidden="true"
        />
      ))}
    </div>
  )
}

const DOT: Record<LightOrUnknown, string> = {
  green: 'bg-emerald-500',
  yellow: 'bg-amber-400',
  red: 'bg-red-500',
  unknown: 'bg-gray-300 dark:bg-gray-600',
}

function MetricRow({
  label,
  value,
  unit,
  light,
}: {
  label: string
  value: string
  unit?: string
  light: LightOrUnknown
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-gray-100 py-2 last:border-0 dark:border-gray-700/60">
      <span className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[light]}`} aria-hidden="true" />
        {label}
      </span>
      <span className="font-mono text-sm tabular-nums text-fg">
        {value}
        {unit && <span className="ml-1 text-xs text-gray-400">{unit}</span>}
      </span>
    </div>
  )
}

export function QualityPanel({ ctx }: PluginComponentProps) {
  const { t } = useTranslation('quality')
  const thresholds = resolveThresholds(ctx.config)
  const pingUrl = `${API_BASE}/health`

  const [running, setRunning] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'latency' | 'download' | 'upload' | 'done'>('idle')
  const [progressBytes, setProgressBytes] = useState(0)
  const [metrics, setMetrics] = useState<HealthMetrics | null>(null)
  const [report, setReport] = useState<HealthReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Abort any in-flight test if the panel unmounts.
  useEffect(() => () => abortRef.current?.abort(), [])

  async function run() {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const { signal } = controller

    setRunning(true)
    setError(null)
    setReport(null)
    setMetrics(null)
    setProgressBytes(0)

    try {
      setPhase('latency')
      const lat = await measureLatency(pingUrl, 5, { signal })

      setPhase('download')
      const dl = await runDownloadTest(
        thresholds.downloadUrl,
        thresholds.downloadTargetBytes,
        { signal, onProgress: (bytes) => setProgressBytes(bytes) },
      )

      setPhase('upload')
      const ul = await runUploadTest(thresholds.uploadUrl, UPLOAD_BYTES, { signal })

      const measured: HealthMetrics = {
        downMbps: dl.mbps,
        upMbps: ul?.mbps,
        rttMs: lat.rttMs,
        jitterMs: lat.jitterMs,
        // Sustained download expressed as a stream bitrate, graded vs the target.
        bitrateKbps: mbpsToKbps(dl.mbps),
      }
      setMetrics(measured)
      setReport(classifyHealth(measured, thresholds))
      setPhase('done')
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      setError(errMessage(err, t('error.generic')))
      setPhase('idle')
    } finally {
      if (abortRef.current === controller) {
        setRunning(false)
        abortRef.current = null
      }
    }
  }

  const overall = report?.overall ?? 'unknown'
  const verdictKey =
    overall === 'green'
      ? 'verdict.green'
      : overall === 'yellow'
        ? 'verdict.yellow'
        : overall === 'red'
          ? 'verdict.red'
          : 'verdict.idle'

  const progressMb = progressBytes / (1024 * 1024)

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-fg">{t('title')}</h2>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{t('subtitle')}</p>
        </div>
        <Button variant="accent" onClick={run} disabled={running}>
          {running ? t('actions.running') : t('actions.run')}
        </Button>
      </div>

      {error && (
        <div className="mb-4">
          <ErrorBanner message={error} />
        </div>
      )}

      <div className="flex flex-col gap-5 sm:flex-row sm:items-stretch">
        {/* Traffic light + verdict */}
        <div className="flex flex-row items-center gap-4 sm:flex-col sm:justify-center">
          <TrafficLight active={overall} />
          <Badge
            tone={
              overall === 'green'
                ? 'green'
                : overall === 'yellow'
                  ? 'amber'
                  : overall === 'red'
                    ? 'red'
                    : 'slate'
            }
          >
            {t(verdictKey)}
          </Badge>
        </div>

        {/* Metrics */}
        <div className="min-w-0 flex-1">
          {report && metrics ? (
            <div className="rounded-lg border border-gray-100 px-3 dark:border-gray-700/60">
              <MetricRow
                label={t('metric.download')}
                value={formatMbps(metrics.downMbps)}
                unit={t('unit.mbps')}
                light={report.download}
              />
              <MetricRow
                label={t('metric.upload')}
                value={metrics.upMbps === undefined ? t('metric.uploadSkipped') : formatMbps(metrics.upMbps)}
                unit={metrics.upMbps === undefined ? undefined : t('unit.mbps')}
                light={report.upload}
              />
              <MetricRow
                label={t('metric.bitrate')}
                value={formatKbps(metrics.bitrateKbps)}
                unit={t('unit.kbps')}
                light={report.bitrate}
              />
              <MetricRow
                label={t('metric.latency')}
                value={formatMs(metrics.rttMs)}
                unit={t('unit.ms')}
                light={report.latency}
              />
              <MetricRow
                label={t('metric.jitter')}
                value={formatMs(metrics.jitterMs)}
                unit={t('unit.ms')}
                light={report.latency}
              />
            </div>
          ) : (
            <div className="flex h-full min-h-[8rem] flex-col items-center justify-center rounded-lg border border-dashed border-gray-300 bg-gray-50 px-5 py-8 text-center dark:border-gray-700 dark:bg-gray-900/40">
              {running ? (
                <>
                  <p className="text-sm text-gray-600 dark:text-gray-300">{t(`phase.${phase}`)}</p>
                  {phase === 'download' && (
                    <p className="mt-1 font-mono text-xs text-gray-400">
                      {t('phase.downloaded', { mb: progressMb.toFixed(1) })}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('empty')}</p>
              )}
            </div>
          )}

          {report && (
            <p className="mt-3 text-[11px] leading-snug text-gray-400 dark:text-gray-500">
              {metrics?.upMbps === undefined ? t('note.uploadOptional') : t('note.measured')}
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}
