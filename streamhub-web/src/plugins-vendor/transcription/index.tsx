/**
 * Frontend plugin: transcription — VOD speech-to-text (Studio panel).
 *
 * Auto-discovered (src/plugins-vendor/transcription/index.tsx default-export)
 * — no central edit. Mirrors the backend manifest's config so the generic
 * settings form renders, and ships the PanelComponent the Studio page shows:
 * the app's recent VODs with their transcript status (queued / processing /
 * ready / failed / never transcribed), language, a Download SRT link and a
 * Transcribe / Re-transcribe action. It reads the core's transcript routes
 * (GET/POST /apps/:app/vods/:id/transcript|transcribe) and polls while any
 * job is in flight.
 *
 * Pure status logic lives in util.ts (node:test-covered); this file is the
 * thin React shell (fetch, poll, table).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiRequestError } from '@/api'
import { definePlugin } from '../../plugins/types.ts'
import type { PluginComponentProps } from '../../plugins/types.ts'
import { Badge, Button, Card, ErrorBanner, errMessage } from '../../plugins/ui.tsx'
import {
  canTrigger,
  hasPending,
  statusTone,
  summarize,
  toRowStatus,
  type RowStatus,
  type TranscriptRow,
} from './util.ts'

const VOD_LIMIT = 25
const POLL_MS = 5000

async function loadRow(
  app: string,
  vod: { id: number; room?: string; startedAt?: string; createdAt?: string },
  signal: AbortSignal,
): Promise<TranscriptRow> {
  const base: TranscriptRow = {
    vodId: vod.id,
    room: vod.room ?? '',
    startedAt: vod.startedAt ?? vod.createdAt ?? null,
    status: 'none',
    language: null,
    srtUrl: null,
    error: null,
  }
  try {
    const tr = await api.vods.transcript(app, vod.id, signal)
    return {
      ...base,
      status: toRowStatus(tr.status),
      language: tr.language,
      srtUrl: tr.srtUrl,
      error: tr.error,
    }
  } catch (e) {
    // 404 = never transcribed (the empty state, not an error).
    if (e instanceof ApiRequestError && e.status === 404) return base
    throw e
  }
}

function useTranscriptRows(app: string) {
  const [rows, setRows] = useState<TranscriptRow[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((n) => n + 1), [])
  const rowsRef = useRef<TranscriptRow[] | null>(null)

  useEffect(() => {
    if (!app) return
    const ctl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    ;(async () => {
      try {
        const page = await api.vods.list(app, { limit: VOD_LIMIT, order: 'started_at', dir: 'desc' }, ctl.signal)
        const next = await Promise.all(page.items.map((v) => loadRow(app, v, ctl.signal)))
        if (ctl.signal.aborted) return
        rowsRef.current = next
        setRows(next)
        setError(null)
      } catch (e) {
        if (ctl.signal.aborted) return
        setError(e)
      }
      if (rowsRef.current && hasPending(rowsRef.current)) {
        timer = setTimeout(() => setTick((n) => n + 1), POLL_MS)
      }
    })()
    return () => {
      ctl.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [app, tick])

  return { rows, error, refresh }
}

function TranscriptionPanel({ ctx }: PluginComponentProps) {
  const { t } = useTranslation(['transcription', 'vodsTab'])
  const app = ctx.app ?? ''
  const { rows, error, refresh } = useTranscriptRows(app)
  const [busy, setBusy] = useState<number | null>(null)
  const [triggerError, setTriggerError] = useState<string | null>(null)

  const trigger = useCallback(
    async (vodId: number) => {
      setBusy(vodId)
      setTriggerError(null)
      try {
        await api.vods.transcribe(app, vodId)
        refresh()
      } catch (e) {
        setTriggerError(errMessage(e, t('vodsTab:transcript.triggerError')))
      } finally {
        setBusy(null)
      }
    },
    [app, refresh, t],
  )

  const statusLabel = (s: RowStatus) =>
    s === 'none'
      ? t('transcription:status.none', { defaultValue: 'not transcribed' })
      : t(`vodsTab:transcript.status.${s}`)

  const summary = rows ? summarize(rows) : null

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-100">
          {t('transcription:title', { defaultValue: 'Recent VOD transcripts' })}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {summary &&
            (['ready', 'processing', 'queued', 'failed'] as const)
              .filter((s) => summary[s] > 0)
              .map((s) => (
                <Badge key={s} tone={statusTone(s)}>
                  {summary[s]} {statusLabel(s)}
                </Badge>
              ))}
          <Button onClick={refresh}>
            {t('transcription:refresh', { defaultValue: 'Refresh' })}
          </Button>
        </div>
      </div>

      {triggerError && (
        <div className="mb-3">
          <ErrorBanner message={triggerError} />
        </div>
      )}

      {error ? (
        <ErrorBanner message={errMessage(error, t('vodsTab:transcript.loadError'))} />
      ) : rows === null ? (
        <p className="text-sm text-gray-400">{t('vodsTab:transcript.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-400">
          {t('transcription:empty', {
            defaultValue: 'No recordings yet — transcripts appear here once the app records VODs.',
          })}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-gray-400">
              <tr>
                <th className="py-2 pr-3">VOD</th>
                <th className="py-2 pr-3">{t('transcription:col.room', { defaultValue: 'Room' })}</th>
                <th className="py-2 pr-3">{t('transcription:col.started', { defaultValue: 'Recorded' })}</th>
                <th className="py-2 pr-3">{t('transcription:col.status', { defaultValue: 'Status' })}</th>
                <th className="py-2 pr-3">{t('transcription:col.language', { defaultValue: 'Language' })}</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.vodId} className="border-t border-gray-700 align-top">
                  <td className="py-2 pr-3 font-mono">#{r.vodId}</td>
                  <td className="py-2 pr-3">{r.room || '—'}</td>
                  <td className="py-2 pr-3 text-gray-400">
                    {r.startedAt ? new Date(r.startedAt).toLocaleString() : '—'}
                  </td>
                  <td className="py-2 pr-3">
                    <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
                    {r.status === 'failed' && r.error && (
                      <div className="mt-1 max-w-xs truncate text-xs text-red-300" title={r.error}>
                        {r.error}
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3">{r.language ?? '—'}</td>
                  <td className="py-2 text-right">
                    <div className="flex justify-end gap-2">
                      {r.status === 'ready' && r.srtUrl && (
                        <a
                          className="text-xs text-primary-400 hover:underline"
                          href={r.srtUrl}
                          download={`vod-${r.vodId}.srt`}
                        >
                          {t('vodsTab:transcript.downloadSrt')}
                        </a>
                      )}
                      {canTrigger(r.status) && (
                        <Button
                          variant={r.status === 'none' ? 'accent' : 'ghost'}
                          disabled={busy === r.vodId}
                          onClick={() => void trigger(r.vodId)}
                        >
                          {busy === r.vodId
                            ? t('vodsTab:transcript.starting')
                            : r.status === 'none'
                              ? t('vodsTab:transcript.start')
                              : t('vodsTab:transcript.restart')}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

export default definePlugin({
  id: 'transcription',
  kind: 'app',
  name: 'VOD Transcription',
  description:
    'Transcribes recorded VODs to text + SRT subtitles. Local open-source Whisper by default; OpenAI API optional.',
  category: 'processor',
  ui: 'panel',
  icon: 'M3 5h18v14H3z M7 12h4 M13 12h4 M7 15h10',
  version: '1.0.1',
  configSchema: {
    fields: [
      {
        key: 'provider',
        type: 'select',
        label: 'Transcription engine',
        default: 'local',
        options: [
          { value: 'local', label: 'Local Whisper (faster-whisper, open source)' },
          { value: 'openai', label: 'OpenAI API (whisper-1 / gpt-4o-transcribe)' },
        ],
      },
      {
        key: 'model',
        type: 'select',
        label: 'Whisper model (local)',
        default: 'small',
        options: [
          { value: 'tiny', label: 'tiny (fastest, lowest quality)' },
          { value: 'base', label: 'base' },
          { value: 'small', label: 'small (good default)' },
          { value: 'medium', label: 'medium' },
          { value: 'large-v3', label: 'large-v3 (best, needs GPU/RAM)' },
        ],
      },
      {
        key: 'openaiModel',
        type: 'select',
        label: 'OpenAI model',
        default: 'whisper-1',
        options: [
          { value: 'whisper-1', label: 'whisper-1 (timed segments — best for SRT)' },
          { value: 'gpt-4o-transcribe', label: 'gpt-4o-transcribe (text only)' },
          { value: 'gpt-4o-mini-transcribe', label: 'gpt-4o-mini-transcribe (text only, cheapest)' },
        ],
      },
      { key: 'language', type: 'string', label: 'Language', default: 'auto' },
      { key: 'autoTranscribe', type: 'boolean', label: 'Transcribe new VODs automatically', default: true },
      { key: 'apiKey', type: 'secret', label: 'OpenAI API key', default: '' },
      {
        key: 'device',
        type: 'select',
        label: 'Compute device (local)',
        default: 'auto',
        options: [
          { value: 'auto', label: 'Auto (CUDA if available, else CPU)' },
          { value: 'cpu', label: 'CPU' },
          { value: 'cuda', label: 'CUDA (GPU)' },
        ],
      },
    ],
  },
  PanelComponent: TranscriptionPanel,
})
