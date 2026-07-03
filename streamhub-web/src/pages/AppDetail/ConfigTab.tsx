/**
 * Config tab — GET/PATCH /apps/:app/config (transcoding / adaptive ladder).
 * Edits adaptive delivery, RTMP transcode and the rendition layers.
 * Feature flags and callbacks live on the Integraciones tab (same endpoint).
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/api'
import type { HwAccelMode, WebrtcLayer } from '@/api'
import { parsePresetDiff, presetResultKey } from '@/lib/presets'
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
} from './ui'
import { RawConfigCard } from './RawConfigCard'
import { ConfigBackupsCard } from './ConfigBackupsCard'

export function ConfigTab({ app }: { app: string }) {
  const { t } = useTranslation('configTab')
  return (
    <div className="space-y-5">
      {/* One-click delivery/quality profiles. */}
      <PresetsCard app={app} />

      {/* Friendly structured controls first — the everyday path. */}
      <TranscodingCard app={app} />

      {/* Advanced: the raw config.yaml (source of truth) + its backups. Collapsed
          by default so the structured shortcuts above stay front-and-centre. */}
      <details className="group rounded-xl border border-navy-600 bg-navy-800/30">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-5 py-4 text-sm font-semibold text-slate-100 [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-2">
            <svg
              className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-90"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            <span>
              {t('advanced.summary')}
              <span className="mt-0.5 block text-[11px] font-normal text-slate-500">
                {t('advanced.hint')}
              </span>
            </span>
          </span>
        </summary>
        <div className="space-y-5 px-5 pb-5 pt-1">
          <RawConfigCard app={app} />
          <ConfigBackupsCard app={app} />
        </div>
      </details>
    </div>
  )
}

function PresetsCard({ app }: { app: string }) {
  const { t } = useTranslation('configTab')
  const qc = useQueryClient()
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['app-presets', app],
    queryFn: ({ signal }) => api.apps.listPresets(app, signal),
    staleTime: 60_000,
  })

  const apply = useMutation({
    mutationFn: (preset: string) => api.apps.applyPreset(app, preset),
    onSuccess: () => {
      // The config.yaml + resolved config changed — refresh the dependent views
      // (structured config, raw editor, and the backups list a preset just grew).
      qc.invalidateQueries({ queryKey: ['app-config', app] })
      qc.invalidateQueries({ queryKey: ['app-config-raw', app] })
      qc.invalidateQueries({ queryKey: ['app-config-backups', app] })
    },
  })

  if (isLoading) return <Loading label={t('presets.loading')} />
  if (isError)
    return <ErrorBanner message={errMessage(error, t('presets.loadError'))} />

  const presets = data ?? []
  const result = apply.data
  const stat = result ? parsePresetDiff(result.diff) : null

  return (
    <Card>
      <SectionTitle title={t('presets.title')} subtitle={t('presets.subtitle')} />

      <div className="space-y-3">
        {presets.map((p) => (
          <div
            key={p.name}
            className="rounded-lg border border-navy-600 bg-navy-700/40 p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-100">
                    {p.title}
                  </span>
                  <Badge tone="slate">{p.name}</Badge>
                </div>
                <p className="mt-1 text-[11px] text-slate-400">{p.description}</p>
                <p className="mt-1 text-[11px] text-slate-500">
                  <span className="text-slate-400">{t('presets.useCaseLabel')}: </span>
                  {p.useCase}
                </p>
              </div>
              <Button
                variant="accent"
                disabled={apply.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      t('presets.confirm', { title: p.title, app }),
                    )
                  )
                    apply.mutate(p.name)
                }}
              >
                {apply.isPending && apply.variables === p.name
                  ? t('presets.applying')
                  : t('presets.apply')}
              </Button>
            </div>

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
        ))}
      </div>

      {apply.isError && (
        <div className="mt-4">
          <ErrorBanner message={errMessage(apply.error, t('presets.applyError'))} />
        </div>
      )}

      {result && !apply.isError && (
        <div className="mt-4 space-y-2">
          <p className="text-xs text-success">
            {t(`presets.result.${presetResultKey(result)}`, {
              added: stat?.added ?? 0,
              removed: stat?.removed ?? 0,
            })}
          </p>
          {result.diff && (
            <div>
              <div className="mb-1 text-[11px] text-slate-400">
                {t('presets.diffLabel')}
              </div>
              <pre className="max-h-64 overflow-auto rounded-lg border border-navy-600 bg-navy-900/60 p-3 text-[11px] leading-relaxed text-slate-300">
                {result.diff}
              </pre>
            </div>
          )}
          {result.warnings && result.warnings.length > 0 && (
            <div className="text-[11px] text-amber-400">
              {t('presets.warningsLabel')}: {result.warnings.join(' · ')}
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

  // Sync local form state once the config loads (or after a save invalidates it).
  useEffect(() => {
    if (!data) return
    setAdaptive(Boolean(data.adaptive))
    setRtmpTranscode(Boolean(data.rtmpTranscode))
    setHwaccel((data.hwaccel as HwAccelMode) ?? 'auto')
    setLayers(Array.isArray(data.layers) ? data.layers : [])
  }, [data])

  const save = useMutation({
    mutationFn: () =>
      api.apps.updateConfig(app, {
        adaptive,
        rtmpTranscode,
        hwaccel,
        layers,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['app-config', app] }),
  })

  const gpuAvailable = Boolean(gpu.data?.available)

  if (isLoading) return <Loading label={t('transcoding.loading')} />
  if (isError)
    return <ErrorBanner message={errMessage(error, t('transcoding.loadError'))} />

  function updateLayer(i: number, patch: Partial<WebrtcLayer>) {
    setLayers((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }
  function removeLayer(i: number) {
    setLayers((prev) => prev.filter((_, idx) => idx !== i))
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
        <ToggleRow
          label={t('transcoding.adaptiveLabel')}
          hint={t('transcoding.adaptiveHint')}
          checked={adaptive}
          onChange={setAdaptive}
        />
        <ToggleRow
          label={t('transcoding.rtmpTranscodeLabel')}
          hint={t('transcoding.rtmpTranscodeHint')}
          checked={rtmpTranscode}
          onChange={setRtmpTranscode}
        />

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
            <Button variant="ghost" onClick={addLayer}>
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
                        onChange={(e) => updateLayer(i, { name: e.target.value })}
                      />
                    </Field>
                  </div>
                  <div className="sm:w-32">
                    <Field label={t('transcoding.layerHeight')}>
                      <TextInput
                        type="number"
                        value={Number.isFinite(layer.height) ? layer.height : 0}
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
            disabled={save.isPending}
            onClick={() => save.mutate()}
            title={t('transcoding.saveTooltip')}
          >
            {save.isPending ? t('common:state.saving') : t('transcoding.saveChanges')}
          </Button>
          {save.isSuccess && !save.isPending ? (
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
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-navy-600 bg-navy-700/40 px-4 py-3">
      <div>
        <div className="text-sm text-slate-100">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div>}
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  )
}
