/**
 * Frontend plugin: fleet — StreamHub Agent management over MQTT (app tab).
 *
 * Auto-discovered (src/plugins/fleet/index.tsx default export). Mirrors the
 * streamhub-core `fleet` plugin config so the Marketplace renders the generic
 * settings form, and ships the TabComponent:
 *
 *   - a FILTERABLE agent grid (all / online / offline) with an online/offline
 *     badge, version, CPU/RAM/temp/uptime/cameras per agent;
 *   - a per-agent DETAIL drawer with metric-history sparklines (inline SVG, no
 *     chart dep) and the recent command log;
 *   - action buttons: Restart, OTA update (version + URL + sha256), Push config
 *     (JSON), Ping — each → POST /apps/:app/plugins/fleet/command, with the
 *     returned command record surfaced (and its async result polled).
 *
 * Data in: GET /apps/:app/plugins/fleet/agents (authenticated). Pure shaping +
 * formatting + the sparkline math live in logic.ts (test-covered). This file is
 * the React shell.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '@/api/http'
import { definePlugin } from '../types.ts'
import type { PluginComponentProps } from '../types.ts'
import {
  agentCounts,
  filterAgents,
  formatAge,
  formatPercent,
  formatTemp,
  formatUptime,
  parseAgents,
  sparklinePoints,
  type AgentView,
  type CommandRow,
  type FleetFilter,
  type HistoryPoint,
} from './logic.ts'

const POLL_MS = 4000

interface AgentDetail {
  agent: AgentView | null
  history: HistoryPoint[]
  commands: CommandRow[]
}

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

function useFleetAgents(app: string): {
  agents: AgentView[]
  error: boolean
  refetch: () => void
} {
  const [agents, setAgents] = useState<AgentView[]>([])
  const [error, setError] = useState(false)
  const tick = useRef<() => void>(() => {})

  useEffect(() => {
    if (!app) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = async () => {
      try {
        const res = await request<unknown>(
          `/apps/${encodeURIComponent(app)}/plugins/fleet/agents`,
        )
        if (!alive) return
        setAgents(parseAgents(res).agents)
        setError(false)
      } catch {
        if (!alive) return
        setError(true)
      }
      timer = setTimeout(run, POLL_MS)
    }
    tick.current = () => {
      if (timer !== undefined) clearTimeout(timer)
      void run()
    }
    void run()
    return () => {
      alive = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [app])

  return { agents, error, refetch: () => tick.current() }
}

function useAgentDetail(app: string, agentId: string | null): {
  detail: AgentDetail | null
  refetch: () => void
} {
  const [detail, setDetail] = useState<AgentDetail | null>(null)
  const tick = useRef<() => void>(() => {})

  useEffect(() => {
    if (!app || !agentId) {
      setDetail(null)
      return
    }
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = async () => {
      try {
        const res = await request<AgentDetail>(
          `/apps/${encodeURIComponent(app)}/plugins/fleet/agents/${encodeURIComponent(agentId)}`,
        )
        if (!alive) return
        setDetail(res)
      } catch {
        /* keep last */
      }
      timer = setTimeout(run, POLL_MS)
    }
    tick.current = () => {
      if (timer !== undefined) clearTimeout(timer)
      void run()
    }
    void run()
    return () => {
      alive = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [app, agentId])

  return { detail, refetch: () => tick.current() }
}

// ---------------------------------------------------------------------------
// Presentational bits
// ---------------------------------------------------------------------------

function StatusBadge({ online }: { online: boolean }) {
  const { t } = useTranslation('fleet')
  return online ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
      <span className="h-2 w-2 rounded-full bg-emerald-500" />
      {t('status.online')}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-200 px-2.5 py-0.5 text-[11px] font-semibold text-gray-600 dark:bg-gray-700 dark:text-gray-300">
      <span className="h-2 w-2 rounded-full bg-gray-400" />
      {t('status.offline')}
    </span>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-gray-400">{label}</span>
      <span className="text-sm font-semibold text-fg tabular-nums">{value}</span>
    </div>
  )
}

function Sparkline({ values, label }: { values: (number | null)[]; label: string }) {
  const points = sparklinePoints(values)
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-gray-400">{label}</span>
      <svg
        viewBox="0 0 120 32"
        className="h-8 w-full text-emerald-500"
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
      >
        {points ? (
          <polyline
            points={points}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}
      </svg>
    </div>
  )
}

function AgentCard({
  agent,
  selected,
  onClick,
}: {
  agent: AgentView
  selected: boolean
  onClick: () => void
}) {
  const { t } = useTranslation('fleet')
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`agent-card-${agent.agentId}`}
      className={`flex flex-col gap-3 rounded-xl border p-4 text-left transition ${
        selected
          ? 'border-emerald-500 ring-1 ring-emerald-500/40'
          : 'border-gray-200 hover:border-emerald-400 dark:border-gray-700'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-sm font-semibold text-fg">
          {agent.agentId}
        </span>
        <StatusBadge online={agent.online} />
      </div>
      <div className="flex items-center justify-between text-[11px] text-gray-500 dark:text-gray-400">
        <span>{agent.version ? `v${agent.version}` : t('agent.noVersion')}</span>
        <span>{t('agent.seen', { age: formatAge(agent.ageMs) })}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Metric label={t('metric.cpu')} value={formatPercent(agent.metrics.cpu)} />
        <Metric label={t('metric.mem')} value={formatPercent(agent.metrics.mem)} />
        <Metric label={t('metric.temp')} value={formatTemp(agent.metrics.temp)} />
        <Metric label={t('metric.uptime')} value={formatUptime(agent.metrics.uptime)} />
        <Metric
          label={t('metric.cameras')}
          value={agent.metrics.cameras == null ? '—' : String(agent.metrics.cameras)}
        />
        <Metric label={t('metric.disk')} value={formatPercent(agent.metrics.disk)} />
      </div>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Command panel (Restart / OTA / Config / Ping)
// ---------------------------------------------------------------------------

function CommandPanel({
  app,
  agentId,
  onSent,
}: {
  app: string
  agentId: string
  onSent: () => void
}) {
  const { t } = useTranslation('fleet')
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [showOta, setShowOta] = useState(false)
  const [showConfig, setShowConfig] = useState(false)
  const [ota, setOta] = useState({ version: '', url: '', sha256: '' })
  const [configText, setConfigText] = useState('{\n  \n}')

  const send = useCallback(
    async (command: string, args?: Record<string, unknown>) => {
      setBusy(command)
      setMsg(null)
      try {
        const rec = await request<CommandRow>(
          `/apps/${encodeURIComponent(app)}/plugins/fleet/command`,
          { method: 'POST', body: { agentId, command, args } },
        )
        setMsg({ kind: 'ok', text: t('cmd.queued', { command, id: rec.id.slice(0, 8) }) })
        onSent()
        return true
      } catch (e) {
        const text =
          e && typeof e === 'object' && 'message' in e
            ? String((e as { message: unknown }).message)
            : t('cmd.failed')
        setMsg({ kind: 'err', text })
        return false
      } finally {
        setBusy(null)
      }
    },
    [app, agentId, onSent, t],
  )

  const submitOta = async () => {
    const ok = await send('ota', {
      url: ota.url.trim(),
      version: ota.version.trim(),
      sha256: ota.sha256.trim(),
    })
    if (ok) setShowOta(false)
  }

  const submitConfig = async () => {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(configText)
    } catch {
      setMsg({ kind: 'err', text: t('cmd.badJson') })
      return
    }
    const ok = await send('config', { config: parsed })
    if (ok) setShowConfig(false)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void send('ping')}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:border-emerald-500 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200"
        >
          {t('action.ping')}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void send('restart')}
          className="rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-700 transition hover:border-amber-500 disabled:opacity-50 dark:border-amber-700/60 dark:text-amber-400"
        >
          {t('action.restart')}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => {
            setShowOta((v) => !v)
            setShowConfig(false)
          }}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:border-emerald-500 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200"
        >
          {t('action.ota')}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => {
            setShowConfig((v) => !v)
            setShowOta(false)
          }}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:border-emerald-500 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200"
        >
          {t('action.config')}
        </button>
      </div>

      {showOta ? (
        <div className="flex flex-col gap-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
          <input
            aria-label={t('ota.version')}
            placeholder={t('ota.version')}
            value={ota.version}
            onChange={(e) => setOta((o) => ({ ...o, version: e.target.value }))}
            className="rounded border border-gray-200 px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-800"
          />
          <input
            aria-label={t('ota.url')}
            placeholder="https://assets.example.com/agent/1.13/streamhub-agent"
            value={ota.url}
            onChange={(e) => setOta((o) => ({ ...o, url: e.target.value }))}
            className="rounded border border-gray-200 px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-800"
          />
          <input
            aria-label={t('ota.sha256')}
            placeholder={t('ota.sha256')}
            value={ota.sha256}
            onChange={(e) => setOta((o) => ({ ...o, sha256: e.target.value }))}
            className="rounded border border-gray-200 px-2 py-1 font-mono text-xs dark:border-gray-700 dark:bg-gray-800"
          />
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void submitOta()}
            className="self-start rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
          >
            {t('ota.submit')}
          </button>
          <p className="text-[11px] leading-snug text-gray-500 dark:text-gray-400">
            {t('ota.note')}
          </p>
        </div>
      ) : null}

      {showConfig ? (
        <div className="flex flex-col gap-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
          <textarea
            aria-label={t('action.config')}
            value={configText}
            onChange={(e) => setConfigText(e.target.value)}
            rows={5}
            className="rounded border border-gray-200 px-2 py-1 font-mono text-xs dark:border-gray-700 dark:bg-gray-800"
          />
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void submitConfig()}
            className="self-start rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
          >
            {t('config.submit')}
          </button>
        </div>
      ) : null}

      {msg ? (
        <p
          data-testid="cmd-msg"
          className={`text-xs ${
            msg.kind === 'ok'
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-red-600 dark:text-red-400'
          }`}
        >
          {msg.text}
        </p>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

function AgentDetailView({
  app,
  agentId,
  onClose,
}: {
  app: string
  agentId: string
  onClose: () => void
}) {
  const { t } = useTranslation('fleet')
  const { detail, refetch } = useAgentDetail(app, agentId)
  const history = detail?.history ?? []
  const commands = detail?.commands ?? []

  return (
    <aside className="flex flex-col gap-4 rounded-xl border border-gray-200 p-4 dark:border-gray-700">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate font-mono text-sm font-semibold text-fg">{agentId}</h3>
          {detail?.agent ? <StatusBadge online={detail.agent.online} /> : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-500 dark:border-gray-700"
        >
          {t('detail.close')}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Sparkline label={t('metric.cpu')} values={history.map((h) => h.cpu)} />
        <Sparkline label={t('metric.mem')} values={history.map((h) => h.mem)} />
        <Sparkline label={t('metric.temp')} values={history.map((h) => h.temp)} />
        <Sparkline label={t('metric.disk')} values={history.map((h) => h.disk)} />
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          {t('detail.control')}
        </h4>
        <CommandPanel app={app} agentId={agentId} onSent={refetch} />
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          {t('detail.commands')}
        </h4>
        {commands.length === 0 ? (
          <p className="text-xs text-gray-400">{t('detail.noCommands')}</p>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="cmd-log">
            {commands.map((c) => (
              <li
                key={c.id}
                className="flex items-center justify-between gap-2 rounded-md bg-gray-50 px-2 py-1 text-[11px] dark:bg-gray-800/60"
              >
                <span className="font-mono text-fg">{c.command}</span>
                <span
                  className={
                    c.status === 'ok'
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : c.status === 'error'
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-amber-600 dark:text-amber-400'
                  }
                >
                  {t(`cmdStatus.${c.status}`)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

function FleetTab({ ctx }: PluginComponentProps) {
  const { t } = useTranslation('fleet')
  const app = ctx.app ?? ''
  const { agents, error } = useFleetAgents(app)
  const [filter, setFilter] = useState<FleetFilter>('all')
  const [selected, setSelected] = useState<string | null>(null)

  const counts = agentCounts(agents)
  const shown = filterAgents(agents, filter)

  if (!app) return null

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-gray-200 p-0.5 dark:border-gray-700">
            {(['all', 'online', 'offline'] as FleetFilter[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                data-testid={`filter-${f}`}
                className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                  filter === f
                    ? 'bg-emerald-600 text-white'
                    : 'text-gray-600 hover:text-emerald-600 dark:text-gray-300'
                }`}
              >
                {t(`filter.${f}`, { count: counts[f] })}
              </button>
            ))}
          </div>
          {error ? (
            <span className="text-xs text-red-600 dark:text-red-400">
              {t('error.load')}
            </span>
          ) : null}
        </div>

        {shown.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500 dark:border-gray-700">
            {t('empty')}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2" data-testid="agent-grid">
            {shown.map((agent) => (
              <AgentCard
                key={agent.agentId}
                agent={agent}
                selected={selected === agent.agentId}
                onClick={() => setSelected(agent.agentId)}
              />
            ))}
          </div>
        )}
      </section>

      {selected ? (
        <AgentDetailView app={app} agentId={selected} onClose={() => setSelected(null)} />
      ) : (
        <aside className="hidden rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 lg:block dark:border-gray-700">
          {t('detail.pick')}
        </aside>
      )}
    </div>
  )
}

export default definePlugin({
  id: 'fleet',
  kind: 'app',
  name: 'Fleet — Agent Management',
  description:
    'Connect to the StreamHub Agents in this app over MQTT: live health, ' +
    'online/offline status and remote control (restart, OTA, config, ping).',
  category: 'tool',
  ui: 'app-tab',
  version: '0.1.0',
  icon: 'M4 5h16v6H4V5zm0 8h16v6H4v-6zm3-6v2m0 8v2',
  configSchema: {
    fields: [
      {
        key: 'offlineAfterSec',
        type: 'number',
        label: 'Offline after (seconds)',
        default: 90,
        min: 10,
        max: 3600,
      },
      {
        key: 'historyPoints',
        type: 'number',
        label: 'History points per agent',
        default: 120,
        min: 10,
        max: 1000,
      },
      {
        key: 'commandTimeoutSec',
        type: 'number',
        label: 'Command timeout (seconds)',
        default: 30,
        min: 5,
        max: 600,
      },
    ],
  },
  TabComponent: FleetTab,
})
