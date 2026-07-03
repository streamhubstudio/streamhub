/**
 * Cluster — multi-node registry surface.
 *
 * Top block: cluster state (enabled or not), the node `joinCommand` in a
 * copyable code block, and the cluster token hidden behind a reveal toggle.
 * When clustering is disabled (or the endpoint isn't live yet) an empty-state
 * explains how to turn it on (STREAMHUB_CLUSTER_TOKEN + INSTALL-NODE.md).
 *
 * Below: the nodes table (name, url, region, status Badge with a stale tint,
 * relative last-seen) with an expandable per-node health snapshot and per-row
 * edit (name/region) + delete actions, both behind confirmation dialogs.
 *
 * Data via @tanstack/react-query + the typed `api` client. Degrades gracefully:
 * a missing endpoint renders skeleton/empty states, never a crash.
 */
import { Fragment, useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, ApiRequestError, type ClusterInfo, type ClusterNode } from '@/api'
import { Alert, Button, Card, Dialog, Input, Skeleton, Table, Tag } from '@/ui'
import { relativeTime } from '@/lib/relativeTime'

const { THead, TBody, Tr, Th, Td } = Table

const INFO_POLL_MS = 30_000
const NODES_POLL_MS = 15_000

// --- helpers ----------------------------------------------------------------

function errText(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) return error.message
  if (error instanceof Error) return error.message
  return fallback
}

/** Badge colour for a node: stale wins (amber), else online-ish → green. */
function statusTone(status: string, stale: boolean): 'green' | 'amber' | 'red' | 'slate' {
  if (stale) return 'amber'
  const s = (status ?? '').toLowerCase()
  if (s === 'online' || s === 'ready' || s === 'up' || s === 'active') return 'green'
  if (s === 'error' || s === 'down' || s === 'offline') return 'red'
  return 'slate'
}

const BADGE_TONE: Record<string, string> = {
  green: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-100',
  amber: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-100',
  red: 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-100',
  slate: 'bg-gray-100 text-gray-600 dark:bg-gray-600/60 dark:text-gray-100',
}

function ToneBadge({ tone, children }: { tone: keyof typeof BADGE_TONE; children: ReactNode }) {
  return <Tag className={`border-transparent py-0.5 ${BADGE_TONE[tone]}`}>{children}</Tag>
}

/** Localised relative "last seen" label. */
function LastSeen({ iso }: { iso: string | null }) {
  const { t } = useTranslation('clusterPage')
  const { unit, count, invalid } = relativeTime(iso)
  if (invalid) return <span className="text-slate-500">{t('nodes.never')}</span>
  if (unit === 'now') return <span className="text-slate-500">{t('relative.now')}</span>
  return <span className="text-slate-500">{t(`relative.${unit}`, { count })}</span>
}

// --- copy helpers -----------------------------------------------------------

async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
  } catch {
    /* ignore — clipboard unavailable */
  }
}

function CopyButton({ value }: { value: string }) {
  const { t } = useTranslation('common')
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="sm"
      variant="default"
      className="shrink-0"
      onClick={() => {
        void copyText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? t('actions.copied') : t('actions.copy')}
    </Button>
  )
}

/** Read-only code block with a copy button (used for the join command). */
function CodeCopy({ value }: { value: string }) {
  return (
    <div className="flex items-start gap-2">
      <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-gray-100 px-3 py-2 font-mono text-xs text-gray-800 dark:bg-gray-700/60 dark:text-gray-100">
        <code className="whitespace-pre-wrap break-all">{value}</code>
      </pre>
      <CopyButton value={value} />
    </div>
  )
}

/** Secret value hidden behind a reveal toggle (used for the cluster token). */
function RevealField({ value }: { value: string }) {
  const { t } = useTranslation('clusterPage')
  const [shown, setShown] = useState(false)
  return (
    <div className="flex items-center gap-2">
      <Input
        readOnly
        size="sm"
        type={shown ? 'text' : 'password'}
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        className="font-mono text-xs"
      />
      <Button size="sm" variant="default" className="shrink-0" onClick={() => setShown((s) => !s)}>
        {shown ? t('info.hide') : t('info.reveal')}
      </Button>
      <CopyButton value={value} />
    </div>
  )
}

// --- cluster info block ------------------------------------------------------

function InfoBlock({
  info,
  isLoading,
  isError,
  error,
}: {
  info: ClusterInfo | undefined
  isLoading: boolean
  isError: boolean
  error: unknown
}) {
  const { t } = useTranslation('clusterPage')

  if (isLoading && !info) {
    return (
      <Card bordered>
        <Skeleton height={18} className="mb-3 w-40" />
        <Skeleton height={44} />
      </Card>
    )
  }

  // Endpoint missing / errored → treat as "unknown", show the enable guidance.
  const enabled = info?.enabled ?? false

  return (
    <Card bordered>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-fg">{t('info.title')}</h2>
          <p className="mt-0.5 text-xs text-slate-500">{t('info.subtitle')}</p>
        </div>
        <ToneBadge tone={enabled ? 'green' : 'slate'}>
          {enabled ? t('info.enabled') : t('info.disabled')}
        </ToneBadge>
      </div>

      {isError && !info && (
        <div className="mt-4">
          <Alert type="warning" showIcon>
            {errText(error, t('info.loadError'))}
          </Alert>
        </div>
      )}

      {enabled && info ? (
        <div className="mt-4 space-y-4">
          <div>
            <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-fg-muted">
              {t('info.joinCommand')}
            </label>
            <CodeCopy value={info.joinCommand} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-fg-muted">
                {t('info.token')}
              </label>
              <RevealField value={info.clusterToken} />
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-fg-muted">
                {t('info.redisUrl')}
              </label>
              <Input
                readOnly
                size="sm"
                value={info.clusterRedisUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="font-mono text-xs"
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-sm text-slate-600 dark:border-gray-600 dark:bg-gray-700/30 dark:text-slate-300">
          <p className="font-medium text-fg">{t('disabled.title')}</p>
          <p className="mt-1 text-xs">
            {t('disabled.body')}{' '}
            <code className="rounded bg-gray-200 px-1 py-0.5 font-mono text-[11px] dark:bg-gray-600/60">
              STREAMHUB_CLUSTER_TOKEN
            </code>
          </p>
          <p className="mt-2 text-xs">
            <a
              href="https://github.com/streamhubstudio/streamhub/blob/main/streamhub-docs/operations/INSTALL-NODE.md"
              target="_blank"
              rel="noreferrer"
              className="text-primary-500 hover:text-fg"
            >
              {t('disabled.docsLink')} →
            </a>
          </p>
        </div>
      )}
    </Card>
  )
}

// --- node health snapshot ----------------------------------------------------

function NodeStats({ stats }: { stats: Record<string, unknown> }) {
  const entries = Object.entries(stats).filter(
    ([, v]) => v != null && (typeof v === 'number' || typeof v === 'string'),
  )
  if (entries.length === 0) return null
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {entries.map(([k, v]) => (
        <div
          key={k}
          className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-600 dark:bg-gray-700/40"
        >
          <div className="text-[10px] uppercase tracking-wide text-slate-500">{k}</div>
          <div className="mt-0.5 font-mono text-sm tabular-nums text-fg">{String(v)}</div>
        </div>
      ))}
    </div>
  )
}

// --- edit / delete dialogs ---------------------------------------------------

function EditNodeDialog({ node, onClose }: { node: ClusterNode; onClose: () => void }) {
  const { t } = useTranslation(['clusterPage', 'common'])
  const qc = useQueryClient()
  const [name, setName] = useState(node.name)
  const [region, setRegion] = useState(node.region ?? '')

  const save = useMutation({
    mutationFn: () => api.cluster.updateNode(node.id, { name, region: region || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cluster-nodes'] })
      onClose()
    },
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (save.isPending) return
    save.mutate()
  }

  return (
    <Dialog isOpen width={460} closable={false} onClose={onClose} onRequestClose={onClose}>
      <h5 className="mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('edit.title', { name: node.name })}
      </h5>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-100">
            {t('edit.name')}
          </label>
          <Input autoFocus size="sm" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-100">
            {t('edit.region')}
          </label>
          <Input
            size="sm"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            placeholder={t('edit.regionPlaceholder')}
          />
        </div>
        {save.isError && (
          <Alert type="danger" showIcon>
            {errText(save.error, t('edit.error'))}
          </Alert>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button type="button" size="sm" variant="default" disabled={save.isPending} onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" size="sm" variant="solid" loading={save.isPending} disabled={!name.trim()}>
            {t('common:actions.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function DeleteNodeDialog({ node, onClose }: { node: ClusterNode; onClose: () => void }) {
  const { t } = useTranslation(['clusterPage', 'common'])
  const qc = useQueryClient()
  const remove = useMutation({
    mutationFn: () => api.cluster.removeNode(node.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cluster-nodes'] })
      onClose()
    },
  })

  return (
    <Dialog
      isOpen
      width={460}
      closable={false}
      onClose={() => !remove.isPending && onClose()}
      onRequestClose={() => !remove.isPending && onClose()}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h5 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('delete.title', { name: node.name })}
        </h5>
        <ToneBadge tone="red">{t('delete.destructive')}</ToneBadge>
      </div>
      <p className="mb-4 text-xs font-medium text-amber-600 dark:text-amber-300">
        {t('delete.warning')}
      </p>
      {remove.isError && (
        <div className="mb-3">
          <Alert type="danger" showIcon>
            {errText(remove.error, t('delete.error'))}
          </Alert>
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="default" disabled={remove.isPending} onClick={onClose}>
          {t('common:actions.cancel')}
        </Button>
        <Button
          size="sm"
          variant="solid"
          color="red-600"
          loading={remove.isPending}
          onClick={() => remove.mutate()}
        >
          {t('delete.confirm')}
        </Button>
      </div>
    </Dialog>
  )
}

// --- nodes table -------------------------------------------------------------

function NodesTable({
  nodes,
  isLoading,
  isError,
  error,
}: {
  nodes: ClusterNode[]
  isLoading: boolean
  isError: boolean
  error: unknown
}) {
  const { t } = useTranslation('clusterPage')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [editing, setEditing] = useState<ClusterNode | null>(null)
  const [deleting, setDeleting] = useState<ClusterNode | null>(null)

  return (
    <Card bordered bodyClass="p-0">
      <div className="flex items-center justify-between p-5">
        <div>
          <h2 className="text-sm font-semibold text-fg">{t('nodes.title')}</h2>
          <p className="mt-0.5 text-xs text-slate-500">{t('nodes.subtitle')}</p>
        </div>
      </div>

      {isLoading ? (
        <div className="px-5 py-10 text-center text-sm text-slate-500">{t('nodes.loading')}</div>
      ) : isError ? (
        <div className="p-5">
          <Alert type="warning" showIcon>
            {errText(error, t('nodes.loadError'))}
          </Alert>
        </div>
      ) : nodes.length === 0 ? (
        <div className="px-5 py-10 text-center text-sm text-slate-500">{t('nodes.empty')}</div>
      ) : (
        <Table>
          <THead>
            <Tr>
              <Th>{t('nodes.name')}</Th>
              <Th>{t('nodes.url')}</Th>
              <Th>{t('nodes.region')}</Th>
              <Th>{t('nodes.status')}</Th>
              <Th>{t('nodes.lastSeen')}</Th>
              <Th />
            </Tr>
          </THead>
          <TBody>
            {nodes.map((node) => {
              const tone = statusTone(node.status, node.stale)
              const hasStats = node.stats != null && Object.keys(node.stats).length > 0
              const isOpen = expanded === node.id
              return (
                <Fragment key={node.id}>
                  <Tr>
                    <Td>
                      <div className="font-medium text-fg">{node.name}</div>
                      <div className="font-mono text-[11px] text-slate-500">{node.id}</div>
                    </Td>
                    <Td className="font-mono text-xs text-slate-400">{node.url}</Td>
                    <Td className="text-slate-400">{node.region || '—'}</Td>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        <ToneBadge tone={tone}>{node.status || '—'}</ToneBadge>
                        {node.stale && <ToneBadge tone="red">{t('nodes.stale')}</ToneBadge>}
                      </div>
                    </Td>
                    <Td>
                      <LastSeen iso={node.last_seen_at} />
                    </Td>
                    <Td className="text-right">
                      <div className="inline-flex gap-2">
                        {hasStats && (
                          <Button
                            size="xs"
                            variant="default"
                            onClick={() => setExpanded(isOpen ? null : node.id)}
                          >
                            {isOpen ? t('nodes.hideStats') : t('nodes.showStats')}
                          </Button>
                        )}
                        <Button size="xs" variant="default" onClick={() => setEditing(node)}>
                          {t('nodes.edit')}
                        </Button>
                        <Button
                          size="xs"
                          variant="twoTone"
                          color="red-600"
                          onClick={() => setDeleting(node)}
                        >
                          {t('nodes.delete')}
                        </Button>
                      </div>
                    </Td>
                  </Tr>
                  {isOpen && hasStats && (
                    <Tr>
                      <Td colSpan={6} className="bg-gray-50 dark:bg-gray-700/30">
                        <NodeStats stats={node.stats as Record<string, unknown>} />
                      </Td>
                    </Tr>
                  )}
                </Fragment>
              )
            })}
          </TBody>
        </Table>
      )}

      {editing && <EditNodeDialog node={editing} onClose={() => setEditing(null)} />}
      {deleting && <DeleteNodeDialog node={deleting} onClose={() => setDeleting(null)} />}
    </Card>
  )
}

// --- page --------------------------------------------------------------------

export default function Cluster() {
  const { t } = useTranslation('clusterPage')

  const infoQ = useQuery({
    queryKey: ['cluster-info'],
    queryFn: ({ signal }) => api.cluster.info(signal),
    refetchInterval: INFO_POLL_MS,
  })

  const nodesQ = useQuery({
    queryKey: ['cluster-nodes'],
    queryFn: ({ signal }) => api.cluster.nodes(signal),
    refetchInterval: NODES_POLL_MS,
  })

  const enabled = infoQ.data?.enabled ?? false

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-fg">{t('title')}</h1>
        <p className="text-sm text-slate-400">{t('subtitle')}</p>
      </div>

      <InfoBlock
        info={infoQ.data}
        isLoading={infoQ.isLoading}
        isError={infoQ.isError}
        error={infoQ.error}
      />

      {enabled && (
        <NodesTable
          nodes={nodesQ.data ?? []}
          isLoading={nodesQ.isLoading}
          isError={nodesQ.isError}
          error={nodesQ.error}
        />
      )}
    </div>
  )
}
