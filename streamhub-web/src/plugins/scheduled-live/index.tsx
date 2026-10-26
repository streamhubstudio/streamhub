/**
 * Scheduled Live — a PLAYER-OVERLAY plugin that schedules live "premieres".
 *
 * Two surfaces:
 *   - OverlayComponent: on the /play + /embed players it reads the app's PUBLIC
 *     agenda (no auth) and, until each event's absolute start instant, draws a
 *     full-cover countdown ("El vivo comienza en …"); at the start it animates
 *     the cover away to reveal the (already-publishing) stream. It NEVER pauses
 *     the media — it only optionally mutes while covering.
 *   - ConfigComponent: opened from the Plugins tab "Configure", it manages the
 *     agenda (CRUD via the scheduled-live API) plus the display options.
 *
 * All countdown / reveal / timezone math is in the PURE overlay.util.ts (covered
 * by node:test); this file is the thin React shell (clock, poll, DOM, forms).
 *
 * REAL-TIME PUSH: when the overlay is mounted inside a LiveKit room context
 * (the WebRTC players), it also subscribes to the `scheduled-live` data topic —
 * the core pushes `agenda-updated` on every agenda mutation and the overlay
 * refetches instantly. The 30 s poll stays as the fallback transport (and the
 * only one on HLS/MJPEG players, which have no LiveKit connection).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDataChannel, useMaybeRoomContext } from '@livekit/components-react'
import { definePlugin } from '../types.ts'
import type { PluginComponentProps, PluginConfigProps } from '../types.ts'
import { Button, ErrorBanner, Field, Select, TextInput, Toggle, errMessage } from '../ui.tsx'
import {
  createEvent,
  deleteEvent,
  listEvents,
  listPublicEvents,
  updateEvent,
} from './api.ts'
import {
  COMMON_TIMEZONES,
  SCHEDULED_LIVE_TOPIC,
  computePhase,
  formatOffsetLabel,
  formatRemaining,
  isAgendaPush,
  pad2,
  resolveSettings,
  utcMsToZonedParts,
  zonedWallTimeToUtcMs,
  type Remaining,
  type ScheduledEvent,
  type WallTime,
} from './overlay.util.ts'

const CLOCK_ICON = 'M12 8v4l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z'

// ---------------------------------------------------------------------------
// Overlay: clock + public agenda poll → phase machine
// ---------------------------------------------------------------------------

/** A 1 Hz clock returning `Date.now()` each second. */
function useNowMs(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

/**
 * Poll the PUBLIC agenda on mount and every 30s so new events appear. The
 * returned `refresh()` restarts the loop with an immediate fetch — the
 * real-time data-channel push calls it so agenda changes land instantly while
 * the poll stays as the fallback transport.
 */
function usePublicAgenda(
  app: string | undefined,
  room: string | undefined,
): { events: ScheduledEvent[]; refresh: () => void } {
  const [events, setEvents] = useState<ScheduledEvent[]>([])
  const [refreshKey, setRefreshKey] = useState(0)
  useEffect(() => {
    if (!app) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const rows = await listPublicEvents(app, room)
        if (alive) setEvents(rows)
      } catch {
        /* network hiccup — keep the last agenda */
      }
      timer = setTimeout(tick, 30_000)
    }
    void tick()
    return () => {
      alive = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [app, room, refreshKey])
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), [])
  return { events, refresh }
}

/**
 * Real-time agenda push bridge: subscribes to the `scheduled-live` LiveKit
 * data topic (the core pushes `agenda-updated` on every agenda mutation) and
 * triggers an immediate agenda refetch. Must be mounted INSIDE a LiveKit room
 * context — the overlay only renders it when one exists, so HLS/MJPEG players
 * transparently stay poll-only.
 */
function AgendaPushBridge({ onAgendaUpdate }: { onAgendaUpdate: () => void }) {
  useDataChannel(SCHEDULED_LIVE_TOPIC, (msg) => {
    if (isAgendaPush(msg.payload)) onAgendaUpdate()
  })
  return null
}

/** The nearest media elements inside the player frame (the positioned ancestor). */
function findMedia(root: HTMLElement | null): HTMLMediaElement[] {
  if (!root) return []
  const frame = (root.offsetParent as HTMLElement | null) ?? root.parentElement ?? root
  return Array.from(frame.querySelectorAll('video, audio')) as HTMLMediaElement[]
}

/**
 * Mute the player's media while the cover is up, restoring the previous muted
 * state when the cover reveals or the overlay unmounts. NEVER pauses (it's live).
 */
function useMuteWhileCovering(
  rootRef: React.RefObject<HTMLDivElement | null>,
  active: boolean,
): void {
  const mutedRef = useRef<{ el: HTMLMediaElement; prev: boolean }[]>([])
  useEffect(() => {
    if (!active) return
    const saved = findMedia(rootRef.current).map((el) => ({ el, prev: el.muted }))
    for (const { el } of saved) el.muted = true
    mutedRef.current = saved
    return () => {
      for (const { el, prev } of mutedRef.current) {
        try {
          el.muted = prev
        } catch {
          /* element gone — nothing to restore */
        }
      }
      mutedRef.current = []
    }
  }, [active, rootRef])
}

function CountdownRow({ remaining, labels }: { remaining: Remaining; labels: Record<string, string> }) {
  const cells: [number, string][] = []
  if (remaining.days > 0) cells.push([remaining.days, labels.days])
  cells.push([remaining.hours, labels.hours])
  cells.push([remaining.minutes, labels.minutes])
  cells.push([remaining.seconds, labels.seconds])
  return (
    <div className="flex items-end gap-2 sm:gap-3 tabular-nums">
      {cells.map(([n, l], i) => (
        <div key={i} className="flex min-w-[2.5rem] flex-col items-center sm:min-w-[3.5rem]">
          <span className="text-3xl font-bold leading-none sm:text-5xl">{pad2(n)}</span>
          <span className="mt-1 text-[10px] uppercase tracking-wide opacity-70 sm:text-xs">{l}</span>
        </div>
      ))}
    </div>
  )
}

function ScheduledOverlay({ ctx }: PluginComponentProps) {
  const { t } = useTranslation('scheduledLivePlugin')
  const rootRef = useRef<HTMLDivElement>(null)
  const settings = resolveSettings(ctx.config)
  const { events, refresh } = usePublicAgenda(ctx.app, ctx.room)
  const now = useNowMs()
  const { phase, event } = computePhase(events, ctx.room, now, settings.autoHideMs)

  // Real-time agenda push (LiveKit data channel): only mountable inside a
  // room context (WebRTC players). Rendered in EVERY phase — a brand-new
  // event must land instantly even while the overlay is idle.
  const lkRoom = useMaybeRoomContext()
  const bridge = lkRoom ? <AgendaPushBridge onAgendaUpdate={refresh} /> : null

  // Mute only while a full cover is actually hiding the stream (countdown).
  const shouldMute =
    settings.mode === 'cover' && settings.muteUntilStart && phase === 'countdown'
  useMuteWhileCovering(rootRef, shouldMute)

  if (!event || phase === 'idle') return bridge

  const remaining = formatRemaining(phase === 'countdown' ? event.startAt - now : 0)
  const labels = {
    days: t('overlay.units.days'),
    hours: t('overlay.units.hours'),
    minutes: t('overlay.units.minutes'),
    seconds: t('overlay.units.seconds'),
  }

  // --- badge mode: a small, non-occluding corner chip during the countdown ---
  if (settings.mode === 'badge') {
    if (phase !== 'countdown') return bridge
    return (
      <>
        {bridge}
        <div
          ref={rootRef}
          className="pointer-events-none absolute right-0 top-0 z-30 m-2 flex items-center gap-2 rounded-lg bg-black/70 px-3 py-1.5 text-white backdrop-blur-sm sm:m-3"
        >
          <span
            className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full"
            style={{ backgroundColor: settings.accent }}
            aria-hidden="true"
          />
          <span className="text-xs font-semibold tabular-nums">
            {remaining.days > 0 ? `${remaining.days}${labels.days} ` : ''}
            {pad2(remaining.hours)}:{pad2(remaining.minutes)}:{pad2(remaining.seconds)}
          </span>
        </div>
      </>
    )
  }

  // --- cover mode ---
  const revealing = phase === 'reveal'
  // "none" animation = no transition: once revealing there is nothing to show.
  if (revealing && settings.revealAnimation === 'none') return bridge

  const transition =
    settings.revealAnimation === 'none'
      ? undefined
      : `opacity ${settings.autoHideMs}ms ease, transform ${settings.autoHideMs}ms ease`

  const startDate = new Date(event.startAt)
  const localTime = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(startDate)

  return (
    <>
    {bridge}
    <div
      ref={rootRef}
      className={`absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 overflow-hidden bg-black/80 px-6 text-center text-white backdrop-blur-md ${
        revealing ? 'pointer-events-none' : 'pointer-events-auto'
      }`}
      style={{
        opacity: revealing ? 0 : 1,
        transform: revealing && settings.revealAnimation === 'zoom' ? 'scale(1.12)' : 'scale(1)',
        transition,
      }}
      aria-label={t('overlay.aria', { headline: settings.headline })}
    >
      <div
        className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest"
        style={{ color: settings.accent }}
      >
        <span className="inline-block h-2 w-2 animate-pulse rounded-full" style={{ backgroundColor: settings.accent }} aria-hidden="true" />
        {t('overlay.soon')}
      </div>

      <h2 className="max-w-2xl text-xl font-bold sm:text-3xl">{settings.headline}</h2>
      {event.title && <p className="text-sm font-medium opacity-80 sm:text-base">{event.title}</p>}

      <CountdownRow remaining={remaining} labels={labels} />

      {settings.showViewerLocalTime && (
        <div className="text-xs opacity-80 sm:text-sm">
          <div>{t('overlay.startsAt', { time: localTime })}</div>
          <div className="mt-0.5 opacity-70">
            {event.timezone} · {formatOffsetLabel(event.timezone, event.startAt)}
          </div>
        </div>
      )}

      {event.message && <p className="max-w-xl text-xs opacity-70 sm:text-sm">{event.message}</p>}
    </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Config: display options + agenda manager
// ---------------------------------------------------------------------------

/** Parse a native <input type="datetime-local"> value into wall-clock fields. */
function parseDatetimeLocal(v: string): WallTime | null {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!m) return null
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: m[6] ? Number(m[6]) : 0,
  }
}

interface AddForm {
  title: string
  datetime: string
  timezone: string
  room: string
  message: string
  enabled: boolean
}

function ScheduledConfig({ values, onChange, app }: PluginConfigProps) {
  const { t } = useTranslation('scheduledLivePlugin')

  const set = (key: string, val: string | number | boolean) =>
    onChange({ ...values, [key]: val })

  // --- agenda state (local; the API is the source of truth) ---
  const [events, setEvents] = useState<ScheduledEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refetch = useCallback(async () => {
    if (!app) return
    setLoading(true)
    setError(null)
    try {
      setEvents(await listEvents(app))
    } catch (e) {
      setError(errMessage(e, t('config.agenda.loadError')))
    } finally {
      setLoading(false)
    }
  }, [app, t])

  useEffect(() => {
    void refetch()
  }, [refetch])

  const tzGuess = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const [form, setForm] = useState<AddForm>({
    title: '',
    datetime: '',
    timezone: tzGuess,
    room: '',
    message: '',
    enabled: true,
  })
  const setFormField = <K extends keyof AddForm>(key: K, val: AddForm[K]) =>
    setForm((f) => ({ ...f, [key]: val }))

  // Ensure the guessed zone is offered even if it's not in the curated list.
  const tzOptions = COMMON_TIMEZONES.includes(form.timezone)
    ? COMMON_TIMEZONES
    : [form.timezone, ...COMMON_TIMEZONES]

  async function onAdd() {
    if (!app) return
    const wall = parseDatetimeLocal(form.datetime)
    if (!wall) {
      setError(t('config.agenda.invalidDatetime'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await createEvent(app, {
        startAt: zonedWallTimeToUtcMs(wall, form.timezone),
        timezone: form.timezone,
        title: form.title.trim() || null,
        room: form.room.trim() || null,
        message: form.message.trim() || null,
        enabled: form.enabled,
      })
      setForm((f) => ({ ...f, title: '', datetime: '', room: '', message: '' }))
      await refetch()
    } catch (e) {
      setError(errMessage(e, t('config.agenda.saveError')))
    } finally {
      setBusy(false)
    }
  }

  async function onToggle(ev: ScheduledEvent) {
    if (!app) return
    setBusy(true)
    try {
      await updateEvent(app, ev.id, { enabled: !(ev.enabled ?? true) })
      await refetch()
    } catch (e) {
      setError(errMessage(e, t('config.agenda.saveError')))
    } finally {
      setBusy(false)
    }
  }

  async function onDelete(ev: ScheduledEvent) {
    if (!app) return
    if (!window.confirm(t('config.agenda.row.confirmDelete', { title: ev.title || t('config.agenda.row.untitled') })))
      return
    setBusy(true)
    try {
      await deleteEvent(app, ev.id)
      await refetch()
    } catch (e) {
      setError(errMessage(e, t('config.agenda.saveError')))
    } finally {
      setBusy(false)
    }
  }

  function whenLabel(ev: ScheduledEvent): string {
    const p = utcMsToZonedParts(ev.startAt, ev.timezone)
    const stamp = `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`
    return `${stamp} ${formatOffsetLabel(ev.timezone, ev.startAt)} · ${ev.timezone}`
  }

  return (
    <div className="space-y-6">
      {/* ---- display options (persisted by ConfigForm's Save button) ---- */}
      <section className="space-y-4">
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-100">
          {t('config.display.title')}
        </h4>

        <Field label={t('config.display.mode')}>
          <Select value={String(values.mode ?? 'cover')} onChange={(e) => set('mode', e.target.value)}>
            <option value="cover">{t('config.display.modeCover')}</option>
            <option value="badge">{t('config.display.modeBadge')}</option>
          </Select>
        </Field>

        <Field label={t('config.display.accent')}>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={String(values.accent ?? '#2f7bff')}
              onChange={(e) => set('accent', e.target.value)}
              className="h-9 w-12 cursor-pointer rounded border border-gray-300 bg-transparent dark:border-gray-600"
              aria-label={t('config.display.accent')}
            />
            <TextInput
              value={String(values.accent ?? '')}
              placeholder="#RRGGBB"
              onChange={(e) => set('accent', e.target.value)}
            />
          </div>
        </Field>

        <Field label={t('config.display.headline')}>
          <TextInput
            value={String(values.headline ?? '')}
            onChange={(e) => set('headline', e.target.value)}
          />
        </Field>

        <Field label={t('config.display.revealAnimation')}>
          <Select
            value={String(values.revealAnimation ?? 'fade')}
            onChange={(e) => set('revealAnimation', e.target.value)}
          >
            <option value="fade">{t('config.display.animFade')}</option>
            <option value="zoom">{t('config.display.animZoom')}</option>
            <option value="none">{t('config.display.animNone')}</option>
          </Select>
        </Field>

        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-700 dark:text-gray-100">
            {t('config.display.muteUntilStart')}
          </span>
          <Toggle
            checked={values.muteUntilStart !== false}
            onChange={(v) => set('muteUntilStart', v)}
          />
        </div>

        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-700 dark:text-gray-100">
            {t('config.display.showViewerLocalTime')}
          </span>
          <Toggle
            checked={values.showViewerLocalTime !== false}
            onChange={(v) => set('showViewerLocalTime', v)}
          />
        </div>

        <Field label={t('config.display.autoHide')}>
          <TextInput
            type="number"
            min={0}
            max={60}
            value={values.autoHideAfterStartSec === undefined ? '' : String(values.autoHideAfterStartSec)}
            onChange={(e) => set('autoHideAfterStartSec', e.target.value === '' ? 0 : Number(e.target.value))}
          />
        </Field>
      </section>

      {/* ---- agenda manager (saved immediately via the scheduled-live API) ---- */}
      <section className="space-y-3 border-t border-gray-200 pt-5 dark:border-gray-700">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-100">
            {t('config.agenda.title')}
          </h4>
          <Button variant="ghost" onClick={() => void refetch()} disabled={loading || busy}>
            {loading ? t('config.agenda.loading') : t('config.agenda.refresh')}
          </Button>
        </div>

        {error && <ErrorBanner message={error} />}

        {events.length === 0 && !loading ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('config.agenda.empty')}</p>
        ) : (
          <ul className="space-y-2">
            {events.map((ev) => (
              <li
                key={ev.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-700"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-gray-800 dark:text-gray-100">
                    {ev.title || t('config.agenda.row.untitled')}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {whenLabel(ev)}
                    {' · '}
                    {ev.room ? ev.room : t('config.agenda.row.allRooms')}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Toggle checked={ev.enabled ?? true} disabled={busy} onChange={() => void onToggle(ev)} />
                  <Button variant="danger" onClick={() => void onDelete(ev)} disabled={busy}>
                    {t('config.agenda.row.delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* add-event form */}
        <div className="space-y-3 rounded-lg bg-gray-50 p-3 dark:bg-gray-800/50">
          <Field label={t('config.agenda.fields.title')}>
            <TextInput value={form.title} onChange={(e) => setFormField('title', e.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('config.agenda.fields.datetime')}>
              <TextInput
                type="datetime-local"
                value={form.datetime}
                onChange={(e) => setFormField('datetime', e.target.value)}
              />
            </Field>
            <Field label={t('config.agenda.fields.timezone')}>
              <Select value={form.timezone} onChange={(e) => setFormField('timezone', e.target.value)}>
                {tzOptions.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label={t('config.agenda.fields.room')} hint={t('config.agenda.fields.roomHint')}>
            <TextInput value={form.room} onChange={(e) => setFormField('room', e.target.value)} />
          </Field>
          <Field label={t('config.agenda.fields.message')}>
            <TextInput value={form.message} onChange={(e) => setFormField('message', e.target.value)} />
          </Field>
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-700 dark:text-gray-100">
              {t('config.agenda.fields.enabled')}
            </span>
            <Toggle checked={form.enabled} onChange={(v) => setFormField('enabled', v)} />
          </div>
          <Button variant="accent" onClick={() => void onAdd()} disabled={busy || !app}>
            {t('config.agenda.add')}
          </Button>
        </div>

        <p className="text-xs text-gray-500 dark:text-gray-400">{t('config.agenda.note')}</p>
      </section>
    </div>
  )
}

export default definePlugin({
  id: 'scheduled-live',
  name: 'Scheduled Live',
  description:
    'Schedule live premieres: viewers see a countdown until the start time, then the stream is revealed.',
  category: 'tool',
  icon: CLOCK_ICON,
  version: '1.0.0',
  ui: 'player-overlay',
  configSchema: {
    fields: [
      {
        key: 'mode',
        type: 'select',
        label: 'Display mode',
        default: 'cover',
        options: [
          { value: 'cover', label: 'Full cover (hide stream until start)' },
          { value: 'badge', label: 'Corner badge only' },
        ],
      },
      { key: 'accent', type: 'string', label: 'Accent colour', default: '#2f7bff', placeholder: '#RRGGBB' },
      { key: 'headline', type: 'string', label: 'Headline', default: 'The live stream starts soon' },
      {
        key: 'revealAnimation',
        type: 'select',
        label: 'Reveal animation',
        default: 'fade',
        options: [
          { value: 'fade', label: 'Fade' },
          { value: 'zoom', label: 'Zoom' },
          { value: 'none', label: 'None' },
        ],
      },
      { key: 'muteUntilStart', type: 'boolean', label: 'Mute stream until start', default: true },
      { key: 'showViewerLocalTime', type: 'boolean', label: "Show viewer's local start time", default: true },
      {
        key: 'autoHideAfterStartSec',
        type: 'number',
        label: 'Keep reveal animation (seconds)',
        default: 5,
        min: 0,
        max: 60,
      },
    ],
  },
  OverlayComponent: ScheduledOverlay,
  ConfigComponent: ScheduledConfig,
})
