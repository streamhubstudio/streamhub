/**
 * Tokens tab — mint a LiveKit join token (POST /apps/:app/tokens) with deep
 * links to the in-app /player and /meeting surfaces, and list global API
 * tokens (GET /tokens) with revoke (DELETE /tokens/:id).
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/api'
import type { MintTokenRequest, MintedToken, TokenSummary } from '@/api'
import {
  Badge,
  Button,
  Card,
  CopyField,
  Empty,
  ErrorBanner,
  Field,
  Loading,
  RTable,
  RTd,
  RTh,
  RTr,
  SectionTitle,
  TextInput,
  Toggle,
  errMessage,
} from './ui'

export function TokensTab({ app }: { app: string }) {
  const { t } = useTranslation(['tokensTab', 'common', 'appDetail'])
  const qc = useQueryClient()

  const [room, setRoom] = useState('demo')
  const [identity, setIdentity] = useState('')
  const [name, setName] = useState('')
  const [canPublish, setCanPublish] = useState(true)

  const mint = useMutation<MintedToken>({
    mutationFn: () => {
      const payload: MintTokenRequest = { canPublish, canSubscribe: true }
      if (room.trim()) payload.room = room.trim()
      if (identity.trim()) payload.identity = identity.trim()
      if (name.trim()) payload.name = name.trim()
      return api.tokens.mint(app, payload)
    },
  })

  const globals = useQuery({
    queryKey: ['tokens-global'],
    queryFn: ({ signal }) => api.tokens.list(signal),
    placeholderData: keepPreviousData,
  })

  const revoke = useMutation({
    mutationFn: (id: number) => api.tokens.revoke(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tokens-global'] }),
  })

  const roomForLink = encodeURIComponent(room.trim() || 'demo')
  const tokens = globals.data ?? []

  return (
    <div className="space-y-5">
      <Card>
        <SectionTitle title={t('mint.title')} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('mint.roomLabel')} hint={t('mint.roomHint')}>
            <TextInput value={room} placeholder="demo" onChange={(e) => setRoom(e.target.value)} />
          </Field>
          <Field label={t('mint.identityLabel')} hint={t('mint.identityHint')}>
            <TextInput
              value={identity}
              placeholder="user-123"
              onChange={(e) => setIdentity(e.target.value)}
            />
          </Field>
          <Field label={t('mint.nameLabel')} hint={t('mint.nameHint')}>
            <TextInput value={name} placeholder="Alice" onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="flex items-center justify-between gap-4 rounded-lg border border-navy-600 bg-navy-700/40 px-4 py-3">
            <div>
              <div className="text-sm text-slate-100">{t('mint.canPublishLabel')}</div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                {t('mint.canPublishHint')}
              </div>
            </div>
            <Toggle checked={canPublish} onChange={setCanPublish} />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="accent" disabled={mint.isPending} onClick={() => mint.mutate()}>
            {mint.isPending ? t('mint.generating') : t('mint.generate')}
          </Button>
          <Link
            to={`/player/${encodeURIComponent(app)}/${roomForLink}`}
            className="rounded-lg border border-navy-600 px-3 py-2 text-xs text-slate-300 transition hover:text-slate-100"
          >
            {t('mint.openPlayer')}
          </Link>
          <Link
            to={`/meeting/${encodeURIComponent(app)}/${roomForLink}`}
            className="rounded-lg border border-navy-600 px-3 py-2 text-xs text-slate-300 transition hover:text-slate-100"
          >
            {t('mint.openMeeting')}
          </Link>
        </div>

        {mint.isError && (
          <div className="mt-4">
            <ErrorBanner message={errMessage(mint.error, t('mint.error'))} />
          </div>
        )}
        {mint.data && (
          <div className="mt-4 space-y-3">
            <CopyField label={t('mint.tokenJwt')} value={mint.data.token} />
            <CopyField label="wsUrl" value={mint.data.wsUrl} />
            {mint.data.joinUrl && <CopyField label="joinUrl" value={mint.data.joinUrl} />}
            {mint.data.player_url && (
              <CopyField label="player_url" value={mint.data.player_url} mono={false} />
            )}
          </div>
        )}
      </Card>

      <Card className="p-0">
        <div className="p-5">
          <SectionTitle
            title={t('globals.title')}
            subtitle={t('globals.subtitle')}
            right={
              <Button variant="ghost" onClick={() => globals.refetch()}>
                {globals.isFetching ? t('appDetail:state.updating') : t('common:actions.refresh')}
              </Button>
            }
          />
          {revoke.isError && (
            <ErrorBanner message={errMessage(revoke.error, t('globals.revokeError'))} />
          )}
        </div>

        {globals.isLoading ? (
          <Loading label={t('globals.loading')} />
        ) : globals.isError ? (
          <div className="p-5">
            <ErrorBanner message={errMessage(globals.error, t('globals.loadError'))} />
          </div>
        ) : tokens.length === 0 ? (
          <Empty label={t('globals.empty')} />
        ) : (
          <RTable
            head={
              <tr>
                <RTh>#</RTh>
                <RTh>{t('globals.table.name')}</RTh>
                <RTh>{t('globals.table.scope')}</RTh>
                <RTh>{t('globals.table.lastUsed')}</RTh>
                <RTh>{t('globals.table.status')}</RTh>
                <RTh className="text-right">{t('globals.table.action')}</RTh>
              </tr>
            }
          >
            {tokens.map((tok: TokenSummary) => (
              <RTr key={tok.id}>
                <RTd label="#" className="font-mono text-xs text-slate-400">
                  {tok.id}
                </RTd>
                <RTd label={t('globals.table.name')} className="text-slate-300">
                  {tok.name}
                </RTd>
                <RTd label={t('globals.table.scope')}>
                  <Badge tone="cyan">{tok.scope}</Badge>
                </RTd>
                <RTd label={t('globals.table.lastUsed')} className="text-xs text-slate-400">
                  {tok.lastUsedAt ?? '—'}
                </RTd>
                <RTd label={t('globals.table.status')}>
                  <Badge tone={tok.revoked ? 'red' : 'green'}>
                    {tok.revoked ? t('globals.revoked') : t('globals.active')}
                  </Badge>
                </RTd>
                <RTd actions className="text-right">
                  <Button
                    variant="danger"
                    disabled={tok.revoked || revoke.isPending}
                    onClick={() => {
                      if (confirm(t('globals.confirmRevoke', { id: tok.id }))) revoke.mutate(tok.id)
                    }}
                  >
                    {t('globals.revoke')}
                  </Button>
                </RTd>
              </RTr>
            ))}
          </RTable>
        )}
      </Card>
    </div>
  )
}
