/**
 * Streamflow — the box CONFIG PANEL (right rail of the editor).
 *
 * Renders the selected box's config form from its catalogue `fields` (the schema
 * the backend serves at GET …/boxes). Field types map to controls
 * (string/number/boolean/select/text/json); three fields get a richer editor:
 *   - trigger.event `event`   → text input + a datalist of known domain events;
 *   - action.ai     `prompt`  → the `text` textarea (generic path);
 *   - logic.condition `rules` → a small field/op/value rule builder.
 *
 * All edits flow up through `onChange(newConfig)`; the panel never mutates.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { flattenEventNames, type BoxField, type BoxSpec, type CanvasBox, type EventFamily } from './graph.util.ts'

/**
 * Curated domain events (grounded in the shipped plugins) for the trigger picker
 * — a COMPLETE static fallback used when the live `GET /events` catalogue is
 * unavailable. Mirrors streamhub-core boxes/event-catalogue.ts.
 */
export const EVENT_SUGGESTIONS = [
  'room_started', 'room_finished', 'participant_joined', 'participant_left',
  'track_published', 'track_unpublished',
  'ingress_started', 'ingress_ended', 'egress_started', 'egress_updated', 'egress_ended',
  'stream_started', 'stream_ended', 'stream.latency_high', 'stream.latency_recovered', 'stream.*',
  'recording_started', 'recording_part_ready', 'recording_ready', 'recording_failed',
  'snapshot_taken', 'vod_ready', 'vod_variants_ready',
  'hls_started', 'hls_stopped',
  'restream_started', 'restream_stopped', 'restream_failed',
  'chat_message', 'reaction',
  'plugin_worker_started', 'plugin_worker_stopped', 'plugin_worker_error',
  'plugin.version_changed',
  'network.threshold_exceeded', 'network.threshold_recovered',
  'iot.data',
  'node.online', 'node.offline', 'cluster.capacity', 'node.*',
  'streamflow.run_started', 'streamflow.run_finished', 'streamflow.run_failed', 'streamflow.output',
  'plate.detected', 'plate.allowed', 'plate.denied', 'plate.*',
  'count.in', 'count.out', 'count.occupancy', 'count.*',
  'occupancy.session_started', 'occupancy.session_ended', 'occupancy.alert', 'occupancy.*',
  'crowd.count', 'crowd.threshold',
  'demography.face',
  'presence.absent', 'presence.returned', 'presence.after_hours',
  'ppe.violation',
  'perimeter.intrusion',
]

const CONDITION_OPS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'matches',
  'exists',
] as const

type ConfigVal = Record<string, unknown>

export interface ConfigPanelProps {
  box: CanvasBox
  spec: BoxSpec | undefined
  onChange: (config: ConfigVal) => void
  onDelete: () => void
  onClose: () => void
  /** Live event catalogue (GET /events); falls back to EVENT_SUGGESTIONS. */
  eventCatalogue?: EventFamily[]
}

export function ConfigPanel({ box, spec, onChange, onDelete, onClose, eventCatalogue }: ConfigPanelProps) {
  const { t } = useTranslation('streamflow')
  const eventSuggestions =
    eventCatalogue && eventCatalogue.length ? flattenEventNames(eventCatalogue) : EVENT_SUGGESTIONS

  const set = (key: string, value: unknown) => {
    const next = { ...box.config }
    if (value === undefined) delete next[key]
    else next[key] = value
    onChange(next)
  }

  return (
    <aside
      data-testid="sf-config-panel"
      className="w-full shrink-0 space-y-3 rounded-lg border border-white/10 bg-white/5 p-3 lg:w-72"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold">{spec?.label ?? box.type}</div>
          <div className="font-mono text-[10px] opacity-50">{box.type}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('panel.close')}
          className="rounded px-1.5 py-0.5 text-xs opacity-60 hover:opacity-100"
        >
          ✕
        </button>
      </div>
      {spec?.description && <p className="text-[11px] opacity-60">{spec.description}</p>}

      {!spec || spec.fields.length === 0 ? (
        <p className="text-xs opacity-50">{t('panel.noFields')}</p>
      ) : (
        <div className="space-y-3">
          {spec.fields.map((f) => (
            <Field
              key={`${box.id}:${f.key}`}
              boxType={box.type}
              field={f}
              value={box.config[f.key]}
              eventSuggestions={eventSuggestions}
              onChange={(v) => set(f.key, v)}
            />
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={onDelete}
        data-testid="sf-delete-box"
        className="w-full rounded-md border border-red-400/40 px-2.5 py-1.5 text-xs text-red-300 hover:bg-red-500/10"
      >
        {t('panel.deleteBox')}
      </button>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// One field
// ---------------------------------------------------------------------------

function Field({
  boxType,
  field,
  value,
  eventSuggestions,
  onChange,
}: {
  boxType: string
  field: BoxField
  value: unknown
  eventSuggestions: string[]
  onChange: (v: unknown) => void
}) {
  const label = (
    <div className="mb-1 flex items-baseline justify-between gap-2">
      <span className="text-xs font-medium">{field.label}</span>
    </div>
  )

  // --- type-specific richer editors -----------------------------------------
  if (boxType === 'trigger.event' && field.key === 'event') {
    return (
      <label className="block">
        {label}
        <input
          list="sf-event-suggestions"
          type="text"
          value={asString(value)}
          placeholder="plate.* · perimeter.intrusion · …"
          data-testid={`sf-field-${field.key}`}
          onChange={(e) => onChange(e.target.value || undefined)}
          className="w-full rounded border border-white/10 bg-white/5 px-2 py-1 text-xs"
        />
        <datalist id="sf-event-suggestions">
          {eventSuggestions.map((ev) => (
            <option key={ev} value={ev} />
          ))}
        </datalist>
        {field.help && <p className="mt-1 text-[10px] opacity-50">{field.help}</p>}
      </label>
    )
  }

  if (boxType === 'logic.condition' && field.key === 'rules') {
    return (
      <div>
        {label}
        <RuleBuilder value={value} onChange={onChange} />
        {field.help && <p className="mt-1 text-[10px] opacity-50">{field.help}</p>}
      </div>
    )
  }

  // --- generic by type ------------------------------------------------------
  switch (field.type) {
    case 'boolean':
      return (
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={value === true}
            data-testid={`sf-field-${field.key}`}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className="font-medium">{field.label}</span>
        </label>
      )
    case 'number':
      return (
        <label className="block">
          {label}
          <input
            type="number"
            value={value === undefined || value === null ? '' : String(value)}
            data-testid={`sf-field-${field.key}`}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
            className="w-full rounded border border-white/10 bg-white/5 px-2 py-1 text-xs"
          />
          {field.help && <p className="mt-1 text-[10px] opacity-50">{field.help}</p>}
        </label>
      )
    case 'select':
      return (
        <label className="block">
          {label}
          <select
            value={asString(value)}
            data-testid={`sf-field-${field.key}`}
            onChange={(e) => onChange(e.target.value)}
            className="w-full rounded border border-white/10 bg-white/5 px-2 py-1 text-xs"
          >
            {(field.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {field.help && <p className="mt-1 text-[10px] opacity-50">{field.help}</p>}
        </label>
      )
    case 'text':
      return (
        <label className="block">
          {label}
          <textarea
            rows={4}
            value={asString(value)}
            data-testid={`sf-field-${field.key}`}
            onChange={(e) => onChange(e.target.value || undefined)}
            className="w-full rounded border border-white/10 bg-white/5 px-2 py-1 font-mono text-xs"
          />
          {field.help && <p className="mt-1 text-[10px] opacity-50">{field.help}</p>}
        </label>
      )
    case 'json':
      return (
        <div>
          {label}
          <JsonField value={value} onChange={onChange} testid={`sf-field-${field.key}`} />
          {field.help && <p className="mt-1 text-[10px] opacity-50">{field.help}</p>}
        </div>
      )
    case 'string':
    default:
      return (
        <label className="block">
          {label}
          <input
            type="text"
            value={asString(value)}
            data-testid={`sf-field-${field.key}`}
            onChange={(e) => onChange(e.target.value || undefined)}
            className="w-full rounded border border-white/10 bg-white/5 px-2 py-1 text-xs"
          />
          {field.help && <p className="mt-1 text-[10px] opacity-50">{field.help}</p>}
        </label>
      )
  }
}

// ---------------------------------------------------------------------------
// JSON textarea — stores the PARSED value, tolerates mid-typing invalid JSON
// ---------------------------------------------------------------------------

function JsonField({
  value,
  onChange,
  testid,
}: {
  value: unknown
  onChange: (v: unknown) => void
  testid: string
}) {
  const { t } = useTranslation('streamflow')
  const [text, setText] = useState(() => stringifyJson(value))
  const [bad, setBad] = useState(false)

  const handle = (raw: string) => {
    setText(raw)
    const trimmed = raw.trim()
    if (!trimmed) {
      setBad(false)
      onChange(undefined)
      return
    }
    try {
      onChange(JSON.parse(trimmed))
      setBad(false)
    } catch {
      setBad(true)
    }
  }

  return (
    <div>
      <textarea
        rows={4}
        value={text}
        spellCheck={false}
        data-testid={testid}
        onChange={(e) => handle(e.target.value)}
        className={`w-full rounded border bg-white/5 px-2 py-1 font-mono text-xs ${
          bad ? 'border-red-400/60' : 'border-white/10'
        }`}
      />
      {bad && <p className="mt-1 text-[10px] text-red-400">{t('panel.invalidJson')}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Condition rule builder — [{field, op, value}] rows
// ---------------------------------------------------------------------------

interface Rule {
  field: string
  op: string
  value?: unknown
}

function RuleBuilder({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const { t } = useTranslation('streamflow')
  const rules: Rule[] = Array.isArray(value) ? (value as Rule[]) : []

  const commit = (next: Rule[]) => onChange(next)
  const patch = (i: number, p: Partial<Rule>) =>
    commit(rules.map((r, idx) => (idx === i ? { ...r, ...p } : r)))

  return (
    <div className="space-y-2">
      {rules.length === 0 && <p className="text-[10px] opacity-50">{t('panel.noRules')}</p>}
      {rules.map((r, i) => (
        <div key={i} className="flex items-center gap-1" data-testid="sf-rule-row">
          <input
            type="text"
            value={r.field ?? ''}
            placeholder={t('panel.ruleField')}
            aria-label={t('panel.ruleField')}
            onChange={(e) => patch(i, { field: e.target.value })}
            className="min-w-0 flex-1 rounded border border-white/10 bg-white/5 px-1.5 py-1 font-mono text-[11px]"
          />
          <select
            value={r.op ?? 'eq'}
            aria-label={t('panel.ruleOp')}
            onChange={(e) => patch(i, { op: e.target.value })}
            className="rounded border border-white/10 bg-white/5 px-1 py-1 text-[11px]"
          >
            {CONDITION_OPS.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={r.value === undefined ? '' : String(r.value)}
            placeholder={t('panel.ruleValue')}
            aria-label={t('panel.ruleValue')}
            disabled={r.op === 'exists'}
            onChange={(e) => patch(i, { value: coerce(e.target.value) })}
            className="w-16 rounded border border-white/10 bg-white/5 px-1.5 py-1 font-mono text-[11px] disabled:opacity-40"
          />
          <button
            type="button"
            aria-label={t('panel.ruleRemove')}
            onClick={() => commit(rules.filter((_, idx) => idx !== i))}
            className="rounded px-1 py-0.5 text-[11px] text-red-400 hover:bg-red-500/10"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        data-testid="sf-add-rule"
        onClick={() => commit([...rules, { field: '', op: 'eq', value: '' }])}
        className="rounded-md bg-white/10 px-2 py-1 text-[11px] hover:bg-white/15"
      >
        + {t('panel.addRule')}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function asString(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  return String(v)
}

function stringifyJson(v: unknown): string {
  if (v === undefined || v === null) return ''
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return ''
  }
}

/** Coerce a rule value string into number/boolean/string. */
function coerce(raw: string): unknown {
  const s = raw.trim()
  if (s === '') return ''
  if (s === 'true') return true
  if (s === 'false') return false
  const n = Number(s)
  if (s !== '' && Number.isFinite(n) && String(n) === s) return n
  return raw
}
