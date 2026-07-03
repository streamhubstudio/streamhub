/**
 * Generic, typed config form rendered from a plugin's `ConfigSchema`.
 *
 * A plugin gets settings UI for free by declaring `configSchema`. If it needs
 * something the schema can't express it may ship its own `ConfigComponent`,
 * which this form hosts (still providing the Save button + persistence).
 *
 * Validation uses the pure `validateValues` (i18n-agnostic codes) mapped to
 * localized messages here.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useUpdatePluginConfig } from './usePlugins.ts'
import {
  buildInitialValues,
  coerceValue,
  pruneValues,
  validateValues,
} from './schema.ts'
import { Button, ErrorBanner, Field, Select, Textarea, TextInput, Toggle, errMessage } from './ui.tsx'
import type { ConfigErrorCode, ConfigField, ConfigValues, PluginView } from './types.ts'

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: ConfigField
  value: string | number | boolean | undefined
  onChange: (v: string | number | boolean) => void
}) {
  switch (field.type) {
    case 'boolean':
      return (
        <Toggle checked={Boolean(value)} onChange={(v) => onChange(v)} />
      )
    case 'select':
      return (
        <Select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      )
    case 'textarea':
      return (
        <Textarea
          value={String(value ?? '')}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    case 'number':
      return (
        <TextInput
          type="number"
          inputMode="decimal"
          min={field.min}
          max={field.max}
          step={field.step}
          value={value === undefined ? '' : String(value)}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    case 'secret':
      return (
        <TextInput
          type="password"
          autoComplete="off"
          value={String(value ?? '')}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    default:
      return (
        <TextInput
          type={field.type === 'url' ? 'url' : 'text'}
          value={String(value ?? '')}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )
  }
}

export function ConfigForm({
  app,
  view,
  onDone,
}: {
  /** App the plugin is installed in (config is persisted per-app). */
  app: string
  view: PluginView
  onDone?: () => void
}) {
  const { t } = useTranslation('marketplace')
  const schema = view.configSchema
  const CustomEditor = view.registered?.ConfigComponent

  const [values, setValues] = useState<ConfigValues>(() =>
    buildInitialValues(schema, view.config),
  )
  const [showErrors, setShowErrors] = useState(false)
  const save = useUpdatePluginConfig(app)

  const validation = useMemo(() => validateValues(schema, values), [schema, values])

  function setField(field: ConfigField, raw: string | number | boolean) {
    setValues((prev) => ({ ...prev, [field.key]: coerceValue(field, raw) }))
  }

  function errorFor(code: ConfigErrorCode): string {
    return t(`config.errors.${code}`)
  }

  function onSave() {
    if (!validation.valid) {
      setShowErrors(true)
      return
    }
    save.mutate(
      { id: view.id, config: pruneValues(values) },
      { onSuccess: () => onDone?.() },
    )
  }

  const hasSchema = Boolean(schema && schema.fields.length)

  return (
    <div className="space-y-4">
      {CustomEditor ? (
        <CustomEditor values={values} onChange={setValues} pluginId={view.id} />
      ) : hasSchema ? (
        <div className="space-y-4">
          {schema!.fields.map((field) => (
            <Field
              key={field.key}
              label={field.label + (field.required ? ' *' : '')}
              hint={field.description}
              error={
                showErrors && validation.errors[field.key]
                  ? errorFor(validation.errors[field.key])
                  : undefined
              }
            >
              <FieldControl
                field={field}
                value={values[field.key]}
                onChange={(v) => setField(field, v)}
              />
            </Field>
          ))}
        </div>
      ) : (
        <p className="text-sm text-slate-400">{t('config.noSettings')}</p>
      )}

      {save.isError && (
        <ErrorBanner message={errMessage(save.error, t('config.saveError'))} />
      )}

      {(hasSchema || CustomEditor) && (
        <div className="flex items-center gap-3">
          <Button variant="accent" disabled={save.isPending} onClick={onSave}>
            {save.isPending ? t('config.saving') : t('config.save')}
          </Button>
          {onDone && (
            <Button variant="ghost" onClick={onDone} disabled={save.isPending}>
              {t('actions.close')}
            </Button>
          )}
          {save.isSuccess && !save.isPending && (
            <span className="text-xs font-medium text-success">{t('config.saved')}</span>
          )}
        </div>
      )}
    </div>
  )
}
