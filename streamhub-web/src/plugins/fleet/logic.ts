/**
 * fleet plugin — PURE helpers (no React, no DOM), unit-tested under both
 * node:test and vitest. Kept separate from index.tsx so the data shaping +
 * formatting + the tiny inline-SVG sparkline math are testable without mounting.
 */

export interface AgentMetrics {
  cpu: number | null
  mem: number | null
  temp: number | null
  uptime: number | null
  cameras: number | null
  disk: number | null
  /** Battery percent, null on hosts with no battery (most of the fleet). */
  battery: number | null
  relay: string | null
}

export interface AgentView {
  agentId: string
  online: boolean
  status: 'online' | 'offline'
  version: string | null
  lastSeen: string
  ageMs: number | null
  metrics: AgentMetrics
}

export interface AgentsResponse {
  agents: AgentView[]
  generatedAt: string
}

export interface HistoryPoint {
  ts: string
  cpu: number | null
  mem: number | null
  temp: number | null
  disk: number | null
  cameras: number | null
}

export interface CommandRow {
  id: string
  agentId: string
  command: string
  args: Record<string, unknown>
  status: 'pending' | 'ok' | 'error'
  result: Record<string, unknown> | null
  createdAt: string
  resolvedAt: string | null
}

export type FleetFilter = 'all' | 'online' | 'offline'

/** Coerce an unknown API body into a safe AgentsResponse. */
export function parseAgents(body: unknown): AgentsResponse {
  const b = (body ?? {}) as { agents?: unknown; generatedAt?: unknown }
  const agents = Array.isArray(b.agents)
    ? b.agents.map(parseAgent).filter((a): a is AgentView => a !== null)
    : []
  return {
    agents,
    generatedAt: typeof b.generatedAt === 'string' ? b.generatedAt : '',
  }
}

function parseAgent(raw: unknown): AgentView | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const agentId = typeof r.agentId === 'string' ? r.agentId : ''
  if (!agentId) return null
  const m = (r.metrics ?? {}) as Record<string, unknown>
  return {
    agentId,
    online: r.online === true,
    status: r.status === 'online' ? 'online' : 'offline',
    version: typeof r.version === 'string' ? r.version : null,
    lastSeen: typeof r.lastSeen === 'string' ? r.lastSeen : '',
    ageMs: typeof r.ageMs === 'number' ? r.ageMs : null,
    metrics: {
      cpu: numOrNull(m.cpu),
      mem: numOrNull(m.mem),
      temp: numOrNull(m.temp),
      uptime: numOrNull(m.uptime),
      cameras: numOrNull(m.cameras),
      disk: numOrNull(m.disk),
      battery: numOrNull(m.battery),
      relay: typeof m.relay === 'string' ? m.relay : null,
    },
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Filter the grid by online state. */
export function filterAgents(agents: AgentView[], filter: FleetFilter): AgentView[] {
  if (filter === 'online') return agents.filter((a) => a.online)
  if (filter === 'offline') return agents.filter((a) => !a.online)
  return agents
}

/** { all, online, offline } counts for the filter chips. */
export function agentCounts(agents: AgentView[]): Record<FleetFilter, number> {
  const online = agents.filter((a) => a.online).length
  return { all: agents.length, online, offline: agents.length - online }
}

/** Human uptime like "2d 4h", "3h 12m", "45m", "12s". */
export function formatUptime(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
  const s = Math.floor(seconds)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${s}s`
}

/** Percent for display: "42%" (or "—"). */
export function formatPercent(v: number | null): string {
  return v == null || !Number.isFinite(v) ? '—' : `${Math.round(v)}%`
}

/** Temperature for display: "47°C" (or "—"). */
export function formatTemp(v: number | null): string {
  return v == null || !Number.isFinite(v) ? '—' : `${Math.round(v)}°C`
}

/**
 * Build an inline-SVG polyline `points` string for a sparkline from a numeric
 * series, scaled into a [w × h] box (null values are skipped). Returns '' when
 * there is nothing to plot. Auto-scales Y to the series' own min/max (with a
 * flat-line guard) so small deltas stay visible.
 */
export function sparklinePoints(
  values: (number | null)[],
  w = 120,
  h = 32,
  pad = 2,
): string {
  const pts = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (pts.length === 0) return ''
  if (pts.length === 1) {
    const y = h / 2
    return `${pad},${y} ${w - pad},${y}`
  }
  const min = Math.min(...pts)
  const max = Math.max(...pts)
  const span = max - min || 1
  const innerW = w - pad * 2
  const innerH = h - pad * 2
  return pts
    .map((v, i) => {
      const x = pad + (i / (pts.length - 1)) * innerW
      const y = pad + innerH - ((v - min) / span) * innerH
      return `${round(x)},${round(y)}`
    })
    .join(' ')
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

/** Short relative "seen" label from ageMs, e.g. "3s ago", "5m ago", "2h ago". */
export function formatAge(ageMs: number | null): string {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs < 0) return '—'
  const s = Math.floor(ageMs / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}
