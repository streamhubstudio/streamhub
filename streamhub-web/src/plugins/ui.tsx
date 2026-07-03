/**
 * Presentational primitives for the plugins feature — re-skinned to the Elstar
 * design system (ported into `@/ui`) while keeping the StreamHub brand token
 * (`primary` = #2f7bff) and light/dark (`.dark`) behaviour.
 *
 * These wrappers keep their original, feature-facing signatures (so cockpit /
 * yolo etc. don't change) but now render Elstar components underneath: buttons →
 * <Button>, panels → <Card>, toggles → <Switcher>, error banners → <Alert>.
 * Inputs stay native (Select keeps its <option> children) but adopt the Elstar
 * `.input` look. See src/ui/MIGRATION.md.
 *
 * Owned by the plugins feature (mirrors pages/AppDetail/ui.tsx, which is scoped
 * to that page and must not be imported cross-page).
 */
import type { ReactNode } from 'react'
import { ApiRequestError } from '@/api'
import { Alert, Button as UiButton, Card as UiCard, Switcher } from '@/ui'

export function errMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) return error.message
  if (error instanceof Error) return error.message
  return fallback
}

// Elstar `.input` look, brand-focused + a solid surface so it reads on cards.
const inputClass =
  'input text-sm bg-white dark:bg-gray-700 focus:ring-primary-500 focus:border-primary-500 disabled:cursor-not-allowed disabled:opacity-50'

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props
  return <input {...rest} className={`${inputClass} ${className}`} />
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = '', ...rest } = props
  return <textarea {...rest} className={`${inputClass} min-h-[80px] ${className}`} />
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = '', ...rest } = props
  return <select {...rest} className={`${inputClass} ${className}`} />
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-100">
        {label}
      </span>
      {children}
      {error ? (
        <span className="mt-1 block text-xs text-red-500">{error}</span>
      ) : (
        hint && (
          <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">{hint}</span>
        )
      )}
    </label>
  )
}

type Variant = 'accent' | 'ghost' | 'danger'

/** Feature-facing variants mapped onto Elstar <Button> variants/colors. */
export function Button({
  variant = 'ghost',
  className = '',
  children,
  ...rest
}: { variant?: Variant } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const common = { size: 'sm' as const, className, ...rest }
  if (variant === 'accent') {
    return (
      <UiButton variant="solid" {...common}>
        {children}
      </UiButton>
    )
  }
  if (variant === 'danger') {
    return (
      <UiButton variant="solid" color="red-500" {...common}>
        {children}
      </UiButton>
    )
  }
  return (
    <UiButton variant="default" {...common}>
      {children}
    </UiButton>
  )
}

export function Card({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return <UiCard className={className}>{children}</UiCard>
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <Alert type="danger" showIcon rounded>
      {message}
    </Alert>
  )
}

export function Badge({
  children,
  tone = 'slate',
}: {
  children: ReactNode
  tone?: 'slate' | 'green' | 'red' | 'cyan' | 'amber'
}) {
  const tones: Record<string, string> = {
    slate: 'bg-gray-100 text-gray-600 dark:bg-gray-600/50 dark:text-gray-200',
    green: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-100',
    red: 'bg-red-100 text-red-600 dark:bg-red-500/20 dark:text-red-100',
    cyan: 'bg-primary-50 text-primary-600 dark:bg-primary-500/20 dark:text-primary-200',
    amber: 'bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-100',
  }
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${tones[tone]}`}
    >
      {children}
    </span>
  )
}

export function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return <Switcher checked={checked} disabled={disabled} onChange={(val) => onChange(val)} />
}

/**
 * Plugin glyph. Accepts either an SVG path `d` (starts with a path command) or
 * a short glyph/emoji string, so plugins can pick whichever is simpler.
 */
export function PluginIcon({
  icon,
  className = 'h-5 w-5',
}: {
  icon?: string
  className?: string
}) {
  const isPath = Boolean(icon && /^[Mm]/.test(icon.trim()))
  if (icon && isPath) {
    return (
      <svg
        className={className}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
      </svg>
    )
  }
  return (
    <span className={`inline-flex items-center justify-center ${className}`} aria-hidden="true">
      {icon || '◈'}
    </span>
  )
}
