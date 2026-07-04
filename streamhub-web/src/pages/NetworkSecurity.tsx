/**
 * Network security — the in-app IP access control + auto-ban surface, rendered
 * as a section of the Server Settings page (superadmin-only, like the rest).
 *
 * Shows the enforcement mode + auto-ban status and counts, the allow/block
 * rule list with add (CIDR + note) / remove, the active bans with one-click
 * unban, and the recent offenders window. All data via the typed `api.security`
 * client; a 403 (non-superadmin) renders nothing — the parent page already
 * explains the required scope.
 */
import { useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  api,
  ApiRequestError,
  type SecurityBan,
  type SecurityIpRule,
  type SecurityOffender,
  type SecurityStatus,
} from '@/api'
import { Alert, Button, Card, Input, Skeleton, Table, Tag } from '@/ui'
import { isValidCidr } from '@/lib/cidr'
import { relativeTime } from '@/lib/relativeTime'

const { THead, TBody, Tr, Th, Td } = Table

const POLL_MS = 30_000

type Tone = 'green' | 'amber' | 'red' | 'slate'

const BADGE_TONE: Record<Tone, string> = {
  green: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-100',
  amber: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-100',
  red: 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-100',
  slate: 'bg-gray-100 text-gray-600 dark:bg-gray-600/60 dark:text-gray-100',
}

function ToneBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <Tag className={`border-transparent py-0.5 ${BADGE_TONE[tone]}`}>{children}</Tag>
}

function modeTone(mode: SecurityStatus['mode']): Tone {
  if (mode === 'enforce') return 'green'
  if (mode === 'log') return 'amber'
  return 'slate'
}

function errText(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) return error.message
  if (error instanceof Error) return error.message
  return fallback
}

/** Localised relative timestamp (reuses the shared bucketing helper). */
function Rel({ iso }: { iso: string | null }) {
  const { t } = useTranslation('networkSecurity')
  const { unit, count, invalid } = relativeTime(iso)
  if (invalid) return <span className="text-slate-500">—</span>
  if (unit === 'now') return <span className="text-slate-500">{t('relative.now')}</span>
  return <span className="text-slate-500">{t(`relative.${unit}`, { count })}</span>
}

// --- status summary -----------------------------------------------------------

function StatusRow({ s }: { s: SecurityStatus }) {
  const { t } = useTranslation('networkSecurity')
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ToneBadge tone={modeTone(s.mode)}>
        {t('status.mode')}: {t(`mode.${s.mode}`)}
      </ToneBadge>
      {s.allowlistOnly && <ToneBadge tone="red">{t('status.allowlistOnly')}</ToneBadge>}
      <ToneBadge tone={s.autoban.enabled ? 'green' : 'slate'}>
        {t('status.autoban')}: {t(s.autoban.enabled ? 'status.on' : 'status.off')}
      </ToneBadge>
      <span className="text-xs text-fg-muted">
        {t('status.counts', {
          rules: s.counts.rules,
          bans: s.counts.activeBans,
          offenders: s.counts.trackedOffenders,
        })}
      </span>
    </div>
  )
}

// --- rules ---------------------------------------------------------------------

function AddRuleForm() {
  const { t } = useTranslation('networkSecurity')
  const qc = useQueryClient()
  const [cidr, setCidr] = useState('')
  const [action, setAction] = useState<'allow' | 'block'>('block')
  const [note, setNote] = useState('')

  const add = useMutation({
    mutationFn: () =>
      api.security.addRule({ cidr: cidr.trim(), action, note: note.trim() || undefined }),
    onSuccess: () => {
      setCidr('')
      setNote('')
      void qc.invalidateQueries({ queryKey: ['security-rules'] })
      void qc.invalidateQueries({ queryKey: ['security-status'] })
    },
  })

  const cidrOk = isValidCidr(cidr)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (cidrOk && !add.isPending) add.mutate()
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          size="sm"
          className="w-56 font-mono text-xs"
          placeholder={t('rules.cidrPlaceholder')}
          value={cidr}
          onChange={(e) => setCidr(e.target.value)}
          invalid={cidr.trim().length > 0 && !cidrOk}
        />
        <div className="flex overflow-hidden rounded-lg border border-border/60">
          {(['block', 'allow'] as const).map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setAction(a)}
              className={`px-3 py-1.5 text-xs font-medium transition ${
                action === a
                  ? a === 'block'
                    ? 'bg-red-500/90 text-white'
                    : 'bg-emerald-500/90 text-white'
                  : 'bg-transparent text-fg-muted hover:text-fg'
              }`}
            >
              {t(`rules.action.${a}`)}
            </button>
          ))}
        </div>
        <Input
          size="sm"
          className="w-52 text-xs"
          placeholder={t('rules.notePlaceholder')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <Button size="sm" variant="solid" type="submit" disabled={!cidrOk} loading={add.isPending}>
          {t('rules.add')}
        </Button>
      </div>
      {add.isError && (
        <Alert type="danger" showIcon>
          {errText(add.error, t('rules.addError'))}
        </Alert>
      )}
    </form>
  )
}

function RulesTable({ rules }: { rules: SecurityIpRule[] }) {
  const { t } = useTranslation('networkSecurity')
  const qc = useQueryClient()
  const remove = useMutation({
    mutationFn: (id: number) => api.security.removeRule(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['security-rules'] })
      void qc.invalidateQueries({ queryKey: ['security-status'] })
    },
  })

  if (rules.length === 0) {
    return <p className="text-sm text-fg-muted">{t('rules.empty')}</p>
  }
  return (
    <div className="overflow-x-auto">
      <Table compact>
        <THead>
          <Tr>
            <Th>{t('rules.cidr')}</Th>
            <Th>{t('rules.actionHeader')}</Th>
            <Th>{t('rules.note')}</Th>
            <Th>{t('rules.created')}</Th>
            <Th />
          </Tr>
        </THead>
        <TBody>
          {rules.map((r) => (
            <Tr key={r.id}>
              <Td>
                <span className="font-mono text-xs">{r.cidr}</span>
              </Td>
              <Td>
                <ToneBadge tone={r.action === 'allow' ? 'green' : 'red'}>
                  {t(`rules.action.${r.action}`)}
                </ToneBadge>
              </Td>
              <Td>
                <span className="text-xs text-fg-muted">{r.note ?? '—'}</span>
              </Td>
              <Td>
                <Rel iso={r.createdAt} />
              </Td>
              <Td>
                <Button
                  size="xs"
                  variant="default"
                  loading={remove.isPending && remove.variables === r.id}
                  onClick={() => remove.mutate(r.id)}
                >
                  {t('rules.remove')}
                </Button>
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </div>
  )
}

// --- bans + offenders ----------------------------------------------------------

function BansTable({ bans }: { bans: SecurityBan[] }) {
  const { t } = useTranslation('networkSecurity')
  const qc = useQueryClient()
  const unban = useMutation({
    mutationFn: (ip: string) => api.security.unban(ip),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['security-bans'] })
      void qc.invalidateQueries({ queryKey: ['security-status'] })
    },
  })

  if (bans.length === 0) {
    return <p className="text-sm text-fg-muted">{t('bans.empty')}</p>
  }
  return (
    <div className="overflow-x-auto">
      <Table compact>
        <THead>
          <Tr>
            <Th>{t('bans.ip')}</Th>
            <Th>{t('bans.reason')}</Th>
            <Th>{t('bans.offenses')}</Th>
            <Th>{t('bans.until')}</Th>
            <Th>{t('bans.level')}</Th>
            <Th />
          </Tr>
        </THead>
        <TBody>
          {bans.map((b) => (
            <Tr key={b.ip}>
              <Td>
                <span className="font-mono text-xs">{b.ip}</span>
              </Td>
              <Td>
                <span className="text-xs text-fg-muted">{t(`offenseKind.${b.reason}`, { defaultValue: b.reason })}</span>
              </Td>
              <Td>
                <span className="text-xs tabular-nums">{b.offenseCount}</span>
              </Td>
              <Td>
                <span className="text-xs">{new Date(b.bannedUntil).toLocaleString()}</span>
              </Td>
              <Td>
                <span className="text-xs tabular-nums">{b.escalationLevel}</span>
              </Td>
              <Td>
                <Button
                  size="xs"
                  variant="default"
                  loading={unban.isPending && unban.variables === b.ip}
                  onClick={() => unban.mutate(b.ip)}
                >
                  {t('bans.unban')}
                </Button>
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </div>
  )
}

function OffendersTable({ offenders }: { offenders: SecurityOffender[] }) {
  const { t } = useTranslation('networkSecurity')
  if (offenders.length === 0) {
    return <p className="text-sm text-fg-muted">{t('offenders.empty')}</p>
  }
  return (
    <div className="overflow-x-auto">
      <Table compact>
        <THead>
          <Tr>
            <Th>{t('offenders.ip')}</Th>
            <Th>{t('offenders.count')}</Th>
            <Th>{t('offenders.kinds')}</Th>
            <Th>{t('offenders.lastSeen')}</Th>
          </Tr>
        </THead>
        <TBody>
          {offenders.map((o) => (
            <Tr key={o.ip}>
              <Td>
                <span className="font-mono text-xs">{o.ip}</span>
              </Td>
              <Td>
                <span className="text-xs tabular-nums">{o.count}</span>
              </Td>
              <Td>
                <span className="text-xs text-fg-muted">
                  {Object.entries(o.kinds)
                    .map(([k, n]) => `${t(`offenseKind.${k}`, { defaultValue: k })} ×${n}`)
                    .join(', ')}
                </span>
              </Td>
              <Td>
                <Rel iso={o.lastSeen} />
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </div>
  )
}

// --- section -------------------------------------------------------------------

export function NetworkSecuritySection() {
  const { t } = useTranslation('networkSecurity')

  const status = useQuery({
    queryKey: ['security-status'],
    queryFn: ({ signal }) => api.security.status(signal),
    refetchInterval: POLL_MS,
    retry: (count, err) => !(err instanceof ApiRequestError && err.status === 403) && count < 2,
  })
  const rules = useQuery({
    queryKey: ['security-rules'],
    queryFn: ({ signal }) => api.security.rules(signal),
    refetchInterval: POLL_MS,
    retry: false,
  })
  const bans = useQuery({
    queryKey: ['security-bans'],
    queryFn: ({ signal }) => api.security.bans(signal),
    refetchInterval: POLL_MS,
    retry: false,
  })
  const offenses = useQuery({
    queryKey: ['security-offenses'],
    queryFn: ({ signal }) => api.security.offenses(signal),
    refetchInterval: POLL_MS,
    retry: false,
  })

  // Superadmin-gated like the rest of Settings: a 403 (or an older core
  // without the module) renders nothing rather than a broken card.
  if (status.error instanceof ApiRequestError && (status.error.status === 403 || status.error.status === 404)) {
    return null
  }

  return (
    <Card bordered>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-fg">{t('title')}</h2>
        <p className="mt-0.5 text-xs text-slate-500">{t('subtitle')}</p>
      </div>

      {status.isLoading || !status.data ? (
        <Skeleton height={90} />
      ) : (
        <div className="space-y-6">
          <StatusRow s={status.data} />

          {status.data.mode === 'off' && !status.data.autoban.enabled && (
            <Alert type="info" showIcon>
              {t('disabledHint')}
            </Alert>
          )}

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
              {t('rules.title')}
            </h3>
            <div className="space-y-3">
              <AddRuleForm />
              {rules.isLoading ? <Skeleton height={40} /> : <RulesTable rules={rules.data ?? []} />}
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
              {t('bans.title')}
            </h3>
            {bans.isLoading ? <Skeleton height={40} /> : <BansTable bans={bans.data?.active ?? []} />}
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
              {t('offenders.title')}
            </h3>
            {offenses.isLoading ? (
              <Skeleton height={40} />
            ) : (
              <OffendersTable offenders={offenses.data ?? []} />
            )}
          </div>

          <p className="text-xs text-fg-subtle">{t('envHint')}</p>
        </div>
      )}
    </Card>
  )
}
