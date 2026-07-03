/**
 * Presentational primitives for the Account/tenant pages.
 *
 * Re-skinned onto the Elstar design system: these wrappers keep their existing
 * prop contracts (so the tenant subpages don't change) but render Elstar
 * components (Card / Button / Input / Alert / Tag) underneath. Local to this
 * page.
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiRequestError, type TenantRole } from '@/api'
import {
  Alert,
  Button as UiButton,
  Card as UiCard,
  Input,
  Tag,
} from '@/ui'

export function errMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) return error.message
  if (error instanceof Error) return error.message
  return fallback
}

export function Loading({ label }: { label?: string }) {
  const { t } = useTranslation('account')
  return (
    <div className="px-5 py-10 text-center text-sm text-slate-500">
      {label ?? t('ui.loading')}
    </div>
  )
}

export function Empty({ label }: { label?: string }) {
  const { t } = useTranslation('account')
  return (
    <div className="px-5 py-10 text-center text-sm text-slate-500">
      {label ?? t('ui.empty')}
    </div>
  )
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <Alert type="warning" showIcon>
      {message}
    </Alert>
  )
}

export function Card({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <UiCard bordered className={className} bodyClass="p-5">
      {children}
    </UiCard>
  )
}

export function SectionTitle({
  title,
  subtitle,
  right,
}: {
  title: string
  subtitle?: string
  right?: ReactNode
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div>
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
      </div>
      {right}
    </div>
  )
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-300">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-500">{hint}</span>}
    </label>
  )
}

export function TextInput(
  props: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'>,
) {
  const { className = '', ...rest } = props
  return <Input {...rest} className={className} />
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = '', ...rest } = props
  return (
    <select
      {...rest}
      className={`input input-md h-11 bg-white ltr:pr-8 rtl:pl-8 focus:border-primary-500 focus:ring-primary-500 dark:bg-gray-700 ${className}`}
    />
  )
}

type Variant = 'accent' | 'ghost' | 'danger'

const VARIANT_PROPS: Record<
  Variant,
  { variant: 'solid' | 'default' | 'twoTone'; color?: string }
> = {
  accent: { variant: 'solid' },
  ghost: { variant: 'default' },
  danger: { variant: 'twoTone', color: 'red-600' },
}

export function Button({
  variant = 'ghost',
  className = '',
  ...rest
}: { variant?: Variant } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { variant: v, color } = VARIANT_PROPS[variant]
  return (
    <UiButton
      size="xs"
      variant={v}
      color={color}
      className={className}
      {...rest}
    />
  )
}

export function RoleBadge({ role }: { role: TenantRole | 'superadmin' }) {
  const { t } = useTranslation('account')
  const tones: Record<string, string> = {
    owner: 'border-transparent bg-primary-500/10 text-primary-500',
    editor: 'border-transparent bg-primary-500/10 text-primary-500',
    viewer: 'border-transparent bg-gray-100 text-gray-600 dark:bg-gray-600/60 dark:text-gray-100',
    superadmin: 'border-transparent bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-100',
  }
  return <Tag className={tones[role]}>{t(`roles.${role}`)}</Tag>
}

/** Usage vs limit bar. Turns amber ≥80% and red ≥100%. */
export function UsageBar({
  label,
  used,
  limit,
  unit,
}: {
  label: string
  used: number
  limit: number
  unit?: string
}) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
  const over = limit > 0 && used >= limit
  const near = !over && pct >= 80
  const bar = over ? 'bg-red-400' : near ? 'bg-amber-400' : 'bg-primary-500'
  const u = unit ? ` ${unit}` : ''
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="text-slate-300">{label}</span>
        <span className="font-mono text-slate-400">
          {used}
          {u} / {limit > 0 ? `${limit}${u}` : '∞'}
          {limit > 0 && <span className="ml-1 text-slate-500">({pct}%)</span>}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
        <div className={`h-full ${bar} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
