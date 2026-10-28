/**
 * Backups — versioned + compressed snapshots of every StreamHub SQLite DB
 * (global registry + one per app), rendered as a section of the Server
 * Settings page (superadmin-only, like the rest).
 *
 * Shows the schedule/retention settings, then one collapsed-by-default
 * accordion row per database (global registry + one per app — there can be
 * MANY apps, so a flat list doesn't scale) with a snapshot-count/size
 * summary in the row header. Expanding a row reveals its snapshot inventory
 * (size + age), paginated `SNAPSHOTS_PAGE_SIZE` at a time, with a "Back up
 * now" action at the top and a RESTORE button per snapshot behind a strong
 * confirm dialog: it spells out that the live DB is overwritten, that a
 * safety backup is auto-created first, and requires typing the confirmation
 * phrase (same contract as the DB purge modal). All data via the typed
 * `api.backups` client; a 403/404 renders nothing — the parent page already
 * explains the required scope.
 */
import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { HiOutlineChevronDown } from 'react-icons/hi'
import {
  api,
  ApiRequestError,
  type BackupDatabase,
  type BackupRestoreResult,
  type BackupSnapshot,
} from '@/api'
import { Alert, Button, Card, Dialog, Input, Pagination, Skeleton, Table, Tag } from '@/ui'
import { formatBytes } from '@/lib/bytes'
import {
  clampSnapshotPage,
  restoreConfirmed,
  snapshotAgeDays,
  snapshotsOnPage,
  sortDatabases,
  totalSnapshotBytes,
} from '@/lib/backups'
import { relativeTime } from '@/lib/relativeTime'

const { THead, TBody, Tr, Th, Td } = Table

const POLL_MS = 60_000
/** Snapshots shown per page inside an expanded database's accordion row. */
const SNAPSHOTS_PAGE_SIZE = 10

type Tone = 'green' | 'amber' | 'red' | 'slate'

const BADGE_TONE: Record<Tone, string> = {
  green: 'bg-emerald-500/20 text-emerald-100',
  amber: 'bg-amber-500/20 text-amber-100',
  red: 'bg-red-500/20 text-red-100',
  slate: 'bg-gray-600/60 text-gray-100',
}

function ToneBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <Tag className={`border-transparent py-0.5 ${BADGE_TONE[tone]}`}>{children}</Tag>
}

function errText(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) return error.message
  if (error instanceof Error) return error.message
  return fallback
}

/** Localised relative timestamp (reuses the shared bucketing helper). */
function Rel({ iso }: { iso: string | null }) {
  const { t } = useTranslation('backups')
  const { unit, count, invalid } = relativeTime(iso)
  if (invalid) return <span className="text-slate-500">—</span>
  if (unit === 'now') return <span className="text-slate-500">{t('relative.now')}</span>
  return <span className="text-slate-500">{t(`relative.${unit}`, { count })}</span>
}

// --- database name -------------------------------------------------------------

function DbName({ d }: { d: BackupDatabase }) {
  const { t } = useTranslation('backups')
  if (d.kind === 'global') {
    return (
      <span className="flex items-center gap-2">
        <span className="text-sm font-medium text-fg">{t('db.global')}</span>
        <span className="font-mono text-[11px] text-fg-muted">streamhub.db</span>
      </span>
    )
  }
  return (
    <span className="flex items-center gap-2">
      <span className="text-sm font-medium text-fg">
        {t('db.app', { app: d.app ?? d.db })}
      </span>
      {d.orphaned && <ToneBadge tone="slate">{t('db.orphaned')}</ToneBadge>}
    </span>
  )
}

// --- per-DB snapshot table -------------------------------------------------------

function SnapshotsTable({
  d,
  items,
  onRestore,
}: {
  d: BackupDatabase
  /** The current page's slice of `d.snapshots` (see `snapshotsOnPage`). */
  items: BackupSnapshot[]
  onRestore: (db: BackupDatabase, snap: BackupSnapshot) => void
}) {
  const { t } = useTranslation('backups')
  if (d.snapshots.length === 0) {
    return <p className="px-1 pb-3 text-sm text-fg-muted">{t('snapshots.empty')}</p>
  }
  return (
    <div className="overflow-x-auto pb-2">
      <Table compact>
        <THead>
          <Tr>
            <Th>{t('snapshots.file')}</Th>
            <Th>{t('snapshots.created')}</Th>
            <Th>{t('snapshots.age')}</Th>
            <Th className="text-right">{t('snapshots.size')}</Th>
            <Th />
          </Tr>
        </THead>
        <TBody>
          {items.map((s) => {
            const age = snapshotAgeDays(s.createdAt)
            return (
              <Tr key={s.file}>
                <Td>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-xs">{s.file}</span>
                    {s.preRestore && (
                      <ToneBadge tone="amber">{t('snapshots.preRestore')}</ToneBadge>
                    )}
                  </span>
                </Td>
                <Td>
                  <Rel iso={s.createdAt} />
                </Td>
                <Td>
                  <span className="text-xs tabular-nums">
                    {age === null ? '—' : t('snapshots.days', { count: age })}
                  </span>
                </Td>
                <Td className="text-right">
                  <span className="text-xs tabular-nums">{formatBytes(s.sizeBytes)}</span>
                </Td>
                <Td>
                  {!d.orphaned && (
                    <Button size="xs" variant="default" onClick={() => onRestore(d, s)}>
                      {t('restore.button')}
                    </Button>
                  )}
                </Td>
              </Tr>
            )
          })}
        </TBody>
      </Table>
    </div>
  )
}

// --- per-DB accordion row (collapsed by default, paginated when open) ------------

function DatabaseAccordionRow({
  d,
  open,
  page,
  onToggle,
  onPageChange,
  onRestore,
}: {
  d: BackupDatabase
  open: boolean
  page: number
  onToggle: () => void
  onPageChange: (page: number) => void
  onRestore: (db: BackupDatabase, snap: BackupSnapshot) => void
}) {
  const { t } = useTranslation('backups')
  const total = d.snapshots.length
  const currentPage = clampSnapshotPage(page, total, SNAPSHOTS_PAGE_SIZE)
  const pageItems = snapshotsOnPage(d.snapshots, currentPage, SNAPSHOTS_PAGE_SIZE)

  return (
    <div className="rounded-lg border border-border/60">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-left transition hover:bg-surface-raised/60"
      >
        <span className="flex min-w-0 items-center gap-2">
          <HiOutlineChevronDown
            className={`shrink-0 text-fg-subtle transition-transform ${open ? 'rotate-180' : ''}`}
          />
          <DbName d={d} />
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-fg-muted">
          <span>{t('snapshots.count', { count: total })}</span>
          {total > 0 && (
            <span className="tabular-nums">{formatBytes(totalSnapshotBytes(d.snapshots))}</span>
          )}
          {d.liveSizeBytes !== null && (
            <span>{t('db.liveSize', { size: formatBytes(d.liveSizeBytes) })}</span>
          )}
        </span>
      </button>

      {open && (
        <div className="border-t border-border/60 px-3 pt-2">
          <SnapshotsTable d={d} items={pageItems} onRestore={onRestore} />
          {total > SNAPSHOTS_PAGE_SIZE && (
            <div className="flex justify-end pb-3">
              <Pagination
                currentPage={currentPage}
                pageSize={SNAPSHOTS_PAGE_SIZE}
                total={total}
                onChange={onPageChange}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// --- restore confirm dialog ------------------------------------------------------

function RestoreDialog({
  db,
  snap,
  onClose,
}: {
  db: BackupDatabase
  snap: BackupSnapshot
  onClose: () => void
}) {
  const { t } = useTranslation(['backups', 'common'])
  const qc = useQueryClient()
  const [typed, setTyped] = useState('')
  const [result, setResult] = useState<BackupRestoreResult | null>(null)

  const restore = useMutation({
    mutationFn: () =>
      api.backups.restore({ db: db.db, snapshot: snap.file, confirm: true }),
    onSuccess: (res) => {
      setResult(res)
      void qc.invalidateQueries({ queryKey: ['backups-overview'] })
    },
  })

  const confirmPhrase = t('backups:restore.phrase')
  const confirmed = restoreConfirmed(typed, confirmPhrase)
  const dbLabel =
    db.kind === 'global' ? t('backups:db.global') : t('backups:db.app', { app: db.app ?? db.db })

  return (
    <Dialog isOpen width={520} closable={false} onClose={onClose} onRequestClose={onClose}>
      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h5 className="text-lg font-semibold text-gray-100">
            {t('backups:restore.title')}
          </h5>
          <ToneBadge tone="red">{t('backups:restore.destructive')}</ToneBadge>
        </div>

        {result ? (
          <div className="space-y-4">
            <Alert type="success" showIcon>
              {t('backups:restore.done', { db: dbLabel })}
            </Alert>
            <p className="text-xs text-fg-muted">
              {t('backups:restore.safetyCreated', { file: result.preRestoreSnapshot })}
            </p>
            {result.restartRecommended && (
              <Alert type="warning" showIcon>
                {t('backups:restore.restartRecommended')}
              </Alert>
            )}
            <div className="flex items-center justify-end">
              <Button variant="solid" onClick={onClose}>
                {t('common:actions.close')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-fg">
              {t('backups:restore.summary', { db: dbLabel, file: snap.file })}
            </p>
            <ul className="list-disc space-y-1 pl-5 text-xs text-amber-300">
              <li>{t('backups:restore.warnOverwrite')}</li>
              <li>{t('backups:restore.warnSafety')}</li>
              <li>{t('backups:restore.warnIntegrity')}</li>
              {db.kind === 'global' && <li>{t('backups:restore.warnGlobal')}</li>}
            </ul>

            <div>
              <label className="mb-1 block text-xs font-medium text-fg-muted">
                {t('backups:restore.confirmLabel', { phrase: confirmPhrase })}
              </label>
              <Input
                size="sm"
                autoFocus
                className="font-mono text-xs"
                placeholder={confirmPhrase}
                value={typed}
                disabled={restore.isPending}
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>

            {restore.isError && (
              <Alert type="danger" showIcon>
                {errText(restore.error, t('backups:restore.error'))}
              </Alert>
            )}

            <div className="flex items-center justify-end gap-2">
              <Button variant="plain" disabled={restore.isPending} onClick={onClose}>
                {t('common:actions.cancel')}
              </Button>
              <Button
                variant="solid"
                color="red-600"
                disabled={!confirmed}
                loading={restore.isPending}
                onClick={() => restore.mutate()}
              >
                {t('backups:restore.confirmButton')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  )
}

// --- section -----------------------------------------------------------------------

export function BackupsSection() {
  const { t } = useTranslation('backups')
  const qc = useQueryClient()
  const [restoreTarget, setRestoreTarget] = useState<{
    db: BackupDatabase
    snap: BackupSnapshot
  } | null>(null)
  // Accordion state, keyed by db id — collapsed by default (there can be MANY
  // apps, so opening every row at once would be a wall of tables again).
  const [openDbs, setOpenDbs] = useState<Record<string, boolean>>({})
  const [dbPages, setDbPages] = useState<Record<string, number>>({})

  const overview = useQuery({
    queryKey: ['backups-overview'],
    queryFn: ({ signal }) => api.backups.overview(signal),
    refetchInterval: POLL_MS,
    retry: (count, err) => !(err instanceof ApiRequestError && err.status === 403) && count < 2,
  })

  const run = useMutation({
    mutationFn: () => api.backups.run(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['backups-overview'] }),
  })

  // Superadmin-gated like the rest of Settings: a 403 (or an older core
  // without the module) renders nothing rather than a broken card.
  if (
    overview.error instanceof ApiRequestError &&
    (overview.error.status === 403 || overview.error.status === 404)
  ) {
    return null
  }

  const data = overview.data
  const databases = data ? sortDatabases(data.databases) : []

  return (
    <Card bordered>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-fg">{t('title')}</h2>
          <p className="mt-0.5 text-xs text-slate-500">{t('subtitle')}</p>
        </div>
        <Button
          size="sm"
          variant="solid"
          loading={run.isPending}
          onClick={() => run.mutate()}
        >
          {t('runNow')}
        </Button>
      </div>

      {overview.isLoading || !data ? (
        <Skeleton height={90} />
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <ToneBadge tone={data.enabled ? 'green' : 'red'}>
              {t(data.enabled ? 'status.enabled' : 'status.disabled')}
            </ToneBadge>
            <ToneBadge tone="slate">
              {t('status.retention', { days: data.retentionDays })}
            </ToneBadge>
            <span className="font-mono text-xs text-fg-muted">
              {t('status.schedule')}: {data.schedule}
            </span>
          </div>

          {!data.enabled && (
            <Alert type="warning" showIcon>
              {t('disabledHint')}
            </Alert>
          )}

          {run.isError && (
            <Alert type="danger" showIcon>
              {errText(run.error, t('runError'))}
            </Alert>
          )}
          {run.isSuccess && run.data.errors.length > 0 && (
            <Alert type="warning" showIcon>
              {t('runPartial', {
                errors: run.data.errors.map((e) => `${e.db}: ${e.error}`).join(' · '),
              })}
            </Alert>
          )}

          <div className="space-y-2">
            {databases.map((d) => (
              <DatabaseAccordionRow
                key={d.db}
                d={d}
                open={Boolean(openDbs[d.db])}
                page={dbPages[d.db] ?? 1}
                onToggle={() =>
                  setOpenDbs((prev) => ({ ...prev, [d.db]: !prev[d.db] }))
                }
                onPageChange={(page) =>
                  setDbPages((prev) => ({ ...prev, [d.db]: page }))
                }
                onRestore={(db, snap) => setRestoreTarget({ db, snap })}
              />
            ))}
          </div>

          <p className="text-xs text-fg-subtle">{t('envHint')}</p>
        </div>
      )}

      {restoreTarget && (
        <RestoreDialog
          db={restoreTarget.db}
          snap={restoreTarget.snap}
          onClose={() => setRestoreTarget(null)}
        />
      )}
    </Card>
  )
}
