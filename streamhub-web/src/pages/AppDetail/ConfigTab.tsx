/**
 * Config tab — GET/PATCH /apps/:app/config (transcoding / adaptive ladder).
 * Edits adaptive delivery, RTMP transcode and the rendition layers.
 * Feature flags and callbacks live on the Integraciones tab (same endpoint).
 *
 * G4 fold-2 (CONFIG-UX): the tab's four sections (Presets, Transcoding, the
 * raw YAML editor, its Backups) are now TABS of their own — named after each
 * section's existing `<SectionTitle>` — instead of two always-visible cards
 * plus a collapsed "Advanced" `<details>` for the last two. Deep-linkable via
 * `?section=`, same pattern as the outer AppDetail `?tab=` (see AppDetail.tsx).
 * All sections stay MOUNTED at all times (only the active one is visible, via a
 * `hidden` class) so switching sections never resets in-progress state — e.g.
 * the raw editor's unsaved-changes flag (RawConfigCard's own `dirty` state).
 *
 * The "System" section additionally hosts the formerly top-level Tokens /
 * Integraciones / Logs tabs as a `?sub=` horizontal sub-nav (SystemSection) —
 * same mounted-always/hidden invariant one level down. Old `?tab=tokens|
 * integraciones|logs` deep links redirect here (see AppDetail.tsx). Because
 * those subs run their own (polling) queries, System is lazy-mounted on first
 * open, then kept mounted so its state survives too.
 */
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '@/api'
import type { ApplyPresetResult, HwAccelMode, WebrtcLayer } from '@/api'
import { parsePresetDiff, presetResultKey } from '@/lib/presets'
import { formatDateTime, isValidTimezone, listTimezones } from '@/lib/datetime'
import { Tabs } from '@/ui'
import { PluginIcon } from '@/plugins/ui'
import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  Field,
  Loading,
  SectionTitle,
  Select,
  TextInput,
  Toggle,
  errMessage,
  isServiceUnavailable,
} from './ui'
import { RawConfigCard } from './RawConfigCard'
import { ConfigBackupsCard } from './ConfigBackupsCard'
import { TokensTab } from './TokensTab'
import { IntegracionesTab } from './IntegracionesTab'
import { LogsTab } from './LogsTab'
import { CONFIG_SECTION_ICONS, SYSTEM_SUB_ICONS } from './tabIcons'
import { DocsHint } from '@/components/DocsHint'
import { PassthroughLostWarning } from './passthrough'

/**
 * Section order: friendly/everyday controls first, advanced (raw YAML +
 * backups) last — mirrors the old layout's "structured shortcuts up top,
 * advanced stuff collapsed at the bottom" intent, just as sibling tabs now
 * instead of an always-collapsed `<details>`.
 */
const CONFIG_SECTION_IDS = [
  'presets',
  'transcoding',
  'recording',
  'timezone',
  'system',
  'raw',
  'backups',
] as const
type ConfigSectionId = (typeof CONFIG_SECTION_IDS)[number]

function isConfigSectionId(v: string | null): v is ConfigSectionId {
  return CONFIG_SECTION_IDS.some((id) => id === v)
}

/**
 * The "System" section groups the formerly top-level Tokens / Integraciones /
 * Logs tabs into a horizontal sub-nav, deep-linkable via `?sub=`. Same
 * mounted-always/hidden invariant as the outer sections: switching subs never
 * loses in-progress state (e.g. a half-filled token form).
 */
const SYSTEM_SUB_IDS = ['tokens', 'integraciones', 'logs'] as const
type SystemSubId = (typeof SYSTEM_SUB_IDS)[number]

function isSystemSubId(v: string | null): v is SystemSubId {
  return SYSTEM_SUB_IDS.some((id) => id === v)
}

export function ConfigTab({ app }: { app: string }) {
  const { t } = useTranslation('configTab')
  const [searchParams, setSearchParams] = useSearchParams()

  const sectionParam = searchParams.get('section')
  const active: ConfigSectionId = isConfigSectionId(sectionParam)
    ? sectionParam
    : 'presets'

  // Lazy-mount the System section (Tokens / Integraciones / Logs): those tabs
  // fire their own queries (and Logs polls), so we don't mount them until the
  // section is first opened. Once opened, the ref latches true and they stay
  // mounted for the life of the ConfigTab — so switching config sections (or
  // System subs) never loses their state.
  const systemSeen = useRef(false)
  if (active === 'system') systemSeen.current = true

  function selectSection(id: string) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set('section', id)
        return next
      },
      { replace: true },
    )
  }

  // Every section's own `<SectionTitle>` key doubles as its tab label — "group
  // the config sections into tabs by their existing titles".
  const sectionTitleKey: Record<ConfigSectionId, string> = {
    presets: 'presets.title',
    transcoding: 'transcoding.title',
    recording: 'recordingStorage.title',
    timezone: 'timezone.title',
    system: 'system.title',
    raw: 'raw.title',
    backups: 'backups.title',
  }

  return (
    <div className="space-y-5">
      <Tabs value={active} onChange={selectSection} variant="underline" className="text-sm">
        <Tabs.TabList>
          {CONFIG_SECTION_IDS.map((id) => (
            <Tabs.TabNav
              key={id}
              value={id}
              icon={<PluginIcon icon={CONFIG_SECTION_ICONS[id]} className="h-4 w-4" />}
            >
              {t(sectionTitleKey[id])}
            </Tabs.TabNav>
          ))}
        </Tabs.TabList>
      </Tabs>

      <div
        data-testid="config-section-presets"
        className={active === 'presets' ? '' : 'hidden'}
      >
        <PresetsCard app={app} />
      </div>
      <div
        data-testid="config-section-transcoding"
        className={active === 'transcoding' ? '' : 'hidden'}
      >
        <TranscodingCard app={app} />
      </div>
      {/* Recording naming (filename templates + variables) + VOD retention. */}
      <div
        data-testid="config-section-recording"
        className={active === 'recording' ? '' : 'hidden'}
      >
        <RecordingStorageCard app={app} />
      </div>
      <div
        data-testid="config-section-timezone"
        className={active === 'timezone' ? '' : 'hidden'}
      >
        <TimezoneCard app={app} />
      </div>
      {/* System — Tokens / Integraciones / Logs, lazily mounted on first open. */}
      <div
        data-testid="config-section-system"
        className={active === 'system' ? '' : 'hidden'}
      >
        {systemSeen.current && <SystemSection app={app} />}
      </div>
      <div
        data-testid="config-section-raw"
        className={active === 'raw' ? '' : 'hidden'}
      >
        <RawConfigCard app={app} />
      </div>
      <div
        data-testid="config-section-backups"
        className={active === 'backups' ? '' : 'hidden'}
      >
        <ConfigBackupsCard app={app} />
      </div>
    </div>
  )
}

/**
 * System section — a horizontal sub-nav (Tokens | Integraciones | Logs) over
 * `?sub=`, mirroring the outer section pattern. All three sub-surfaces stay
 * MOUNTED (only the active one is visible via a `hidden` class) so switching
 * subs never resets in-progress state — same invariant as the config sections.
 */
function SystemSection({ app }: { app: string }) {
  const { t } = useTranslation('configTab')
  const [searchParams, setSearchParams] = useSearchParams()

  const subParam = searchParams.get('sub')
  const activeSub: SystemSubId = isSystemSubId(subParam) ? subParam : 'tokens'

  function selectSub(id: string) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        // Keep the section anchored to System; only the sub changes.
        next.set('section', 'system')
        next.set('sub', id)
        return next
      },
      { replace: true },
    )
  }

  const subLabelKey: Record<SystemSubId, string> = {
    tokens: 'system.tokens',
    integraciones: 'system.integraciones',
    logs: 'system.logs',
  }

  return (
    <div className="space-y-5">
      <Tabs value={activeSub} onChange={selectSub} variant="underline" className="text-sm">
        <Tabs.TabList>
          {SYSTEM_SUB_IDS.map((id) => (
            <Tabs.TabNav
              key={id}
              value={id}
              icon={<PluginIcon icon={SYSTEM_SUB_ICONS[id]} className="h-4 w-4" />}
            >
              {t(subLabelKey[id])}
            </Tabs.TabNav>
          ))}
        </Tabs.TabList>
      </Tabs>

      <div
        data-testid="system-sub-tokens"
        className={activeSub === 'tokens' ? '' : 'hidden'}
      >
        <TokensTab app={app} />
      </div>
      <div
        data-testid="system-sub-integraciones"
        className={activeSub === 'integraciones' ? '' : 'hidden'}
      >
        <IntegracionesTab app={app} />
      </div>
      <div
        data-testid="system-sub-logs"
        className={activeSub === 'logs' ? '' : 'hidden'}
      >
        <LogsTab app={app} />
      </div>
    </div>
  )
}

/**
 * G4 fold-2 — toggle with a negative: each preset now carries `applied`
 * (GET /apps/:app/presets, computed server-side by `isPresetApplied`). An
 * applied preset shows "Applied ✓" + a "Deactivate" button instead of
 * "Apply". Apply and deactivate are two independent mutations so their
 * pending/error state never cross-talk between presets.
 */
function PresetsCard({ app }: { app: string }) {
  const { t } = useTranslation('configTab')
  const qc = useQueryClient()
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['app-presets', app],
    queryFn: ({ signal }) => api.apps.listPresets(app, signal),
    staleTime: 60_000,
  })

  // Both apply and deactivate change config.yaml the same way — refresh every
  // dependent view: the presets list itself (its `applied` flags), the
  // structured config, the raw editor, and the backups list a write just grew.
  function invalidateAfterMutate() {
    qc.invalidateQueries({ queryKey: ['app-presets', app] })
    qc.invalidateQueries({ queryKey: ['app-config', app] })
    qc.invalidateQueries({ queryKey: ['app-config-raw', app] })
    qc.invalidateQueries({ queryKey: ['app-config-backups', app] })
  }

  // Tracks which mutation produced the last SUCCESSFUL outcome, so the single
  // result panel below knows whether to render the apply or deactivate copy.
  const [lastResult, setLastResult] = useState<{
    action: 'apply' | 'deactivate'
    result: ApplyPresetResult
  } | null>(null)

  const apply = useMutation({
    mutationFn: (preset: string) => api.apps.applyPreset(app, preset),
    onSuccess: (result) => {
      setLastResult({ action: 'apply', result })
      invalidateAfterMutate()
    },
  })

  const deactivate = useMutation({
    mutationFn: (preset: string) => api.apps.deactivatePreset(app, preset),
    onSuccess: (result) => {
      setLastResult({ action: 'deactivate', result })
      invalidateAfterMutate()
    },
  })

  if (isLoading) return <Loading label={t('presets.loading')} />
  if (isError)
    return <ErrorBanner message={errMessage(error, t('presets.loadError'))} />

  const presets = data ?? []
  const stat = lastResult ? parsePresetDiff(lastResult.result.diff) : null
  // Hide a stale success panel once the SAME action has since errored (matches
  // the pre-existing single-mutation guard, extended to two mutations).
  const lastActionErrored =
    lastResult?.action === 'deactivate' ? deactivate.isError : apply.isError

  return (
    <Card>
      <SectionTitle title={t('presets.title')} subtitle={t('presets.subtitle')} />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {presets.map((p) => {
          const isApplying = apply.isPending && apply.variables === p.name
          const isDeactivating = deactivate.isPending && deactivate.variables === p.name
          return (
            <div
              key={p.name}
              className="rounded-lg border border-navy-600 bg-navy-700/40 p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-100">
                      {p.title}
                    </span>
                    <Badge tone="slate">{p.name}</Badge>
                    {p.applied && (
                      <Badge tone="green">{t('presets.appliedBadge')}</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-slate-400">{p.description}</p>
                  <p className="mt-1 text-[11px] text-slate-500">
                    <span className="text-slate-400">{t('presets.useCaseLabel')}: </span>
                    {p.useCase}
                  </p>
                </div>
                {p.applied ? (
                  <Button
                    variant="ghost"
                    disabled={isDeactivating}
                    onClick={() => {
                      if (
                        window.confirm(
                          t('presets.confirmDeactivate', { title: p.title, app }),
                        )
                      )
                        deactivate.mutate(p.name)
                    }}
                  >
                    {isDeactivating ? t('presets.deactivating') : t('presets.deactivate')}
                  </Button>
                ) : (
                  <Button
                    variant="accent"
                    disabled={isApplying}
                    onClick={() => {
                      if (window.confirm(t('presets.confirm', { title: p.title, app })))
                        apply.mutate(p.name)
                    }}
                  >
                    {isApplying ? t('presets.applying') : t('presets.apply')}
                  </Button>
                )}
              </div>

              {p.applied && (
                <p className="mt-2 text-[11px] text-slate-500">
                  {t('presets.deactivateHint')}
                </p>
              )}

              <details className="group mt-2">
                <summary className="cursor-pointer list-none text-[11px] text-slate-400 hover:text-slate-200 [&::-webkit-details-marker]:hidden">
                  {t('presets.setsLabel')} ▾
                </summary>
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[11px] text-slate-400">
                  {p.sets.map((s, i) => (
                    <li key={i} className="font-mono">
                      {s}
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          )
        })}
      </div>

      {apply.isError && (
        <div className="mt-4">
          <ErrorBanner message={errMessage(apply.error, t('presets.applyError'))} />
        </div>
      )}
      {deactivate.isError && (
        <div className="mt-4">
          <ErrorBanner
            message={errMessage(deactivate.error, t('presets.deactivateError'))}
          />
        </div>
      )}

      {lastResult && !lastActionErrored && (
        <div className="mt-4 space-y-2">
          <p className="text-xs text-success">
            {t(
              `presets.${lastResult.action === 'apply' ? 'result' : 'deactivateResult'}.${presetResultKey(lastResult.result)}`,
              { added: stat?.added ?? 0, removed: stat?.removed ?? 0 },
            )}
          </p>
          {lastResult.result.diff && (
            <div>
              <div className="mb-1 text-[11px] text-slate-400">
                {t('presets.diffLabel')}
              </div>
              <pre className="max-h-64 overflow-auto rounded-lg border border-navy-600 bg-navy-900/60 p-3 text-[11px] leading-relaxed text-slate-300">
                {lastResult.result.diff}
              </pre>
            </div>
          )}
          {lastResult.result.warnings && lastResult.result.warnings.length > 0 && (
            <div className="text-[11px] text-amber-400">
              {t('presets.warningsLabel')}: {lastResult.result.warnings.join(' · ')}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

function TranscodingCard({ app }: { app: string }) {
  const { t } = useTranslation(['configTab', 'common'])
  const qc = useQueryClient()
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['app-config', app],
    queryFn: ({ signal }) => api.apps.getConfig(app, signal),
  })

  // Server-wide GPU detection (drives the hwaccel selector + status pill).
  const gpu = useQuery({
    queryKey: ['system-gpu'],
    queryFn: ({ signal }) => api.system.gpu(signal),
    staleTime: 60_000,
  })

  const [adaptive, setAdaptive] = useState(false)
  const [rtmpTranscode, setRtmpTranscode] = useState(false)
  const [hwaccel, setHwaccel] = useState<HwAccelMode>('auto')
  const [layers, setLayers] = useState<WebrtcLayer[]>([])
  // RTMP→HLS passthrough (remux, no transcode). Mutually exclusive with
  // adaptive/transcode — the backend forces the others OFF when it goes ON.
  const [passthrough, setPassthrough] = useState(false)

  // Sync local form state once the config loads (or after a save invalidates it).
  useEffect(() => {
    if (!data) return
    setAdaptive(Boolean(data.adaptive))
    setRtmpTranscode(Boolean(data.rtmpTranscode ?? data.rtmp?.transcode))
    setHwaccel((data.hwaccel as HwAccelMode) ?? 'auto')
    setLayers(Array.isArray(data.layers) ? data.layers : [])
    setPassthrough(Boolean(data.rtmp?.passthrough))
  }, [data])

  const save = useMutation({
    mutationFn: () =>
      api.apps.updateConfig(app, {
        // Clearing the whole ladder turns adaptive delivery OFF — there are no
        // renditions left to switch between (an empty ladder + adaptive is a
        // no-op). Keeps "delete all resolutions" a coherent way to disable it.
        adaptive: layers.length > 0 ? adaptive : false,
        rtmpTranscode,
        hwaccel,
        layers,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['app-config', app] }),
  })

  // Passthrough writes on its OWN endpoint (PATCH /apps/:name { rtmpPassthrough })
  // because the backend enforces the mutual-exclusion invariant there (turning it
  // ON forces adaptive/transcode OFF and vice-versa). Toggling saves immediately.
  const savePassthrough = useMutation({
    mutationFn: (next: boolean) => api.apps.update(app, { rtmpPassthrough: next }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['app-config', app] })
      qc.invalidateQueries({ queryKey: ['app-config-raw', app] })
    },
  })

  function togglePassthrough(next: boolean) {
    // Optimistic: reflect the exclusivity in the UI at once; the refetch confirms.
    setPassthrough(next)
    if (next) {
      setAdaptive(false)
      setRtmpTranscode(false)
    }
    savePassthrough.mutate(next)
  }

  const passthroughLost = [
    t('passthrough.lost.webrtc'),
    t('passthrough.lost.abr'),
    t('passthrough.lost.h264'),
    t('passthrough.lost.recording'),
    t('passthrough.lost.room'),
  ]

  const gpuAvailable = Boolean(gpu.data?.available)

  if (isLoading) return <Loading label={t('transcoding.loading')} />
  if (isError)
    return <ErrorBanner message={errMessage(error, t('transcoding.loadError'))} />

  function updateLayer(i: number, patch: Partial<WebrtcLayer>) {
    setLayers((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }
  function removeLayer(i: number) {
    setLayers((prev) => {
      const next = prev.filter((_, idx) => idx !== i)
      // No renditions left → adaptive delivery is off (reflected in the toggle).
      if (next.length === 0) setAdaptive(false)
      return next
    })
  }
  function addLayer() {
    setLayers((prev) => [...prev, { name: '', height: 0 }])
  }

  return (
    <Card>
      <SectionTitle
        title={t('transcoding.title')}
        subtitle={t('transcoding.subtitle')}
      />

      <p className="mb-4 rounded-lg border border-navy-600 bg-navy-700/40 px-3 py-2 text-[11px] text-slate-400">
        {t('transcoding.shortcutNote')}
      </p>

      <div className="space-y-5">
        {/* Passthrough (remux) master switch — mutually exclusive with everything
            below it. Turning it ON disables the transcode/adaptive controls. */}
        <div className="rounded-lg border border-navy-600 bg-navy-700/40 px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-1.5 text-sm text-slate-100">
                {t('passthrough.label')}
                <DocsHint section="rtmpPassthrough" />
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                {t('passthrough.hint')}
              </div>
            </div>
            <Toggle
              checked={passthrough}
              onChange={togglePassthrough}
              disabled={savePassthrough.isPending}
              ariaLabel={t('passthrough.label')}
            />
          </div>
          {passthrough && (
            <div className="mt-3">
              <PassthroughLostWarning
                title={t('passthrough.warningTitle')}
                items={passthroughLost}
              />
            </div>
          )}
          <p className="mt-2 text-[11px] text-slate-500">{t('passthrough.serverNote')}</p>
          {savePassthrough.isError && (
            <div className="mt-2">
              <ErrorBanner
                message={
                  isServiceUnavailable(savePassthrough.error)
                    ? t('passthrough.disabled503')
                    : errMessage(savePassthrough.error, t('passthrough.saveError'))
                }
              />
            </div>
          )}
        </div>

        {/* Wider viewports: these two independent toggles fit side by side
            instead of eating a full-width row each. */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ToggleRow
            label={t('transcoding.adaptiveLabel')}
            hint={t('transcoding.adaptiveHint')}
            checked={adaptive}
            onChange={setAdaptive}
            disabled={passthrough}
          />
          <ToggleRow
            label={t('transcoding.rtmpTranscodeLabel')}
            hint={t('transcoding.rtmpTranscodeHint')}
            checked={rtmpTranscode}
            onChange={setRtmpTranscode}
            disabled={passthrough}
          />
        </div>

        {/* GPU / aceleración por hardware */}
        <div className="rounded-lg border border-navy-600 bg-navy-700/40 px-4 py-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm text-slate-100">{t('transcoding.gpuTitle')}</div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                {t('transcoding.gpuSubtitle')}
              </div>
            </div>
            {gpu.isLoading ? (
              <span className="text-[11px] text-slate-500">{t('transcoding.gpuDetecting')}</span>
            ) : gpu.isError ? (
              <Badge tone="amber">{t('transcoding.gpuUnknown')}</Badge>
            ) : gpuAvailable ? (
              <Badge tone="green">
                {gpu.data?.type
                  ? t('transcoding.gpuAvailableWithType', { type: gpu.data.type })
                  : t('transcoding.gpuAvailable')}
              </Badge>
            ) : (
              <Badge tone="slate">{t('transcoding.gpuUnavailable')}</Badge>
            )}
          </div>

          {!gpu.isLoading && !gpu.isError && gpuAvailable && (gpu.data?.devices?.length ?? 0) > 0 && (
            <p className="mb-3 text-[11px] text-slate-500">
              {t('transcoding.devices')}{' '}
              <span className="font-mono">
                {gpu.data!.devices!.map((d) => d.name).join(', ')}
              </span>
            </p>
          )}

          <Field
            label={t('transcoding.hwaccelLabel')}
            hint={
              gpuAvailable
                ? t('transcoding.hwaccelHintAvailable')
                : t('transcoding.hwaccelHintUnavailable')
            }
          >
            <Select
              value={hwaccel}
              disabled={passthrough}
              onChange={(e) => setHwaccel(e.target.value as HwAccelMode)}
            >
              <option value="auto">{t('transcoding.hwaccelAuto')}</option>
              <option value="gpu">{t('transcoding.hwaccelGpu')}</option>
              <option value="cpu">{t('transcoding.hwaccelCpu')}</option>
            </Select>
          </Field>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-slate-300">
              {t('transcoding.layersLabel')}
            </span>
            <Button variant="ghost" onClick={addLayer} disabled={passthrough}>
              {t('transcoding.addLayer')}
            </Button>
          </div>

          {layers.length === 0 ? (
            <p className="rounded-lg border border-navy-600 bg-navy-700/40 px-3 py-3 text-xs text-slate-500">
              {t('transcoding.noLayers')}
            </p>
          ) : (
            <div className="space-y-2">
              {layers.map((layer, i) => (
                <div
                  key={i}
                  className="flex flex-col gap-2 rounded-lg border border-navy-600 bg-navy-700/40 p-3 sm:flex-row sm:items-end sm:border-0 sm:bg-transparent sm:p-0"
                >
                  <div className="flex-1">
                    <Field label={t('transcoding.layerName')}>
                      <TextInput
                        value={layer.name}
                        placeholder="720p"
                        disabled={passthrough}
                        onChange={(e) => updateLayer(i, { name: e.target.value })}
                      />
                    </Field>
                  </div>
                  <div className="sm:w-32">
                    <Field label={t('transcoding.layerHeight')}>
                      <TextInput
                        type="number"
                        value={Number.isFinite(layer.height) ? layer.height : 0}
                        disabled={passthrough}
                        onChange={(e) =>
                          updateLayer(i, { height: Number(e.target.value) || 0 })
                        }
                      />
                    </Field>
                  </div>
                  <Button
                    variant="danger"
                    onClick={() => removeLayer(i)}
                    className="sm:mb-0.5"
                    disabled={passthrough}
                  >
                    {t('transcoding.removeLayer')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {save.isError && (
          <ErrorBanner message={errMessage(save.error, t('transcoding.saveError'))} />
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button
            variant="accent"
            disabled={save.isPending || passthrough}
            onClick={() => save.mutate()}
            title={t('transcoding.saveTooltip')}
          >
            {save.isPending ? t('common:state.saving') : t('transcoding.saveChanges')}
          </Button>
          {passthrough ? (
            <span className="text-[11px] text-amber-300">
              {t('passthrough.transcodeDisabledNote')}
            </span>
          ) : save.isSuccess && !save.isPending ? (
            <span className="text-xs text-success">{t('transcoding.saved')}</span>
          ) : (
            <span className="text-[11px] text-slate-500">{t('transcoding.saveHint')}</span>
          )}
        </div>
      </div>
    </Card>
  )
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <div
      className={`flex items-center justify-between gap-4 rounded-lg border border-navy-600 bg-navy-700/40 px-4 py-3 ${
        disabled ? 'opacity-50' : ''
      }`}
    >
      <div>
        <div className="text-sm text-slate-100">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div>}
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} ariaLabel={label} />
    </div>
  )
}

/** Allowed VOD retention windows (days). 0 = off. */
const RETENTION_OPTIONS = [0, 7, 30, 90, 180, 360] as const

/**
 * Recording naming (filename/snapshot templates) + per-app variables + VOD
 * retention. Reads the resolved config via GET /apps/:app/config; writes via
 * PATCH /apps/:name. Also surfaces a no-bucket warning (recordings need storage)
 * that links to the Integrations tab's storage section.
 */
export function RecordingStorageCard({ app }: { app: string }) {
  const { t } = useTranslation(['configTab', 'common'])
  const qc = useQueryClient()
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['app-config', app],
    queryFn: ({ signal }) => api.apps.getConfig(app, signal),
  })
  const s3 = useQuery({
    queryKey: ['app-s3', app],
    queryFn: ({ signal }) => api.apps.getS3(app, signal),
    staleTime: 30_000,
  })

  const [filenameTemplate, setFilenameTemplate] = useState('')
  const [snapshotTemplate, setSnapshotTemplate] = useState('')
  const [retentionDays, setRetentionDays] = useState(0)
  const [vars, setVars] = useState<{ key: string; value: string }[]>([])

  useEffect(() => {
    if (!data) return
    setFilenameTemplate(data.recording?.filenameTemplate ?? '')
    setSnapshotTemplate(data.recording?.snapshotTemplate ?? '')
    setRetentionDays(Number(data.recording?.retentionDays ?? 0) || 0)
    const v = data.variables ?? {}
    setVars(Object.entries(v).map(([key, value]) => ({ key, value: String(value) })))
  }, [data])

  function updateVar(i: number, patch: Partial<{ key: string; value: string }>) {
    setVars((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }
  function removeVar(i: number) {
    setVars((prev) => prev.filter((_, idx) => idx !== i))
  }
  function addVar() {
    setVars((prev) => [...prev, { key: '', value: '' }])
  }

  const save = useMutation({
    mutationFn: () => {
      // Whole-map REPLACE: collect non-empty keys (last write wins on dupes).
      const variables: Record<string, string> = {}
      for (const { key, value } of vars) {
        const k = key.trim()
        if (k) variables[k] = value
      }
      return api.apps.update(app, {
        filenameTemplate: filenameTemplate.trim(),
        snapshotTemplate: snapshotTemplate.trim(),
        retentionDays,
        variables,
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['app-config', app] })
      qc.invalidateQueries({ queryKey: ['app-config-raw', app] })
    },
  })

  if (isLoading) return <Loading label={t('recordingStorage.loading')} />
  if (isError)
    return <ErrorBanner message={errMessage(error, t('recordingStorage.loadError'))} />

  const bucket = (s3.data?.bucket ?? '').trim()
  const noBucket = s3.isSuccess && !bucket

  return (
    <Card>
      <SectionTitle
        title={t('recordingStorage.title')}
        subtitle={t('recordingStorage.subtitle')}
      />

      {noBucket && (
        <div
          data-testid="no-bucket-warning"
          className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-[12px] text-amber-300"
        >
          {t('recordingStorage.noBucket')}{' '}
          <Link
            to="?tab=config&section=system&sub=integraciones"
            className="font-semibold underline"
          >
            {t('recordingStorage.noBucketLink')}
          </Link>
        </div>
      )}

      <div className="space-y-4">
        <Field
          label={t('recordingStorage.filenameTemplate.label')}
          hint={t('recordingStorage.filenameTemplate.hint')}
        >
          <TextInput
            value={filenameTemplate}
            placeholder="${app}_${room}_${date:yyyyMMdd-HHmmss}"
            onChange={(e) => setFilenameTemplate(e.target.value)}
          />
        </Field>

        <Field
          label={t('recordingStorage.snapshotTemplate.label')}
          hint={t('recordingStorage.snapshotTemplate.hint')}
        >
          <TextInput
            value={snapshotTemplate}
            placeholder="${room}_snap_${ts}"
            onChange={(e) => setSnapshotTemplate(e.target.value)}
          />
        </Field>

        <p className="text-[11px] text-slate-500">{t('recordingStorage.tokens')}</p>

        <Field
          label={t('recordingStorage.retention.label')}
          hint={t('recordingStorage.retention.hint')}
        >
          <Select
            value={String(retentionDays)}
            onChange={(e) => setRetentionDays(Number(e.target.value) || 0)}
          >
            {RETENTION_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n === 0
                  ? t('recordingStorage.retention.off')
                  : t('recordingStorage.retention.days', { n })}
              </option>
            ))}
          </Select>
        </Field>

        <div>
          <span className="mb-1.5 block text-sm font-semibold text-gray-100">
            {t('recordingStorage.variables.label')}
          </span>
          <p className="mb-2 text-[11px] text-slate-500">
            {t('recordingStorage.variables.hint')}
          </p>
          <div className="space-y-2">
            {vars.map((row, i) => (
              <div key={i} className="flex items-center gap-2">
                <TextInput
                  value={row.key}
                  placeholder={t('recordingStorage.variables.keyPlaceholder')}
                  aria-label={t('recordingStorage.variables.keyPlaceholder')}
                  onChange={(e) => updateVar(i, { key: e.target.value })}
                />
                <TextInput
                  value={row.value}
                  placeholder={t('recordingStorage.variables.valuePlaceholder')}
                  aria-label={t('recordingStorage.variables.valuePlaceholder')}
                  onChange={(e) => updateVar(i, { value: e.target.value })}
                />
                <Button
                  variant="ghost"
                  onClick={() => removeVar(i)}
                  aria-label={t('recordingStorage.variables.remove')}
                >
                  ✕
                </Button>
              </div>
            ))}
            <Button variant="ghost" onClick={addVar}>
              {t('recordingStorage.variables.add')}
            </Button>
          </div>
        </div>
      </div>

      {save.isError && (
        <div className="mt-4">
          <ErrorBanner
            message={errMessage(save.error, t('recordingStorage.saveError'))}
          />
        </div>
      )}

      <div className="mt-4 flex items-center gap-3">
        <Button
          variant="accent"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? t('common:state.saving') : t('recordingStorage.save')}
        </Button>
        {save.isSuccess && !save.isPending && (
          <span className="text-xs text-success">{t('recordingStorage.saved')}</span>
        )}
      </div>
    </Card>
  )
}

/**
 * Owner item 11 — per-app timezone. A searchable text input backed by a
 * `<datalist>` of every IANA zone the browser knows about (no dedicated
 * combobox component exists in `ui/` yet — this is the lightest way to get
 * type-to-filter over a ~400-entry list without building one). Empty =
 * server/host local time; the same value is also the DEFAULT any
 * timezone-flavoured plugin/schedule config falls back to when its own field
 * is left empty (e.g. Scheduled-live events, or a future presence/perimeter
 * arm/disarm schedule) — see `https://streamhub.studio/docs/features/timezone`.
 */
const TIMEZONE_OPTIONS = listTimezones()

export function TimezoneCard({ app }: { app: string }) {
  const { t } = useTranslation(['configTab', 'common'])
  const qc = useQueryClient()
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['app-config', app],
    queryFn: ({ signal }) => api.apps.getConfig(app, signal),
  })

  const [timezone, setTimezone] = useState('')

  useEffect(() => {
    if (!data) return
    setTimezone(data.timezone ?? '')
  }, [data])

  const trimmed = timezone.trim()
  const invalid = trimmed !== '' && !isValidTimezone(trimmed)

  const save = useMutation({
    mutationFn: () => api.apps.update(app, { timezone: trimmed }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['app-config', app] })
      qc.invalidateQueries({ queryKey: ['app-config-raw', app] })
    },
  })

  if (isLoading) return <Loading label={t('timezone.loading')} />
  if (isError) return <ErrorBanner message={errMessage(error, t('timezone.loadError'))} />

  return (
    <Card>
      <SectionTitle title={t('timezone.title')} subtitle={t('timezone.subtitle')} />

      <div className="space-y-4">
        <Field label={t('timezone.label')} hint={t('timezone.hint')}>
          <TextInput
            list="app-timezone-options"
            value={timezone}
            placeholder={t('timezone.placeholder')}
            aria-label={t('timezone.label')}
            aria-invalid={invalid}
            onChange={(e) => setTimezone(e.target.value)}
          />
          <datalist id="app-timezone-options">
            {TIMEZONE_OPTIONS.map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
        </Field>

        {invalid && (
          <p className="text-xs text-danger">{t('timezone.invalid')}</p>
        )}

        {trimmed !== '' && !invalid && (
          <p className="text-[11px] text-slate-500">
            {t('timezone.preview', { time: formatDateTime(Date.now(), trimmed) })}
          </p>
        )}

        {trimmed === '' && (
          <p className="text-[11px] text-slate-500">{t('timezone.serverDefault')}</p>
        )}
      </div>

      {save.isError && (
        <div className="mt-4">
          <ErrorBanner message={errMessage(save.error, t('timezone.saveError'))} />
        </div>
      )}

      <div className="mt-4 flex items-center gap-3">
        <Button
          variant="ghost"
          disabled={trimmed === ''}
          onClick={() => setTimezone('')}
        >
          {t('timezone.clear')}
        </Button>
        <Button
          variant="accent"
          disabled={save.isPending || invalid}
          onClick={() => save.mutate()}
        >
          {save.isPending ? t('common:state.saving') : t('timezone.save')}
        </Button>
        {save.isSuccess && !save.isPending && (
          <span className="text-xs text-success">{t('timezone.saved')}</span>
        )}
      </div>
    </Card>
  )
}
