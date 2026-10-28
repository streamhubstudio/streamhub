/**
 * Live Control — the OPERATOR console (app-tab, kind:'app').
 *
 * Pause / resume / finish an already-live stream and manage the cover assets
 * (images / looping videos) that viewers see while paused/finished. Everything
 * here is API-first: it drives /apps/:app/plugins/live-control/* (streams,
 * assets, settings) — the exact endpoints documented in the API reference.
 *
 * The viewer-facing cover is a SEPARATE player-overlay plugin
 * (`live-control-overlay`); the banner reminds the operator to enable it. Pure
 * shaping lives in logic.ts (node:test); this file is the React shell.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { definePlugin } from '../types.ts'
import type { PluginComponentProps } from '../types.ts'
import {
  Badge,
  Button,
  ErrorBanner,
  Field,
  Select,
  Textarea,
  TextInput,
  Toggle,
  errMessage,
} from '../ui.tsx'
import * as api from './api.ts'
import {
  assetsForMode,
  coverSummary,
  editorToOverride,
  formatBytes,
  initialEditor,
  stateTone,
  type ControlOp,
  type EditorState,
} from './logic.ts'

const PAUSE_ICON = 'M10 9v6m4-6v6M4 5h16v14H4z'

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

function useStreams(app: string, pollMs: number) {
  const [streams, setStreams] = useState<api.StreamListItem[]>([])
  const [error, setError] = useState(false)
  const tick = useRef<() => void>(() => {})

  useEffect(() => {
    if (!app) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = async () => {
      try {
        const res = await api.listStreams(app)
        if (!alive) return
        setStreams(res.streams)
        setError(false)
      } catch {
        if (alive) setError(true)
      }
      timer = setTimeout(run, Math.max(2000, pollMs))
    }
    tick.current = () => {
      if (timer !== undefined) clearTimeout(timer)
      void run()
    }
    void run()
    return () => {
      alive = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [app, pollMs])

  return { streams, error, refetch: () => tick.current() }
}

// ---------------------------------------------------------------------------
// Cover editor (shown before applying pause/finish)
// ---------------------------------------------------------------------------

interface EditorProps {
  op: ControlOp
  values: EditorState
  assets: api.CoverAsset[]
  busy: boolean
  onChange: (v: EditorState) => void
  onConfirm: () => void
  onCancel: () => void
}

function CoverEditor({ op, values, assets, busy, onChange, onConfirm, onCancel }: EditorProps) {
  const { t } = useTranslation('liveControlPlugin')
  const set = <K extends keyof EditorState>(k: K, v: EditorState[K]) => onChange({ ...values, [k]: v })
  const modeAssets = assetsForMode(assets, values.mode)

  return (
    <div className="mt-3 space-y-3 rounded-lg border p-3 border-gray-700 bg-gray-800/50">
      <Field label={t('editor.mode')}>
        <Select value={values.mode} onChange={(e) => set('mode', e.target.value as EditorState['mode'])}>
          <option value="text">{t('mode.text')}</option>
          <option value="image">{t('mode.image')}</option>
          <option value="video">{t('mode.video')}</option>
        </Select>
      </Field>

      {values.mode === 'text' ? (
        <>
          <Field label={t('editor.cardTitle')}>
            <TextInput value={values.cardTitle} onChange={(e) => set('cardTitle', e.target.value)} />
          </Field>
          <Field label={t('editor.cardText')}>
            <Textarea rows={2} value={values.cardText} onChange={(e) => set('cardText', e.target.value)} />
          </Field>
          <Field label={t('editor.cardColor')}>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={values.cardColor}
                onChange={(e) => set('cardColor', e.target.value)}
                className="h-9 w-12 cursor-pointer rounded border bg-transparent border-gray-600"
                aria-label={t('editor.cardColor')}
              />
              <TextInput value={values.cardColor} onChange={(e) => set('cardColor', e.target.value)} />
            </div>
          </Field>
        </>
      ) : (
        <Field label={t('editor.asset')} hint={modeAssets.length === 0 ? t('editor.noAssets') : undefined}>
          <Select
            value={values.assetId === null ? '' : String(values.assetId)}
            onChange={(e) => set('assetId', e.target.value === '' ? null : Number(e.target.value))}
          >
            <option value="">{t('editor.pickAsset')}</option>
            {modeAssets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label || a.filename}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <div className="flex items-center gap-2">
        <Button variant="accent" onClick={onConfirm} disabled={busy}>
          {op === 'finish' ? t('actions.confirmFinish') : t('actions.confirmPause')}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          {t('actions.cancel')}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stream row
// ---------------------------------------------------------------------------

function StreamRow({
  item,
  assets,
  editing,
  editor,
  busy,
  onOpen,
  onResume,
  onEditorChange,
  onConfirm,
  onCancel,
}: {
  item: api.StreamListItem
  assets: api.CoverAsset[]
  editing: ControlOp | null
  editor: EditorState
  busy: boolean
  onOpen: (op: ControlOp) => void
  onResume: () => void
  onEditorChange: (v: EditorState) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation('liveControlPlugin')
  const state = item.control.state
  const summary = coverSummary(item)

  return (
    <li className="rounded-lg border p-3 border-gray-700">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Badge tone={stateTone(state)}>{t(`state.${state}`)}</Badge>
            <span className="truncate font-semibold text-gray-100">{item.streamId}</span>
          </div>
          <div className="mt-0.5 text-xs text-gray-400">
            {item.room}
            {typeof item.viewers === 'number' ? ` · ${t('row.viewers', { count: item.viewers })}` : ''}
            {summary ? ` · ${t('row.showing', { summary })}` : ''}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {state !== 'live' && (
            <Button variant="accent" onClick={onResume} disabled={busy}>
              {t('actions.resume')}
            </Button>
          )}
          <Button onClick={() => onOpen('pause')} disabled={busy}>
            {t('actions.pause')}
          </Button>
          <Button variant="danger" onClick={() => onOpen('finish')} disabled={busy}>
            {t('actions.finish')}
          </Button>
        </div>
      </div>
      {editing && (
        <CoverEditor
          op={editing}
          values={editor}
          assets={assets}
          busy={busy}
          onChange={onEditorChange}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      )}
    </li>
  )
}

// ---------------------------------------------------------------------------
// Asset manager
// ---------------------------------------------------------------------------

function AssetManager({
  app,
  assets,
  settings,
  busy,
  onChanged,
  onError,
}: {
  app: string
  assets: api.CoverAsset[]
  settings: api.LiveControlSettings | null
  busy: boolean
  onChanged: () => void
  onError: (msg: string) => void
}) {
  const { t } = useTranslation('liveControlPlugin')
  const [label, setLabel] = useState('')
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    onError('')
    try {
      await api.uploadAsset(app, file, label)
      setLabel('')
      if (fileRef.current) fileRef.current.value = ''
      onChanged()
    } catch (err) {
      const body = (err as { body?: { error?: string } })?.body
      onError(body?.error === 'storage_not_configured' ? t('assets.noStorage') : errMessage(err, t('assets.uploadError')))
    } finally {
      setUploading(false)
    }
  }

  async function onDelete(a: api.CoverAsset) {
    if (!window.confirm(t('assets.confirmDelete', { name: a.label || a.filename }))) return
    try {
      await api.deleteAsset(app, a.id)
      onChanged()
    } catch (err) {
      onError(errMessage(err, t('assets.deleteError')))
    }
  }

  async function setDefault(phase: 'pause' | 'finish', id: number | null) {
    try {
      await api.updateSettings(app, phase === 'pause' ? { defaultPauseAssetId: id } : { defaultFinishAssetId: id })
      onChanged()
    } catch (err) {
      onError(errMessage(err, t('assets.settingsError')))
    }
  }

  return (
    <section className="space-y-3 border-t pt-5 border-gray-700">
      <h4 className="text-sm font-semibold text-gray-100">{t('assets.title')}</h4>

      <div className="flex flex-wrap items-end gap-2 rounded-lg p-3 bg-gray-800/50">
        <Field label={t('assets.label')}>
          <TextInput value={label} placeholder={t('assets.labelPlaceholder')} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <label className="inline-flex">
          <input
            ref={fileRef}
            type="file"
            accept="image/*,video/*"
            className="hidden"
            onChange={(e) => void onPick(e)}
            data-testid="asset-file"
          />
          <span
            className={`inline-flex cursor-pointer items-center rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white ${
              uploading ? 'opacity-60' : ''
            }`}
          >
            {uploading ? t('assets.uploading') : t('assets.upload')}
          </span>
        </label>
      </div>

      {assets.length === 0 ? (
        <p className="text-sm text-gray-400">{t('assets.empty')}</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {assets.map((a) => (
            <li key={a.id} className="flex gap-3 rounded-lg border p-2 border-gray-700">
              <div className="h-16 w-24 shrink-0 overflow-hidden rounded bg-black/80">
                {a.url && a.kind === 'image' ? (
                  <img src={a.url} alt={a.label || a.filename} className="h-full w-full object-cover" />
                ) : a.url && a.kind === 'video' ? (
                  <video src={a.url} className="h-full w-full object-cover" muted />
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-gray-100">
                  {a.label || a.filename}
                </div>
                <div className="text-xs text-gray-400">
                  {t(`mode.${a.kind}`)} · {formatBytes(a.sizeBytes)}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1 text-xs text-gray-300">
                    <Toggle
                      checked={settings?.defaultPauseAssetId === a.id}
                      onChange={(v) => void setDefault('pause', v ? a.id : null)}
                    />
                    {t('assets.defaultPause')}
                  </label>
                  <label className="flex items-center gap-1 text-xs text-gray-300">
                    <Toggle
                      checked={settings?.defaultFinishAssetId === a.id}
                      onChange={(v) => void setDefault('finish', v ? a.id : null)}
                    />
                    {t('assets.defaultFinish')}
                  </label>
                  <Button variant="danger" onClick={() => void onDelete(a)} disabled={busy}>
                    {t('assets.delete')}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

function LiveControlConsole({ ctx }: PluginComponentProps) {
  const { t } = useTranslation('liveControlPlugin')
  const app = ctx.app ?? ''
  const [settings, setSettings] = useState<api.LiveControlSettings | null>(null)
  const [assets, setAssets] = useState<api.CoverAsset[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [edit, setEdit] = useState<{ streamId: string; op: ControlOp; values: EditorState } | null>(null)

  const pollMs = (settings?.pollSeconds ?? 4) * 1000
  const { streams, error: streamsError, refetch } = useStreams(app, pollMs)

  const loadMeta = useCallback(async () => {
    if (!app) return
    try {
      const [s, a] = await Promise.all([api.getSettings(app), api.listAssets(app)])
      setSettings(s)
      setAssets(a)
    } catch (err) {
      setError(errMessage(err, t('loadError')))
    }
  }, [app, t])

  useEffect(() => {
    void loadMeta()
  }, [loadMeta])

  const openEditor = (streamId: string, op: ControlOp) =>
    setEdit({ streamId, op, values: initialEditor(op, settings) })

  async function onResume(streamId: string) {
    setBusy(true)
    setError('')
    try {
      await api.resumeStream(app, streamId)
      refetch()
    } catch (err) {
      setError(errMessage(err, t('actionError')))
    } finally {
      setBusy(false)
    }
  }

  async function onConfirm() {
    if (!edit) return
    setBusy(true)
    setError('')
    try {
      const body = editorToOverride(edit.values)
      if (edit.op === 'finish') await api.finishStream(app, edit.streamId, body)
      else await api.pauseStream(app, edit.streamId, body)
      setEdit(null)
      refetch()
    } catch (err) {
      setError(errMessage(err, t('actionError')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <p className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-300">
        {t('overlayHint')}
      </p>

      {(error || streamsError) && (
        <ErrorBanner message={error || t('streamsError')} />
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-gray-100">{t('streams.title')}</h4>
          <Button variant="ghost" onClick={refetch} disabled={busy}>
            {t('streams.refresh')}
          </Button>
        </div>
        {streams.length === 0 ? (
          <p className="text-sm text-gray-400">{t('streams.empty')}</p>
        ) : (
          <ul className="space-y-2">
            {streams.map((item) => (
              <StreamRow
                key={item.streamId}
                item={item}
                assets={assets}
                editing={edit?.streamId === item.streamId ? edit.op : null}
                editor={edit?.streamId === item.streamId ? edit.values : initialEditor('pause', settings)}
                busy={busy}
                onOpen={(op) => openEditor(item.streamId, op)}
                onResume={() => void onResume(item.streamId)}
                onEditorChange={(values) => setEdit((e) => (e ? { ...e, values } : e))}
                onConfirm={() => void onConfirm()}
                onCancel={() => setEdit(null)}
              />
            ))}
          </ul>
        )}
      </section>

      <AssetManager
        app={app}
        assets={assets}
        settings={settings}
        busy={busy}
        onChanged={() => void loadMeta()}
        onError={setError}
      />
    </div>
  )
}

export default definePlugin({
  id: 'live-control',
  name: 'Live Control',
  description:
    'Pause, resume or finish an already-live stream: viewers see a configured ' +
    'cover (image, looping video or text card) with audio muted until you resume.',
  category: 'tool',
  kind: 'app',
  icon: PAUSE_ICON,
  version: '1.0.0',
  ui: 'app-tab',
  configSchema: {
    fields: [
      {
        key: 'defaultMode',
        type: 'select',
        label: 'Default cover mode',
        default: 'text',
        options: [
          { value: 'image', label: 'Image' },
          { value: 'video', label: 'Looping video' },
          { value: 'text', label: 'Text card' },
        ],
      },
      { key: 'defaultCardTitle', type: 'string', label: 'Text-card headline', default: 'We will be right back' },
      { key: 'defaultCardText', type: 'string', label: 'Text-card body', default: 'The live stream is paused.' },
      { key: 'defaultCardColor', type: 'string', label: 'Text-card background', default: '#0b0b0f' },
      { key: 'muteAudioServerSide', type: 'boolean', label: 'Mute audio server-side while paused', default: true },
      { key: 'pollSeconds', type: 'number', label: 'Overlay poll interval (seconds)', default: 5, min: 2, max: 60 },
    ],
  },
  TabComponent: LiveControlConsole,
})
