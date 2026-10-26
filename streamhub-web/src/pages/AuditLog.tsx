/**
 * Audit log — superadmin-only view of the tamper-evident action log
 * (GET /system/audit). Filter bar (action prefix, actor, result, date range) +
 * a paginated, newest-first table; each row expands to reveal its `meta` JSON.
 * A chain-integrity chip verifies the hash chain on load
 * (GET /system/audit/verify).
 *
 * Global-scope surface, gated exactly like Server settings: a 403 degrades to a
 * friendly notice, and a core that predates the feature (404) shows an
 * "upgrade required" empty-state rather than an error.
 *
 * Data via @tanstack/react-query + the typed `api` client. The query-string
 * builder + result-tone mapping live in @/lib/audit (unit-tested under node).
 */
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  HiOutlineChevronDown,
  HiOutlineShieldCheck,
  HiOutlineShieldExclamation,
} from 'react-icons/hi'
import { api, ApiRequestError, type AuditEntry, type AuditResult } from '@/api'
import { Alert, Button, Card, Input, Pagination, Skeleton, Table, Tag } from '@/ui'
import { auditResultTone, AUDIT_DEFAULT_LIMIT, type PostureTone } from '@/lib/audit'
import { formatDateTime } from '@/lib/datetime'

const { THead, TBody, Tr, Th, Td } = Table

const PAGE_SIZE = AUDIT_DEFAULT_LIMIT // 50
const RESULTS: AuditResult[] = ['success', 'failure', 'deny']
const EMPTY = '—'

const selectClass =
  'input input-md h-11 max-md:w-full ltr:pr-8 rtl:pl-8 bg-white focus:border-primary-500 focus:ring-primary-500 dark:bg-gray-700'

// --- badges ------------------------------------------------------------------

const BADGE_TONE: Record<PostureTone, string> = {
  green: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-100',
  amber: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-100',
  red: 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-100',
  slate: 'bg-gray-100 text-gray-600 dark:bg-gray-600/60 dark:text-gray-100',
}

function ToneBadge({ tone, children }: { tone: PostureTone; children: ReactNode }) {
  return <Tag className={`border-transparent py-0.5 ${BADGE_TONE[tone]}`}>{children}</Tag>
}

/** Small debounce so typing in the text filters doesn't spam the API. */
function useDebounced<T>(value: T, ms = 400): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return debounced
}

// --- chain-integrity chip -----------------------------------------------------

function ChainChip() {
  const { t } = useTranslation('audit')
  const verify = useQuery({
    queryKey: ['audit-verify'],
    queryFn: ({ signal }) => api.system.auditVerify(signal),
    retry: false,
  })

  if (verify.isLoading) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full bg-gray-100 px-3 py-1 text-xs text-fg-muted dark:bg-gray-600/60">
        {t('chain.checking')}
      </span>
    )
  }
  // A 403 (not superadmin) / 404 (old core) just hides the chip; the page body
  // already explains the required scope / version.
  if (verify.isError || !verify.data) return null

  const v = verify.data
  if (v.ok) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-100">
        <HiOutlineShieldCheck className="text-sm" />
        {t('chain.verified', { count: v.checked })}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700 dark:bg-red-500/20 dark:text-red-100">
      <HiOutlineShieldExclamation className="text-sm" />
      {t('chain.broken', { id: v.brokenAt ?? '?' })}
    </span>
  )
}

// --- row ----------------------------------------------------------------------

function ActorCell({ entry }: { entry: AuditEntry }) {
  const { t } = useTranslation('audit')
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-xs text-fg-muted">
        {t(`actorType.${entry.actorType}`, { defaultValue: entry.actorType })}
      </span>
      <span className="font-mono text-xs break-all">{entry.actorId ?? EMPTY}</span>
    </span>
  )
}

function TargetCell({ entry }: { entry: AuditEntry }) {
  if (!entry.targetType && !entry.targetId) {
    return <span className="text-fg-subtle">{EMPTY}</span>
  }
  return (
    <span className="flex flex-col gap-0.5">
      {entry.targetType && <span className="text-xs text-fg-muted">{entry.targetType}</span>}
      <span className="font-mono text-xs break-all">{entry.targetId ?? EMPTY}</span>
    </span>
  )
}

function EntryRow({ entry }: { entry: AuditEntry }) {
  const { t } = useTranslation('audit')
  const [open, setOpen] = useState(false)
  const hasMeta = entry.meta != null && Object.keys(entry.meta).length > 0

  return (
    <Fragment>
      <Tr
        className={hasMeta ? 'cursor-pointer' : undefined}
        onClick={hasMeta ? () => setOpen((o) => !o) : undefined}
      >
        <Td>
          <span className="flex items-center gap-1.5">
            {hasMeta ? (
              <HiOutlineChevronDown
                className={`shrink-0 text-sm text-fg-subtle transition-transform ${open ? 'rotate-180' : ''}`}
              />
            ) : (
              <span className="inline-block w-[14px] shrink-0" />
            )}
            <span className="text-xs whitespace-nowrap">
              {formatDateTime(entry.ts)}
            </span>
          </span>
        </Td>
        <Td>
          <ActorCell entry={entry} />
        </Td>
        <Td>
          <code className="rounded bg-gray-200 px-1.5 py-0.5 font-mono text-[11px] break-all dark:bg-gray-600/60">
            {entry.action}
          </code>
        </Td>
        <Td>
          <TargetCell entry={entry} />
        </Td>
        <Td>
          <span className="font-mono text-xs">{entry.ip ?? EMPTY}</span>
        </Td>
        <Td>
          <ToneBadge tone={auditResultTone(entry.result)}>
            {t(`result.${entry.result}`, { defaultValue: entry.result })}
          </ToneBadge>
        </Td>
      </Tr>
      {open && hasMeta && (
        <Tr>
          <Td colSpan={6} className="bg-surface-raised/40">
            <pre className="max-h-64 overflow-auto rounded-lg border border-border/60 bg-surface p-3 font-mono text-[11px] leading-relaxed text-fg-muted">
              {JSON.stringify(entry.meta, null, 2)}
            </pre>
          </Td>
        </Tr>
      )}
    </Fragment>
  )
}

// --- page ---------------------------------------------------------------------

export default function AuditLog() {
  const { t } = useTranslation(['audit', 'common'])
  const [action, setAction] = useState('')
  const [actor, setActor] = useState('')
  const [result, setResult] = useState<AuditResult | ''>('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)

  const debouncedAction = useDebounced(action)
  const debouncedActor = useDebounced(actor)

  useEffect(() => {
    setPage(1)
  }, [debouncedAction, debouncedActor, result, from, to])

  const params = useMemo(
    () => ({
      action: debouncedAction || undefined,
      actor: debouncedActor || undefined,
      result: result || undefined,
      from: from || undefined,
      to: to || undefined,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    [debouncedAction, debouncedActor, result, from, to, page],
  )

  const { data, isLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ['audit', params],
    queryFn: ({ signal }) => api.system.audit(params, signal),
    placeholderData: keepPreviousData,
    retry: (count, err) =>
      !(err instanceof ApiRequestError && (err.status === 403 || err.status === 404)) &&
      count < 2,
  })

  const forbidden = error instanceof ApiRequestError && error.status === 403
  const unsupported = error instanceof ApiRequestError && error.status === 404

  const entries = data?.entries ?? []
  const total = data?.total ?? 0

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-fg">{t('audit:title')}</h1>
          <p className="text-sm text-slate-400">{t('audit:subtitle')}</p>
        </div>
        <ChainChip />
      </div>

      {/* Filters */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="max-md:w-full md:w-52">
          <Input
            value={action}
            onChange={(e) => setAction(e.target.value)}
            placeholder={t('audit:filterAction')}
            className="font-mono text-xs"
          />
        </div>
        <div className="max-md:w-full md:w-52">
          <Input
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            placeholder={t('audit:filterActor')}
            className="font-mono text-xs"
          />
        </div>
        <select
          value={result}
          onChange={(e) => setResult(e.target.value as AuditResult | '')}
          className={selectClass}
        >
          <option value="">{t('audit:allResults')}</option>
          {RESULTS.map((r) => (
            <option key={r} value={r}>
              {t(`audit:result.${r}`)}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          aria-label={t('audit:filterFrom')}
          title={t('audit:filterFrom')}
          className={selectClass}
        />
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          aria-label={t('audit:filterTo')}
          title={t('audit:filterTo')}
          className={selectClass}
        />
        <Button
          size="sm"
          variant="default"
          onClick={() => refetch()}
          className="max-md:w-full"
        >
          {isFetching ? t('audit:updating') : t('common:actions.refresh')}
        </Button>
      </div>

      {forbidden ? (
        <Alert type="warning" showIcon>
          {t('audit:forbidden')}
        </Alert>
      ) : unsupported ? (
        <Alert type="info" showIcon>
          {t('audit:unsupported')}
        </Alert>
      ) : isError ? (
        <Alert type="danger" showIcon>
          {error instanceof ApiRequestError ? error.message : t('audit:loadError')}
        </Alert>
      ) : (
        <>
          <Card bordered bodyClass="p-0" className="overflow-hidden">
            {isLoading ? (
              <div className="p-5">
                <Skeleton height={220} />
              </div>
            ) : entries.length === 0 ? (
              <div className="px-5 py-12 text-center text-sm text-slate-500">
                {t('audit:empty')}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <THead>
                    <Tr>
                      <Th>{t('audit:col.timestamp')}</Th>
                      <Th>{t('audit:col.actor')}</Th>
                      <Th>{t('audit:col.action')}</Th>
                      <Th>{t('audit:col.target')}</Th>
                      <Th>{t('audit:col.ip')}</Th>
                      <Th>{t('audit:col.result')}</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {entries.map((entry) => (
                      <EntryRow key={entry.id} entry={entry} />
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
          </Card>

          {total > PAGE_SIZE && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-fg-subtle">{t('audit:totalCount', { count: total })}</span>
              <Pagination
                currentPage={page}
                pageSize={PAGE_SIZE}
                total={total}
                onChange={setPage}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
