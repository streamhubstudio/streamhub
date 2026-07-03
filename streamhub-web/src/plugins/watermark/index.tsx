/**
 * Watermark — a PLAYER-OVERLAY plugin.
 *
 * Draws a configurable text watermark in a corner of the player. It mirrors the
 * streamhub-core `watermark` plugin's configSchema (text / position / opacity)
 * so an install configured in the dashboard renders identically here.
 *
 * PATTERN (same as the Timestamp CCTV reference overlay):
 *   1. `definePlugin({ ui: 'player-overlay', configSchema, OverlayComponent })`
 *      as the default export → auto-discovered by the glob in discovery.ts.
 *   2. Declare `configSchema` and get the generic settings form for free; the
 *      host persists it and the overlay reads it via `ctx.config`.
 *   3. Real logic lives in a PURE module (overlay.util.ts); the component is a
 *      thin, absolutely-positioned, pointer-events-none shell.
 *   4. The overlay renders ONLY when the plugin is installed + active for the
 *      app (the host's <PluginSlot placement="player-overlay"> decides that).
 */
import { useTranslation } from 'react-i18next'
import { definePlugin } from '../types.ts'
import type { PluginComponentProps } from '../types.ts'
import { positionClasses, resolveSettings } from './overlay.util.ts'

function WatermarkOverlay({ ctx }: PluginComponentProps) {
  const { t } = useTranslation('watermarkPlugin')
  const { text, position, opacity } = resolveSettings(ctx.config)

  return (
    // pointer-events-none so the mark never eats player clicks; absolute within
    // the (relatively-positioned) player Frame the slot is mounted into.
    <div
      className={`pointer-events-none absolute z-20 p-2 sm:p-3 ${positionClasses(position)}`}
      style={{ opacity }}
      aria-label={t('overlay.ariaLabel', { text })}
    >
      <span className="select-none text-sm font-semibold tracking-wide text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)] sm:text-base">
        {text}
      </span>
    </div>
  )
}

export default definePlugin({
  id: 'watermark',
  name: 'Watermark',
  description: 'Overlay a text watermark on the player.',
  category: 'tool',
  // 'stamp' glyph — a simple mark icon (drawn with stroke=currentColor).
  icon: 'M5 21h14M7 7l5-4 5 4M12 3v10M8 13h8l1 4H7l1-4z',
  version: '1.0.0',
  ui: 'player-overlay',
  configSchema: {
    fields: [
      {
        key: 'text',
        type: 'string',
        label: 'Watermark text',
        default: 'StreamHub',
        placeholder: 'StreamHub',
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
        key: 'opacity',
        type: 'number',
        label: 'Opacity',
        default: 0.6,
        min: 0,
        max: 1,
        step: 0.1,
      },
    ],
  },
  OverlayComponent: WatermarkOverlay,
})
