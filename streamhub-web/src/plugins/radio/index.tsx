/**
 * Radio plugin (frontend) — surfaces the WebRTC radio console as an APP TAB.
 *
 * Auto-discovered by src/plugins/discovery.ts (this file lives at
 * src/plugins/radio/index.tsx and default-exports a PluginModule). When the
 * plugin is installed + active, AppDetail's <PluginSlot placement="app-tab">
 * mounts <RadioTab> as a section INSIDE the app — replacing the old loose
 * "Radio" header button.
 *
 * The console is the same logic as the standalone /radio/:app/:room page:
 * useRadioMaster (mic → WebRTC publish), a subscribe-only listener monitor
 * (LivePlayer audioOnly), a copyable listener link / iframe embed, and an
 * on-demand subscribe-only listen token. Room comes from plugin config.
 */
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'
import { api } from '@/api'
import { Button } from '@/ui'
import { LivePlayer } from '@/components/player'
import {
  Banner,
  DeviceSelect,
  Duration,
  Field,
  PhaseBadge,
} from '@/pages/Broadcast/ui'
import { useRadioMaster } from '@/pages/Radio/useRadioMaster'
import { definePlugin } from '../types.ts'
import type { PluginComponentProps } from '../types.ts'
import { buildEmbed, buildListenerUrl, resolveRoom } from './logic.ts'

/** A read-only value + copy button (mirrors the standalone Radio page). */
function CopyRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const { t } = useTranslation('common')
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard?.writeText(value).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div>
      <span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{label}</span>
      <div className="flex items-center gap-2">
        <input
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className={`w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-700 px-3 py-2 text-sm text-fg ${
            mono ? 'font-mono text-xs' : ''
          }`}
        />
        <Button variant="default" size="sm" onClick={copy} className="shrink-0">
          {copied ? t('actions.copied') : t('actions.copy')}
        </Button>
      </div>
    </div>
  )
}

function RadioTab({ ctx }: PluginComponentProps) {
  const { t } = useTranslation('radio')
  const app = ctx.app ?? ''
  const room = resolveRoom(ctx.config)
  const autoMonitor = ctx.config?.autoStartMonitor !== false

  const { state, start, stop, selectMic, clearError } = useRadioMaster(app, room)
  const [showMonitor, setShowMonitor] = useState(autoMonitor)
  const listenToken = useMutation({
    mutationFn: () => api.apps.radioListenToken(app, room),
  })

  if (!app) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800 p-6 text-center">
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('invalid.message')}</p>
      </div>
    )
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const listenerUrl = buildListenerUrl(origin, app, room)
  const embed = buildEmbed(listenerUrl)

  const isLive = state.phase === 'live'
  const isBusy = state.phase === 'connecting' || state.phase === 'stopping'

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      {/* Máster + monitor */}
      <section className="flex flex-col gap-5">
        <div className="rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800 p-4 sm:p-5">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-fg">{t('master.title')}</h2>
              <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
                {t('header.title', { room })}
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 dark:bg-gray-700 px-3 py-1 text-xs font-medium text-gray-700 dark:text-gray-200 ring-1 ring-gray-200 dark:ring-gray-700">
              <span className={`h-1.5 w-1.5 rounded-full ${isLive ? 'animate-pulse bg-primary-500' : 'bg-gray-300 dark:bg-gray-600'}`} />
              {t('master.listeners', { count: state.listeners })}
            </span>
          </div>

          {state.error && (
            <div className="mt-4">
              <Banner tone="error" onClose={clearError}>
                {state.error}
              </Banner>
            </div>
          )}

          <div className="mt-4 space-y-4">
            <Field label={t('master.micLabel')}>
              <DeviceSelect
                devices={state.mics}
                value={state.micId}
                onChange={selectMic}
                disabled={isLive || isBusy}
                emptyLabel={t('master.micEmpty')}
              />
            </Field>

            <div className="flex items-center gap-3">
              {!isLive ? (
                <Button
                  variant="solid"
                  block
                  className="flex-1"
                  onClick={start}
                  disabled={isBusy || state.permission === 'denied'}
                >
                  {state.phase === 'connecting' ? t('master.goingLive') : t('master.goLive')}
                </Button>
              ) : (
                <Button
                  variant="solid"
                  color="red-500"
                  block
                  className="flex-1"
                  onClick={stop}
                  disabled={state.phase === 'stopping'}
                >
                  {state.phase === 'stopping' ? t('master.goingOff') : t('master.goOff')}
                </Button>
              )}
              {state.startedAt && (
                <span className="rounded-md bg-gray-100 dark:bg-gray-700 px-2 py-1 text-xs text-gray-600 dark:text-gray-300">
                  <Duration since={state.startedAt} />
                </span>
              )}
              <PhaseBadge phase={state.phase} />
            </div>
            {state.permission === 'denied' && (
              <p className="text-center text-[11px] text-amber-600 dark:text-amber-400">
                {t('master.permissionDenied')}
              </p>
            )}
          </div>
          <p className="mt-4 text-[11px] leading-snug text-gray-500 dark:text-gray-400">
            <Trans i18nKey="radio:master.note" components={{ strong: <strong /> }} />
          </p>
        </div>

        {/* Listener monitor — counts as one oyente while abierto. */}
        <div className="rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800 p-4 sm:p-5">
          <h2 className="mb-3 text-sm font-semibold text-fg">{t('monitor.title')}</h2>
          {showMonitor ? (
            <>
              <LivePlayer
                app={app}
                room={room}
                audioOnly
                audioLabel={t('monitor.audioLabel', { room })}
                addons={{ viewers: true }}
              />
              <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">{t('monitor.note')}</p>
            </>
          ) : (
            <Button variant="default" block onClick={() => setShowMonitor(true)}>
              {t('monitor.title')}
            </Button>
          )}
        </div>
      </section>

      {/* Share / embed / token */}
      <aside className="flex flex-col gap-4">
        <div className="rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800 p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-fg">{t('share.title')}</h2>
          <div className="mt-4 space-y-4">
            <CopyRow label={t('share.listenerLink')} value={listenerUrl} mono={false} />
            <CopyRow label={t('share.embed')} value={embed} />
            <p className="text-[11px] leading-snug text-gray-500 dark:text-gray-400">
              <Trans i18nKey="radio:share.note" components={{ strong: <strong /> }} />
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800 p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-fg">{t('token.title')}</h2>
          <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
            <Trans i18nKey="radio:token.subtitle" components={{ strong: <strong /> }} />
          </p>
          <Button
            variant="default"
            block
            className="mt-3"
            onClick={() => listenToken.mutate()}
            disabled={listenToken.isPending}
          >
            {listenToken.isPending ? t('token.generating') : t('token.generate')}
          </Button>
          {listenToken.isError && (
            <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">{t('token.error')}</p>
          )}
          {listenToken.data && (
            <div className="mt-3 space-y-3">
              <CopyRow label={t('token.jwt')} value={listenToken.data.token} />
              <CopyRow label={t('token.wsUrl')} value={listenToken.data.wsUrl} />
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}

export default definePlugin({
  id: 'radio',
  name: 'Radio',
  description:
    'Audio-only WebRTC radio inside the app: go on air, watch listeners and ' +
    'hand out subscribe-only listen tokens.',
  category: 'engagement',
  ui: 'app-tab',
  version: '1.0.0',
  icon: 'M3.5 12a8.5 8.5 0 0117 0M7 12a4.5 4.5 0 019 0M12 12v6m0 0h-2m2 0h2',
  configSchema: {
    fields: [
      {
        key: 'room',
        type: 'string',
        label: 'Room name',
        default: 'radio',
        placeholder: 'radio',
        description: 'LiveKit room the master publishes to and listeners join.',
      },
      {
        key: 'listenTokenTtlSeconds',
        type: 'number',
        label: 'Listen token TTL (seconds)',
        default: 3600,
        min: 60,
        max: 86400,
      },
      {
        key: 'autoStartMonitor',
        type: 'boolean',
        label: 'Auto-start listener monitor',
        default: true,
      },
    ],
  },
  TabComponent: RadioTab,
})
