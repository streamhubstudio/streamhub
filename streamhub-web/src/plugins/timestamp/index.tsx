/**
 * Timestamp CCTV — the reference PLAYER-OVERLAY plugin.
 *
 * PATTERN (how an overlay plugin is written):
 *   1. `definePlugin({ ui: 'player-overlay', configSchema, OverlayComponent })`
 *      as the default export → auto-discovered by the glob in discovery.ts. No
 *      central file is edited.
 *   2. Declare `configSchema` and you get the settings form for free (generic
 *      ConfigForm). The host persists it; the overlay reads it via `ctx.config`.
 *   3. Put the real logic in a PURE, framework-agnostic module (overlay.util.ts)
 *      and keep the component a thin, absolutely-positioned shell. That module
 *      is what the unit tests exercise.
 *   4. The overlay renders ONLY when the plugin is installed + active for the
 *      app (the host's <PluginSlot placement="player-overlay">, driven by the
 *      merged catalog, decides that).
 *
 * The overlay draws a live, ticking date/time stamp in a configurable corner,
 * colour and format, optionally prefixed with the camera / stream name.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { definePlugin } from '../types.ts'
import type { PluginComponentProps } from '../types.ts'
import {
  formatTimestamp,
  overlayName,
  positionClasses,
  resolveSettings,
} from './overlay.util.ts'

/** A 1 Hz clock. Returns a Date that updates every second. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

function TimestampOverlay({ ctx }: PluginComponentProps) {
  const { t } = useTranslation('timestampPlugin')
  const now = useNow()

  const { format, position, color, showName } = resolveSettings(ctx.config)
  const time = formatTimestamp(now, format)
  const name = showName ? overlayName(ctx) : undefined

  return (
    // pointer-events-none so the stamp never eats player clicks; absolute within
    // the (relatively-positioned) player Frame the slot is mounted into.
    <div
      className={`pointer-events-none absolute z-20 p-2 sm:p-3 ${positionClasses(position)}`}
      aria-label={t('overlay.ariaLabel', { name: name ?? t('overlay.camera'), time })}
    >
      <div
        className="flex items-center gap-1.5 rounded-md bg-black/55 px-2 py-1 font-mono text-[11px] leading-tight tracking-tight backdrop-blur-sm sm:text-xs"
        style={{ color }}
      >
        <span
          className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-red-500"
          aria-hidden="true"
        />
        {name && (
          <span className="max-w-[40vw] truncate font-semibold uppercase sm:max-w-[220px]">
            {name}
          </span>
        )}
        <span className="tabular-nums">{time}</span>
      </div>
    </div>
  )
}

export default definePlugin({
  id: 'timestamp',
  name: 'Timestamp CCTV',
  description:
    'A live CCTV-style date/time stamp overlaid on the player, with the camera name.',
  category: 'tool',
  icon: 'M12 8v4l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  version: '1.0.0',
  ui: 'player-overlay',
  configSchema: {
    fields: [
      {
        key: 'format',
        type: 'select',
        label: 'Time format',
        default: 'datetime-24h',
        options: [
          { value: 'datetime-24h', label: 'YYYY-MM-DD HH:mm:ss' },
          { value: 'datetime-12h', label: 'YYYY-MM-DD hh:mm:ss AM/PM' },
          { value: 'time-24h', label: 'HH:mm:ss' },
          { value: 'time-12h', label: 'hh:mm:ss AM/PM' },
          { value: 'date-us', label: 'MM/DD/YYYY HH:mm:ss' },
        ],
      },
      {
        key: 'position',
        type: 'select',
        label: 'Position',
        default: 'bottom-right',
        options: [
          { value: 'top-left', label: 'Top left' },
          { value: 'top-right', label: 'Top right' },
          { value: 'bottom-left', label: 'Bottom left' },
          { value: 'bottom-right', label: 'Bottom right' },
        ],
      },
      {
        key: 'color',
        type: 'string',
        label: 'Text colour',
        default: '#00e5ff',
        placeholder: '#RRGGBB',
      },
      {
        key: 'showName',
        type: 'boolean',
        label: 'Show camera / stream name',
        default: true,
      },
    ],
  },
  OverlayComponent: TimestampOverlay,
})
