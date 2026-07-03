/**
 * YOLO plugin surfaces: a custom config editor (COCO-class multiselect + the
 * backend-mirrored fields) and a player-overlay live badge. Kept out of
 * index.tsx so that file only exports the plugin manifest.
 */
import { useTranslation } from 'react-i18next'
import type {
  ConfigValues,
  PluginComponentProps,
  PluginConfigProps,
} from '@/plugins'
import { Field, Select, TextInput, Toggle } from '../ui.tsx'
import { COCO_CLASSES, MODEL_SIZES, parseClasses, toggleClass } from './classes.ts'

function str(v: ConfigValues[string]): string {
  return v === undefined || v === null ? '' : String(v)
}
function num(v: ConfigValues[string], fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** Custom config editor: mirrors the backend schema + a COCO class multiselect. */
export function YoloConfig({ values, onChange }: PluginConfigProps) {
  const { t } = useTranslation('yolo')
  const set = (key: string, v: string | number | boolean | undefined) =>
    onChange({ ...values, [key]: v })

  const selected = parseClasses(str(values.classes))
  const selectedSet = new Set(selected)

  return (
    <div className="space-y-4">
      <Field label={t('fields.room.label')} hint={t('fields.room.help')}>
        <TextInput
          value={str(values.room)}
          placeholder={t('fields.room.placeholder')}
          onChange={(e) => set('room', e.target.value || undefined)}
        />
      </Field>

      <Field label={t('fields.callbackUrl.label')} hint={t('fields.callbackUrl.help')}>
        <TextInput
          type="url"
          value={str(values.callbackUrl)}
          placeholder={t('fields.callbackUrl.placeholder')}
          onChange={(e) => set('callbackUrl', e.target.value || undefined)}
        />
      </Field>

      <Field label={t('fields.model.label')} hint={t('fields.model.help')}>
        <Select
          value={str(values.model) || 'nano'}
          onChange={(e) => set('model', e.target.value)}
        >
          {MODEL_SIZES.map((m) => (
            <option key={m} value={m}>
              {t(`models.${m}`)}
            </option>
          ))}
        </Select>
      </Field>

      <div className="flex items-center justify-between gap-3">
        <div>
          <span className="block text-xs font-medium text-gray-700 dark:text-gray-200">
            {t('fields.cuda.label')}
          </span>
          <span className="mt-1 block text-[11px] text-gray-500 dark:text-gray-400">
            {t('fields.cuda.help')}
          </span>
        </div>
        <Toggle
          checked={values.cuda === true || values.cuda === 'true'}
          onChange={(v) => set('cuda', v)}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t('fields.confidence.label')} hint={t('fields.confidence.help')}>
          <TextInput
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={str(values.confidence) || '0.35'}
            onChange={(e) => set('confidence', num(e.target.value, 0.35))}
          />
        </Field>
        <Field label={t('fields.fps.label')} hint={t('fields.fps.help')}>
          <TextInput
            type="number"
            min={0.1}
            max={30}
            step={0.5}
            value={str(values.fps) || '2'}
            onChange={(e) => set('fps', num(e.target.value, 2))}
          />
        </Field>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-medium text-gray-700 dark:text-gray-200">
            {t('fields.classes.label')}
          </span>
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            {selected.length === 0
              ? t('fields.classes.all')
              : t('fields.classes.count', { count: selected.length })}
          </span>
        </div>
        <p className="mb-2 text-[11px] text-gray-500 dark:text-gray-400">{t('fields.classes.help')}</p>
        <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-700/40 p-2">
          {COCO_CLASSES.map((c) => {
            const on = selectedSet.has(c)
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                onClick={() => set('classes', toggleClass(str(values.classes), c) || undefined)}
                className={[
                  'rounded-full border px-2 py-0.5 text-[11px] transition max-md:min-h-[32px]',
                  on
                    ? 'border-primary-500/50 bg-primary-500/15 text-primary-600 dark:text-primary-300'
                    : 'border-gray-200 bg-gray-50 text-gray-500 hover:text-gray-700 dark:border-gray-700 dark:bg-gray-700/40 dark:text-gray-400 dark:hover:text-gray-200',
                ].join(' ')}
              >
                {c}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** Player-overlay surface: a small live badge showing the detector is active. */
export function YoloOverlay({ ctx }: PluginComponentProps) {
  const { t } = useTranslation('yolo')
  const selected = parseClasses(str(ctx.config.classes))
  const device = ctx.config.cuda === true || ctx.config.cuda === 'true' ? 'GPU' : 'CPU'
  return (
    <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-2 rounded-full bg-black/55 px-3 py-1 text-[11px] font-medium text-white backdrop-blur-sm">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
      <span>{t('overlay.badge', { device })}</span>
      <span className="text-white/70">
        {selected.length === 0
          ? t('overlay.allClasses')
          : t('overlay.classes', { count: selected.length })}
      </span>
    </div>
  )
}
