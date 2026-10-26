/**
 * Cluster · Edge tab — the cluster's distributed processing surface.
 *
 * Edge is "the sum of every marketplace app running locally OR distributed on
 * cluster nodes", so its cross-cutting controls live at the cluster level (not
 * inside any one app):
 *   - EdgeNodesPanel: every node with live telemetry (cpu / mem / disk + GPU
 *     from `stats.grid`) and restart / reboot commands over the WS channel;
 *   - AssignmentsMatrix: which app · plugin · stream runs on which node, across
 *     every app the caller can see (global `/edge/assignments`).
 *
 * The GPU / bandwidth / cost capacity-planning calculator that used to live
 * here (SizingSection) moved to the public site (streamhub.studio/calculator)
 * — a pre-sales sizing tool doesn't need an authenticated dashboard.
 *
 * Global-scope (superadmin) endpoints via the typed `api.edge.*` client +
 * react-query. Degrades gracefully: a missing endpoint renders empty/skeleton
 * states, never a crash.
 */
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  api,
  ApiRequestError,
  type EdgeAssignment,
  type EdgeNodeCommand,
  type EdgeNodeView,
  type PatchEdgeNodeRequest,
} from '@/api'
import { Alert, Button, Card, Table, Tag } from '@/ui'

const { THead, TBody, Tr, Th, Td } = Table

const NODES_POLL_MS = 15_000
const ASSIGN_POLL_MS = 20_000

function errText(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) return error.message
  if (error instanceof Error) return error.message
  return fallback
}

function numStat(stats: Record<string, unknown> | null, key: string): number | null {
  const v = stats?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** GPU block a node advertises under `stats.grid` (best-effort, all optional). */
function gridOf(stats: Record<string, unknown> | null): {
  gpu: boolean
  gpuName: string | null
  vramGb: number | null
  vramFreeMb: number | null
} {
  const g = (stats?.grid ?? {}) as Record<string, unknown>
  return {
    gpu: g.gpu === true,
    gpuName: typeof g.gpuName === 'string' ? g.gpuName : null,
    vramGb: typeof g.vramGb === 'number' ? g.vramGb : null,
    vramFreeMb: typeof g.vramFreeMb === 'number' ? g.vramFreeMb : null,
  }
}

// --- small presentational bar (cpu/mem/disk) --------------------------------

function Bar({ pct, label }: { pct: number | null; label: string }) {
  const v = pct == null ? 0 : Math.max(0, Math.min(100, pct))
  const tone = v >= 90 ? 'bg-red-500' : v >= 70 ? 'bg-amber-400' : 'bg-emerald-500'
  return (
    <div>
      <div className="mb-0.5 flex justify-between text-[10px] uppercase tracking-wide text-slate-500">
        <span>{label}</span>
        <span>{pct == null ? '—' : `${Math.round(v)}%`}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-600/50">
        <div className={`h-full ${tone}`} style={{ width: `${v}%` }} />
      </div>
    </div>
  )
}

const ASSIGN_TONE: Record<string, 'green' | 'amber' | 'red' | 'slate'> = {
  running: 'green',
  offered: 'amber',
  pending: 'amber',
  failed: 'red',
  stopped: 'slate',
  revoked: 'slate',
}

const TAG_TONE: Record<string, string> = {
  green: 'border-transparent bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-100',
  amber: 'border-transparent bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-100',
  red: 'border-transparent bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-100',
  slate: 'border-transparent bg-gray-100 text-gray-600 dark:bg-gray-600/60 dark:text-gray-100',
}

function ToneTag({ tone, children }: { tone: keyof typeof TAG_TONE; children: React.ReactNode }) {
  return <Tag className={`py-0.5 ${TAG_TONE[tone]}`}>{children}</Tag>
}

// --- edge nodes panel --------------------------------------------------------

function EdgeNodesPanel() {
  const { t } = useTranslation('edge')
  const qc = useQueryClient()
  const nodesQ = useQuery({
    queryKey: ['edge-nodes'],
    queryFn: ({ signal }) => api.edge.nodes(signal),
    refetchInterval: NODES_POLL_MS,
  })
  const cmd = useMutation({
    mutationFn: ({ id, command }: { id: string; command: EdgeNodeCommand }) =>
      api.edge.command(id, command),
    onSettled: () => qc.invalidateQueries({ queryKey: ['edge-nodes'] }),
  })

  // Retype / reweight a node. Optimistic: patch the cached row immediately and
  // revert it on error (the on-settled refetch reconciles either way).
  const patch = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: PatchEdgeNodeRequest }) =>
      api.edge.patchNode(id, payload),
    onMutate: async ({ id, payload }) => {
      await qc.cancelQueries({ queryKey: ['edge-nodes'] })
      const prev = qc.getQueryData<EdgeNodeView[]>(['edge-nodes'])
      qc.setQueryData<EdgeNodeView[]>(['edge-nodes'], (old) =>
        (old ?? []).map((n) => (n.id === id ? { ...n, ...payload } : n)),
      )
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['edge-nodes'], ctx.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['edge-nodes'] }),
  })

  const nodes = nodesQ.data ?? []

  return (
    <Card bordered>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-fg">{t('nodes.title')}</h2>
        <p className="mt-0.5 text-xs text-slate-500">{t('nodes.subtitle')}</p>
      </div>

      {nodesQ.isLoading ? (
        <div className="px-2 py-8 text-center text-sm text-slate-500">{t('nodes.loading')}</div>
      ) : nodesQ.isError ? (
        <Alert type="warning" showIcon>
          {errText(nodesQ.error, t('nodes.loadError'))}
        </Alert>
      ) : nodes.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 px-4 py-8 text-center text-sm text-slate-500 dark:border-gray-600">
          {t('nodes.empty')}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {nodes.map((n) => (
            <EdgeNodeCard
              key={n.id}
              node={n}
              busy={cmd.isPending && cmd.variables?.id === n.id}
              patching={patch.isPending && patch.variables?.id === n.id}
              onCommand={(command) => cmd.mutate({ id: n.id, command })}
              onPatch={(payload) => patch.mutate({ id: n.id, payload })}
            />
          ))}
        </div>
      )}
      {cmd.isError && (
        <div className="mt-3">
          <Alert type="danger" showIcon>
            {errText(cmd.error, t('nodes.commandError'))}
          </Alert>
        </div>
      )}
      {patch.isError && (
        <div className="mt-3">
          <Alert type="danger" showIcon>
            {errText(patch.error, t('nodes.patchError'))}
          </Alert>
        </div>
      )}
    </Card>
  )
}

function EdgeNodeCard({
  node,
  busy,
  patching,
  onCommand,
  onPatch,
}: {
  node: EdgeNodeView
  busy: boolean
  patching: boolean
  onCommand: (command: EdgeNodeCommand) => void
  onPatch: (payload: PatchEdgeNodeRequest) => void
}) {
  const { t } = useTranslation('edge')
  const grid = gridOf(node.stats)
  const state = node.connected ? 'online' : node.stale ? 'stale' : 'offline'
  const tone = node.connected ? 'green' : node.stale ? 'red' : 'slate'
  return (
    <div
      data-testid={`edge-node-${node.id}`}
      className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-600 dark:bg-gray-700/40"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-sm font-semibold text-fg">{node.name}</span>
        <ToneTag tone={tone}>{t(`nodes.${state}`)}</ToneTag>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        <span>{t(`nodes.type.${node.type}`)}</span>
        {node.region && <span>· {node.region}</span>}
      </div>

      <div className="mt-3 space-y-1.5">
        <Bar pct={numStat(node.stats, 'cpu')} label={t('nodes.cpu')} />
        <Bar pct={numStat(node.stats, 'mem')} label={t('nodes.mem')} />
        <Bar pct={numStat(node.stats, 'disk')} label={t('nodes.disk')} />
      </div>

      <div className="mt-3 rounded-md bg-white/60 px-2.5 py-1.5 text-[11px] dark:bg-gray-800/50">
        <div className="flex items-center justify-between">
          <span className="uppercase tracking-wide text-slate-500">{t('nodes.gpu')}</span>
          <span className="font-medium text-fg">
            {grid.gpu ? grid.gpuName || t('nodes.gpuGeneric') : t('nodes.noGpu')}
          </span>
        </div>
        {grid.gpu && grid.vramGb != null && (
          <div className="mt-0.5 flex items-center justify-between text-slate-500">
            <span>{t('nodes.vram')}</span>
            <span className="font-mono">
              {grid.vramFreeMb != null ? `${Math.round(grid.vramFreeMb)} MB / ` : ''}
              {grid.vramGb} GB
            </span>
          </div>
        )}
      </div>

      {/* Scheduling: node type + weighted-policy share (both PATCH the row). */}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-[11px] text-slate-500">
          <span className="mb-0.5 block uppercase tracking-wide">{t('nodes.typeLabel')}</span>
          <select
            aria-label={t('nodes.typeLabel')}
            data-testid={`edge-type-${node.id}`}
            value={node.type}
            disabled={patching}
            onChange={(e) => {
              const type = e.target.value as EdgeNodeView['type']
              if (type !== node.type) onPatch({ type })
            }}
            className="rounded border border-gray-300 bg-white px-1.5 py-1 text-xs text-fg disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800"
          >
            <option value="common">{t('nodes.type.common')}</option>
            <option value="edge">{t('nodes.type.edge')}</option>
          </select>
        </label>
        <label className="text-[11px] text-slate-500" title={t('nodes.weightHint')}>
          <span className="mb-0.5 block uppercase tracking-wide">{t('nodes.weight')}</span>
          <WeightEditor
            testId={`edge-weight-${node.id}`}
            value={node.weight}
            disabled={patching}
            onCommit={(weight) => {
              if (weight !== node.weight) onPatch({ weight })
            }}
          />
        </label>
        <span className="max-w-[10rem] flex-1 text-[10px] leading-tight text-slate-500">
          {t('nodes.weightHint')}
        </span>
      </div>

      <div className="mt-3 flex gap-2">
        <Button
          size="xs"
          variant="default"
          disabled={!node.connected || busy}
          onClick={() => onCommand('restart')}
        >
          {t('nodes.restart')}
        </Button>
        <Button
          size="xs"
          variant="twoTone"
          color="red-600"
          disabled={!node.connected || busy}
          onClick={() => onCommand('reboot')}
        >
          {t('nodes.reboot')}
        </Button>
      </div>
    </div>
  )
}

/**
 * A small numeric weight field that commits on blur / Enter (not per keystroke),
 * so a partial edit never fires a PATCH. Re-seeds from `value` when the row
 * refetches or the optimistic update flows back. Clamps to an integer 0–100000
 * (the backend DTO's range).
 */
function WeightEditor({
  value,
  disabled,
  onCommit,
  testId,
}: {
  value: number
  disabled: boolean
  onCommit: (weight: number) => void
  testId: string
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])

  const commit = () => {
    const n = Number(text)
    if (!Number.isFinite(n)) {
      setText(String(value)) // reject garbage → revert to the current weight
      return
    }
    const clamped = Math.max(0, Math.min(100000, Math.round(n)))
    setText(String(clamped))
    if (clamped !== value) onCommit(clamped)
  }

  return (
    <input
      type="number"
      inputMode="numeric"
      min={0}
      max={100000}
      step={1}
      data-testid={testId}
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        }
      }}
      className="w-20 rounded border border-gray-300 bg-white px-1.5 py-1 text-xs text-fg disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800"
    />
  )
}

// --- assignments matrix ------------------------------------------------------

function AssignmentsMatrix({ nodeName }: { nodeName: (id: string) => string }) {
  const { t } = useTranslation('edge')
  const q = useQuery({
    queryKey: ['edge-assignments'],
    queryFn: ({ signal }) => api.edge.assignments(undefined, signal),
    refetchInterval: ASSIGN_POLL_MS,
  })

  const byApp = useMemo(() => groupByApp(q.data ?? []), [q.data])

  return (
    <Card bordered bodyClass="p-0">
      <div className="p-5">
        <h2 className="text-sm font-semibold text-fg">{t('assignments.title')}</h2>
        <p className="mt-0.5 text-xs text-slate-500">{t('assignments.subtitle')}</p>
      </div>

      {q.isLoading ? (
        <div className="px-5 py-8 text-center text-sm text-slate-500">{t('assignments.loading')}</div>
      ) : q.isError ? (
        <div className="p-5">
          <Alert type="warning" showIcon>
            {errText(q.error, t('assignments.loadError'))}
          </Alert>
        </div>
      ) : byApp.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-slate-500">{t('assignments.empty')}</div>
      ) : (
        <Table>
          <THead>
            <Tr>
              <Th>{t('assignments.app')}</Th>
              <Th>{t('assignments.plugin')}</Th>
              <Th>{t('assignments.stream')}</Th>
              <Th>{t('assignments.node')}</Th>
              <Th>{t('assignments.status')}</Th>
            </Tr>
          </THead>
          <TBody>
            {byApp.map(([app, rows]) =>
              rows.map((a, i) => (
                <Tr key={a.id} data-testid={`assignment-${a.id}`}>
                  <Td className="font-medium text-fg">{i === 0 ? app : ''}</Td>
                  <Td className="font-mono text-xs text-fg">{a.pluginId}</Td>
                  <Td className="font-mono text-xs text-slate-400">
                    {a.streamId || t('assignments.allStreams')}
                  </Td>
                  <Td className="text-xs text-slate-400">
                    {a.nodeId ? nodeName(a.nodeId) : t('assignments.unassigned')}
                  </Td>
                  <Td>
                    <ToneTag tone={ASSIGN_TONE[a.status] ?? 'slate'}>{a.status}</ToneTag>
                  </Td>
                </Tr>
              )),
            )}
          </TBody>
        </Table>
      )}
    </Card>
  )
}

/** Group assignments by app, apps alphabetical, rows by plugin then stream. */
export function groupByApp(rows: EdgeAssignment[]): [string, EdgeAssignment[]][] {
  const map = new Map<string, EdgeAssignment[]>()
  for (const r of rows) {
    const list = map.get(r.app) ?? []
    list.push(r)
    map.set(r.app, list)
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([app, list]) => [
      app,
      list.sort(
        (a, b) =>
          a.pluginId.localeCompare(b.pluginId) ||
          (a.streamId ?? '').localeCompare(b.streamId ?? ''),
      ),
    ] as [string, EdgeAssignment[]])
}

// --- tab ---------------------------------------------------------------------

export function EdgeTab() {
  // Resolve a node id → its display name for the assignments matrix.
  const nodesQ = useQuery({
    queryKey: ['edge-nodes'],
    queryFn: ({ signal }) => api.edge.nodes(signal),
    refetchInterval: NODES_POLL_MS,
  })
  const nameOf = (id: string): string =>
    nodesQ.data?.find((n) => n.id === id)?.name ?? id

  return (
    <div className="space-y-6">
      <EdgeNodesPanel />
      <AssignmentsMatrix nodeName={nameOf} />
    </div>
  )
}
