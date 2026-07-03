/**
 * Integraciones tab — outbound callbacks + S3 storage + feature flags + QC
 * token. Reorganized into four clearly-delimited sections, each with an
 * anchor and a UNIFIED, explicit save pattern (see SaveStatus):
 *
 *  - Callbacks (config.callbacks): url + secret. Explicit "Save" button with a
 *    live status (unsaved / saving / saved / error). The core POSTs a signed
 *    request to `url` for EVERY classifiable room event (collapsible list).
 *  - S3 storage (config.s3): recording destination. Explicit "Save" button +
 *    status, same as Callbacks.
 *  - Feature flags (config.features): auto-saved toggles WITH a header status
 *    indicator so a toggle change is never ambiguous.
 *  - QC token: an action (mint), not a persisted setting — kept as a button.
 *
 * All four persist on PATCH /apps/:app/config (S3 on PUT /apps/:app/s3).
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { api } from '@/api'
import type { AppFeatures, MintedToken, S3Provider } from '@/api'
import {
  Button,
  Card,
  CopyField,
  ErrorBanner,
  Field,
  Loading,
  SectionTitle,
  Select,
  TextInput,
  Toggle,
  errMessage,
} from './ui'

type FeatureKey = keyof AppFeatures

const FEATURE_KEYS: FeatureKey[] = [
  'chat',
  'reactions',
  'viewerCounter',
  'hiddenQc',
  'adaptivePlayer',
  'rtmpPassword',
]

// Spec §4 — taxonomy surfaced so integrators know what to expect.
// `groupKey` maps to i18n (integracionesTab:eventGroups.*); event names are literal.
const EVENT_GROUPS: { groupKey: string; events: string }[] = [
  {
    groupKey: 'roomParticipants',
    events:
      'room_started, room_finished, participant_joined, participant_left, track_published, track_unpublished',
  },
  {
    groupKey: 'ingressEgress',
    events:
      'ingress_started, ingress_ended, egress_started, egress_updated, egress_ended',
  },
  {
    groupKey: 'streamhub',
    events:
      'stream_started, stream_ended, recording_started, recording_part_ready, recording_ready, recording_failed, snapshot_taken, vod_ready, chat_message, reaction',
  },
]

// --- unified save status -----------------------------------------------------
// One vocabulary of states across every section so the user never doubts
// whether a change was persisted.
type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

function SaveStatus({
  state,
  savedLabel,
}: {
  state: SaveState
  /** Optional override for the "saved" message (e.g. S3 re-init note). */
  savedLabel?: string
}) {
  const { t } = useTranslation('integracionesTab')
  if (state === 'saving')
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400" />
        {t('saveStatus.saving')}
      </span>
    )
  if (state === 'saved')
    return (
      <span className="text-xs font-medium text-success">
        {savedLabel ?? t('saveStatus.saved')}
      </span>
    )
  if (state === 'error')
    return <span className="text-xs font-medium text-danger">{t('saveStatus.error')}</span>
  if (state === 'dirty')
    return <span className="text-xs text-warn">{t('saveStatus.dirty')}</span>
  return null
}

// --- section anchors ---------------------------------------------------------

const SECTIONS = ['callbacks', 's3', 'features', 'qc'] as const

function SectionNav() {
  const { t } = useTranslation('integracionesTab')
  return (
    <nav className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
      {SECTIONS.map((id) => (
        <a
          key={id}
          href={`#int-${id}`}
          className="shrink-0 rounded-full border border-navy-600 bg-navy-700/40 px-3 py-1.5 text-xs text-slate-300 transition hover:border-blue2/50 hover:text-slate-100"
        >
          {t(`nav.${id}`)}
        </a>
      ))}
    </nav>
  )
}

/** Wraps a card so an anchor jump lands with a little breathing room. */
function Section({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <section id={`int-${id}`} className="scroll-mt-4">
      {children}
    </section>
  )
}

// --- callbacks ---------------------------------------------------------------

function CallbacksCard({ app }: { app: string }) {
  const { t } = useTranslation(['integracionesTab', 'common'])
  const qc = useQueryClient()
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['app-config', app],
    queryFn: ({ signal }) => api.apps.getConfig(app, signal),
  })

  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState('')

  useEffect(() => {
    setUrl(data?.callbacks?.url ?? '')
    setSecret(data?.callbacks?.secret ?? '')
  }, [data])

  const save = useMutation({
    mutationFn: () =>
      api.apps.updateConfig(app, {
        callbacks: { url: url.trim(), secret: secret.trim() },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['app-config', app] }),
  })

  if (isLoading) return <Loading label={t('callbacks.loading')} />
  if (isError)
    return (
      <ErrorBanner message={errMessage(error, t('callbacks.loadError'))} />
    )

  const dirty =
    url !== (data?.callbacks?.url ?? '') ||
    secret !== (data?.callbacks?.secret ?? '')
  const state: SaveState = save.isPending
    ? 'saving'
    : dirty
      ? 'dirty'
      : save.isSuccess
        ? 'saved'
        : 'idle'

  return (
    <Card>
      <SectionTitle
        title={t('callbacks.title')}
        subtitle={t('callbacks.subtitle')}
      />
      <div className="space-y-4">
        <Field
          label={t('callbacks.urlLabel')}
          hint={t('callbacks.urlHint')}
        >
          <TextInput
            value={url}
            placeholder={t('callbacks.urlPlaceholder')}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <Field
          label={t('callbacks.secretLabel')}
          hint={t('callbacks.secretHint')}
        >
          <TextInput
            value={secret}
            placeholder={t('callbacks.secretPlaceholder')}
            onChange={(e) => setSecret(e.target.value)}
          />
        </Field>

        <div className="rounded-lg border border-navy-600 bg-navy-700/40 p-4">
          <p className="text-xs text-slate-300">
            <Trans
              t={t}
              i18nKey="callbacks.payloadInfo"
              values={{ payload: '{ event, app, room, ts, data }' }}
              components={[
                <span className="font-medium text-slate-100" key="0" />,
                <code className="rounded bg-navy-800 px-1 py-0.5 font-mono text-[11px] text-sky2" key="1" />,
                <code className="font-mono text-[11px] text-sky2" key="2" />,
                <code className="font-mono text-[11px] text-sky2" key="3" />,
              ]}
            />
          </p>

          {/* Collapsible taxonomy: keeps the long event list out of the way. */}
          <details className="group mt-3 rounded-lg border border-navy-600 bg-navy-800/40">
            <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-[11px] font-medium text-slate-300">
              <span>{t('callbacks.eventsSummary')}</span>
              <span className="text-slate-500 group-open:hidden">
                {t('callbacks.eventsShow')}
              </span>
              <span className="hidden text-slate-500 group-open:inline">
                {t('callbacks.eventsHide')}
              </span>
            </summary>
            <div className="space-y-2 border-t border-navy-600 px-3 py-3">
              {EVENT_GROUPS.map((g) => (
                <div key={g.groupKey}>
                  <div className="text-[11px] font-medium text-slate-400">
                    {t(`eventGroups.${g.groupKey}`)}
                  </div>
                  <div className="font-mono text-[11px] leading-relaxed text-slate-500">
                    {g.events}
                  </div>
                </div>
              ))}
            </div>
          </details>
        </div>

        {save.isError && (
          <ErrorBanner message={errMessage(save.error, t('callbacks.saveError'))} />
        )}
        <div className="flex items-center gap-3">
          <Button
            variant="accent"
            disabled={save.isPending || !dirty}
            onClick={() => save.mutate()}
          >
            {save.isPending ? t('callbacks.saving') : t('callbacks.save')}
          </Button>
          <SaveStatus state={save.isError ? 'error' : state} />
        </div>
      </div>
    </Card>
  )
}

// --- S3 storage --------------------------------------------------------------

const PROVIDERS: { value: S3Provider; label: string }[] = [
  { value: 'aws', label: 'AWS S3' },
  { value: 'wasabi', label: 'Wasabi' },
  { value: 'minio', label: 'MinIO' },
]

function S3Card({ app }: { app: string }) {
  const { t } = useTranslation(['integracionesTab', 'common'])
  const qc = useQueryClient()
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['app-s3', app],
    queryFn: ({ signal }) => api.apps.getS3(app, signal),
  })

  const [provider, setProvider] = useState<string>('aws')
  const [bucket, setBucket] = useState('')
  const [region, setRegion] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [prefix, setPrefix] = useState('')
  const [publicUrl, setPublicUrl] = useState('')
  // Fold 3: explicit opt-in to make recordings public.
  const [ackPublic, setAckPublic] = useState(false)
  // Secrets: never prefilled. Sent only when the user types a new value.
  const [key, setKey] = useState('')
  const [secret, setSecret] = useState('')

  useEffect(() => {
    if (!data) return
    setProvider(data.provider || 'aws')
    setBucket(data.bucket ?? '')
    setRegion(data.region ?? '')
    setEndpoint(data.endpoint ?? '')
    setPrefix(data.prefix ?? '')
    setPublicUrl(data.public_url ?? '')
    setAckPublic(false)
    setKey('')
    setSecret('')
  }, [data])

  const save = useMutation({
    mutationFn: () =>
      api.apps.putS3(app, {
        provider,
        bucket: bucket.trim(),
        region: region.trim(),
        endpoint: endpoint.trim(),
        prefix: prefix.trim(),
        public_url: publicUrl.trim(),
        // Omit empty secrets so the server keeps the stored credentials.
        ...(key.trim() ? { key: key.trim() } : {}),
        ...(secret.trim() ? { secret: secret.trim() } : {}),
      }),
    onSuccess: () => {
      setKey('')
      setSecret('')
      setAckPublic(false)
      qc.invalidateQueries({ queryKey: ['app-s3', app] })
    },
  })

  if (isLoading) return <Loading label={t('s3.loading')} />
  if (isError)
    return <ErrorBanner message={errMessage(error, t('s3.loadError'))} />

  const hasStoredCreds = Boolean(data?.configured || data?.key || data?.secret)
  const publicSet = publicUrl.trim() !== ''
  // "Enabling" = turning a previously-private app into a public one.
  const enablingPublic = publicSet && !(data?.public_url ?? '')
  const saveBlocked = enablingPublic && !ackPublic

  const dirty =
    provider !== (data?.provider || 'aws') ||
    bucket !== (data?.bucket ?? '') ||
    region !== (data?.region ?? '') ||
    endpoint !== (data?.endpoint ?? '') ||
    prefix !== (data?.prefix ?? '') ||
    publicUrl !== (data?.public_url ?? '') ||
    key.trim() !== '' ||
    secret.trim() !== ''
  const state: SaveState = save.isPending
    ? 'saving'
    : dirty
      ? 'dirty'
      : save.isSuccess
        ? 'saved'
        : 'idle'

  function onSave() {
    if (enablingPublic) {
      const ok = window.confirm(t('s3.confirmPublic'))
      if (!ok) return
    }
    save.mutate()
  }

  return (
    <Card>
      <SectionTitle
        title={t('s3.title')}
        subtitle={t('s3.subtitle')}
      />
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('s3.providerLabel')}>
            <Select value={provider} onChange={(e) => setProvider(e.target.value)}>
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('s3.bucketLabel')}>
            <TextInput
              value={bucket}
              placeholder={t('s3.bucketPlaceholder')}
              onChange={(e) => setBucket(e.target.value)}
            />
          </Field>
          <Field label={t('s3.regionLabel')}>
            <TextInput
              value={region}
              placeholder="us-east-1"
              onChange={(e) => setRegion(e.target.value)}
            />
          </Field>
          <Field label={t('s3.endpointLabel')} hint={t('s3.endpointHint')}>
            <TextInput
              value={endpoint}
              placeholder="https://s3.wasabisys.com"
              onChange={(e) => setEndpoint(e.target.value)}
            />
          </Field>
          <Field label={t('s3.prefixLabel')} hint={t('s3.prefixHint')}>
            <TextInput
              value={prefix}
              placeholder="streamhub/vods"
              onChange={(e) => setPrefix(e.target.value)}
            />
          </Field>
          <Field
            label={t('s3.publicUrlLabel')}
            hint={t('s3.publicUrlHint')}
          >
            <TextInput
              value={publicUrl}
              placeholder={t('s3.publicUrlPlaceholder')}
              onChange={(e) => setPublicUrl(e.target.value)}
            />
          </Field>
        </div>

        {publicSet ? (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4">
            <p className="text-xs font-medium text-danger">
              {t('s3.publicWarnTitle')}
            </p>
            <p className="mt-1 text-[11px] text-danger/90">
              <Trans
                t={t}
                i18nKey="s3.publicWarnBody"
                values={{ objectPath: '<public_url>/<objectKey>' }}
                components={[
                  <span className="font-mono" key="0" />,
                  <span className="font-mono" key="1" />,
                  <span className="text-slate-100" key="2" />,
                  <span className="text-slate-100" key="3" />,
                  <span className="text-slate-100" key="4" />,
                ]}
              />
            </p>
            {enablingPublic && (
              <label className="mt-3 flex items-start gap-2 text-[11px] text-danger">
                <input
                  type="checkbox"
                  checked={ackPublic}
                  onChange={(e) => setAckPublic(e.target.checked)}
                  className="mt-0.5"
                />
                {t('s3.publicAck')}
              </label>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-navy-600 bg-navy-700/40 p-4">
            <p className="text-[11px] text-slate-400">
              <Trans
                t={t}
                i18nKey="s3.privateInfo"
                components={[
                  <span className="font-mono text-sky2" key="0" />,
                  <span className="text-slate-100" key="1" />,
                ]}
              />
            </p>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('s3.accessKeyLabel')}
            hint={hasStoredCreds ? t('s3.storedHint') : undefined}
          >
            <TextInput
              type="password"
              autoComplete="off"
              value={key}
              placeholder={data?.key || '••••••••'}
              onChange={(e) => setKey(e.target.value)}
            />
          </Field>
          <Field
            label={t('s3.secretKeyLabel')}
            hint={hasStoredCreds ? t('s3.storedHint') : undefined}
          >
            <TextInput
              type="password"
              autoComplete="off"
              value={secret}
              placeholder={data?.secret || '••••••••'}
              onChange={(e) => setSecret(e.target.value)}
            />
          </Field>
        </div>

        {save.isError && (
          <ErrorBanner message={errMessage(save.error, t('s3.saveError'))} />
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="accent"
            disabled={save.isPending || saveBlocked || !dirty}
            onClick={onSave}
          >
            {save.isPending ? t('s3.saving') : t('s3.save')}
          </Button>
          {saveBlocked ? (
            <span className="text-xs text-warn">{t('s3.saveBlocked')}</span>
          ) : (
            <SaveStatus
              state={save.isError ? 'error' : state}
              savedLabel={t('s3.saved')}
            />
          )}
        </div>
      </div>
    </Card>
  )
}

// --- features ----------------------------------------------------------------

function FeaturesCard({ app }: { app: string }) {
  const { t } = useTranslation('integracionesTab')
  const qc = useQueryClient()
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['app-config', app],
    queryFn: ({ signal }) => api.apps.getConfig(app, signal),
  })

  const [features, setFeatures] = useState<AppFeatures>({})

  useEffect(() => {
    if (data?.features) setFeatures(data.features)
    else if (data) setFeatures({})
  }, [data])

  const save = useMutation({
    mutationFn: (next: AppFeatures) => api.apps.updateConfig(app, { features: next }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['app-config', app] }),
  })

  function toggle(key: FeatureKey, value: boolean) {
    const next = { ...features, [key]: value }
    setFeatures(next)
    save.mutate(next)
  }

  if (isLoading) return <Loading label={t('featuresCard.loading')} />
  if (isError)
    return <ErrorBanner message={errMessage(error, t('featuresCard.loadError'))} />

  // Auto-save: surface the same status vocabulary in the header so a toggle is
  // never ambiguous.
  const state: SaveState = save.isPending
    ? 'saving'
    : save.isError
      ? 'error'
      : save.isSuccess
        ? 'saved'
        : 'idle'

  return (
    <Card>
      <SectionTitle
        title={t('featuresCard.title')}
        subtitle={t('featuresCard.subtitle')}
        right={<SaveStatus state={state} />}
      />
      <div className="space-y-2">
        {FEATURE_KEYS.map((key) => (
          <div
            key={key}
            className="flex items-center justify-between gap-4 rounded-lg border border-navy-600 bg-navy-700/40 px-4 py-3"
          >
            <div>
              <div className="text-sm text-slate-100">{t(`features.${key}.label`)}</div>
              <div className="mt-0.5 text-[11px] text-slate-500">{t(`features.${key}.hint`)}</div>
            </div>
            <Toggle
              checked={Boolean(features[key])}
              onChange={(v) => toggle(key, v)}
              disabled={save.isPending}
            />
          </div>
        ))}
      </div>
      {save.isError && (
        <div className="mt-4">
          <ErrorBanner message={errMessage(save.error, t('featuresCard.saveError'))} />
        </div>
      )}
    </Card>
  )
}

// --- QC token ----------------------------------------------------------------

function QcTokenCard({ app }: { app: string }) {
  const { t } = useTranslation('integracionesTab')
  const qcToken = useMutation<MintedToken>({
    mutationFn: () => api.tokens.mint(app, { hidden: true, canPublish: false }),
  })

  return (
    <Card>
      <SectionTitle
        title={t('qc.title')}
        subtitle={t('qc.subtitle')}
        right={
          <Button
            variant="accent"
            disabled={qcToken.isPending}
            onClick={() => qcToken.mutate()}
          >
            {qcToken.isPending ? t('qc.generating') : t('qc.generate')}
          </Button>
        }
      />
      {qcToken.isError && (
        <ErrorBanner message={errMessage(qcToken.error, t('qc.error'))} />
      )}
      {qcToken.data && (
        <div className="space-y-3">
          <CopyField label={t('qc.tokenJwt')} value={qcToken.data.token} />
          <CopyField label="wsUrl" value={qcToken.data.wsUrl} />
          {qcToken.data.joinUrl && (
            <CopyField label="joinUrl" value={qcToken.data.joinUrl} />
          )}
        </div>
      )}
    </Card>
  )
}

// --- tab ---------------------------------------------------------------------

export function IntegracionesTab({ app }: { app: string }) {
  return (
    <div className="space-y-5">
      <SectionNav />
      <Section id="callbacks">
        <CallbacksCard app={app} />
      </Section>
      <Section id="s3">
        <S3Card app={app} />
      </Section>
      <Section id="features">
        <FeaturesCard app={app} />
      </Section>
      <Section id="qc">
        <QcTokenCard app={app} />
      </Section>
    </div>
  )
}
