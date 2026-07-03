/**
 * Read-only field (input or textarea) with a copy-to-clipboard button.
 * Player-specific helper for the share / embed panel. Gives quick visual
 * "copied" feedback and degrades gracefully when the Clipboard API is missing.
 *
 * RE-SKIN: renders through the Elstar design system (`@/ui` Input + Button) so
 * it matches the rest of the backoffice. Accent resolves to the StreamHub brand
 * (`primary-*` → #2f7bff); light/dark is automatic via the `.dark` class. The
 * copy logic (Clipboard API + legacy fallback) is unchanged.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Input } from '@/ui'

interface CopyFieldProps {
  label: string
  value: string
  /** Render a multi-line textarea instead of a single-line input. */
  multiline?: boolean
  /** Monospace the value (URLs / HTML snippets). */
  mono?: boolean
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to legacy path */
  }
  // Legacy fallback for non-secure contexts.
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export function CopyField({ label, value, multiline = false, mono = true }: CopyFieldProps) {
  const { t } = useTranslation('common')
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const handleCopy = useCallback(async () => {
    const ok = await copyText(value)
    if (!ok) return
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1800)
  }, [value])

  const monoClass = mono ? 'font-mono text-xs' : 'text-xs'

  return (
    <div>
      <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-fg-muted">
        {label}
      </label>
      <div className="flex items-start gap-2">
        {multiline ? (
          <Input
            textArea
            readOnly
            value={value}
            rows={3}
            onFocus={(e) => e.currentTarget.select()}
            className={`resize-none break-all ${monoClass}`}
          />
        ) : (
          <Input
            readOnly
            size="sm"
            value={value}
            onFocus={(e) => e.currentTarget.select()}
            className={`truncate ${monoClass}`}
          />
        )}
        <Button
          type="button"
          size="sm"
          variant={copied ? 'solid' : 'default'}
          onClick={handleCopy}
          className="shrink-0"
        >
          {copied ? t('actions.copied') : t('actions.copy')}
        </Button>
      </div>
    </div>
  )
}
