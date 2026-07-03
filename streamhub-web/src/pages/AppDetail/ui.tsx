/**
 * Shared presentational primitives for the AppDetail tabs.
 *
 * RE-SKIN: these primitives now wrap the ported **Elstar** design system
 * (`@/ui`) so every AppDetail tab adopts the Elstar look (Card/Button/Table/
 * Input/Switcher/Tag) without any tab having to change. The public signatures
 * are intentionally unchanged — tabs keep calling `<Card>`, `<Button variant>`,
 * `<RTable>`, `<TextInput>`, `<Toggle>`, `<Badge tone>` exactly as before.
 *
 * Accent resolves to the StreamHub brand (`primary-*` → #2f7bff); light/dark is
 * automatic via the `.dark` class. See src/ui/MIGRATION.md.
 *
 * Owned by the AppDetail agent — do not import outside this page.
 */
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiRequestError } from '@/api'
import {
  Card as UICard,
  Button as UIButton,
  Tag,
  Switcher,
  Input,
} from '@/ui'

// --- error helper -----------------------------------------------------------

export function errMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) return error.message
  if (error instanceof Error) return error.message
  return fallback
}

// --- state blocks -----------------------------------------------------------

export function Loading({ label }: { label?: string }) {
  const { t } = useTranslation('appDetail')
  return (
    <div className="px-5 py-10 text-center text-sm text-fg-subtle">
      {label ?? t('state.loadingDefault')}
    </div>
  )
}

export function Empty({ label }: { label?: string }) {
  const { t } = useTranslation('appDetail')
  return (
    <div className="px-5 py-10 text-center text-sm text-fg-subtle">
      {label ?? t('state.emptyDefault')}
    </div>
  )
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg bg-yellow-50 px-4 py-3 text-sm font-medium text-yellow-700 dark:bg-yellow-500/15 dark:text-yellow-100">
      {message}
    </div>
  )
}

// --- layout -----------------------------------------------------------------

/** Elstar Card — the app's frosted "glass" panel is now the Elstar surface. */
export function Card({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return <UICard className={className}>{children}</UICard>
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
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {title}
        </h3>
        {subtitle && (
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {subtitle}
          </p>
        )}
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
      <span className="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-100">
        {label}
      </span>
      {children}
      {hint && (
        <span className="mt-1 block text-[11px] text-gray-500 dark:text-gray-400">
          {hint}
        </span>
      )}
    </label>
  )
}

// --- inputs -----------------------------------------------------------------

/**
 * Native `<select>` styled to match the Elstar `.input` look (kept native so
 * tabs can keep passing `<option>` children — no react-select migration).
 */
// Mirrors the Elstar `.input` look but WITHOUT `appearance-none`, so the native
// select keeps its dropdown arrow.
const selectClass =
  'h-9 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 transition duration-150 ease-in-out focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500 dark:border-gray-600 dark:bg-transparent dark:text-gray-100'

export function TextInput(
  props: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'>,
) {
  const { className = '', ...rest } = props
  return <Input size="sm" className={className} {...rest} />
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = '', ...rest } = props
  return <select {...rest} className={`${selectClass} ${className}`} />
}

// --- buttons ----------------------------------------------------------------

type Variant = 'accent' | 'ghost' | 'danger'

/** Map the AppDetail button intents onto the Elstar `<Button>` variants. */
const variantProps: Record<
  Variant,
  { variant: 'solid' | 'twoTone' | 'default'; color?: string }
> = {
  accent: { variant: 'solid' }, // brand primary (#2f7bff)
  ghost: { variant: 'default' },
  danger: { variant: 'twoTone', color: 'red-600' },
}

export function Button({
  variant = 'ghost',
  className = '',
  type,
  ...rest
}: { variant?: Variant } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const v = variantProps[variant]
  return (
    <UIButton
      size="sm"
      variant={v.variant}
      color={v.color}
      type={type}
      className={`max-md:min-h-[40px] ${className}`}
      {...rest}
    />
  )
}

// --- responsive table -------------------------------------------------------
// On mobile (<md) a wide data table is unusable: instead of a horizontal
// scroller each row collapses into a stacked "label: value" card. From md up it
// renders as a normal <table> with the Elstar table look (gray thead, uppercase
// headers, hover rows). The per-cell label comes from RTd's `label` prop
// (surfaced via `data-label` + a `::before` on mobile only).

export function RTable({
  head,
  children,
}: {
  head: ReactNode
  children: ReactNode
}) {
  return (
    <div className="md:overflow-x-auto">
      <table className="w-full min-w-full text-left text-sm max-md:block">
        <thead className="bg-gray-50 text-[11px] uppercase tracking-wider text-gray-500 dark:bg-gray-700 dark:text-gray-100 max-md:hidden">
          {head}
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700 max-md:block max-md:space-y-3 max-md:divide-none max-md:p-1">
          {children}
        </tbody>
      </table>
    </div>
  )
}

export function RTh({
  children,
  className = '',
}: {
  children?: ReactNode
  className?: string
}) {
  return (
    <th className={`px-4 py-3 font-semibold ${className}`}>{children}</th>
  )
}

export function RTr({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <tr
      className={`max-md:block max-md:rounded-lg max-md:border max-md:border-gray-200 max-md:bg-gray-50 max-md:p-4 max-md:dark:border-gray-600 max-md:dark:bg-gray-700/40 md:hover:bg-gray-100/50 md:dark:hover:bg-gray-700/40 ${className}`}
    >
      {children}
    </tr>
  )
}

export function RTd({
  label,
  children,
  className = '',
  actions = false,
}: {
  /** Mobile-only column label; omit for the actions cell. */
  label?: string
  children?: ReactNode
  className?: string
  /** Renders the cell as a full-width action bar under the card on mobile. */
  actions?: boolean
}) {
  return (
    <td
      data-label={label}
      className={[
        'px-4 py-3 align-middle',
        'max-md:flex max-md:min-w-0 max-md:items-center max-md:gap-3 max-md:px-0 max-md:py-1.5',
        label
          ? 'max-md:justify-between max-md:before:shrink-0 max-md:before:text-[11px] max-md:before:font-semibold max-md:before:uppercase max-md:before:tracking-wider max-md:before:text-gray-500 max-md:before:content-[attr(data-label)] max-md:dark:before:text-gray-400'
          : '',
        actions
          ? 'max-md:mt-1 max-md:justify-end max-md:border-t max-md:border-gray-200 max-md:pt-3 max-md:dark:border-gray-600'
          : '',
        className,
      ].join(' ')}
    >
      {children}
    </td>
  )
}

// --- toggle -----------------------------------------------------------------

/**
 * Elstar `<Switcher>` adapted to the simple controlled `(value) => void` API
 * the tabs use. Elstar's Switcher, when `checked` is supplied, reports the
 * *current* value in its onChange (it's built for Formik `field`), so we ignore
 * its argument and derive the next value from the `checked` prop we own.
 */
export function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <Switcher
      checked={checked}
      disabled={disabled}
      onChange={() => onChange(!checked)}
    />
  )
}

// --- badge ------------------------------------------------------------------

/** Pill label — the Elstar `<Tag>`, tinted per tone. */
export function Badge({
  children,
  tone = 'slate',
}: {
  children: ReactNode
  tone?: 'slate' | 'green' | 'red' | 'cyan' | 'amber'
}) {
  const tones: Record<string, string> = {
    slate:
      'border-transparent bg-gray-100 text-gray-600 dark:bg-gray-600/60 dark:text-gray-100',
    green:
      'border-transparent bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-100',
    red: 'border-transparent bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-100',
    cyan: 'border-transparent bg-primary-50 text-primary-600 dark:bg-primary-500/20 dark:text-primary-100',
    amber:
      'border-transparent bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-100',
  }
  return <Tag className={`py-0.5 ${tones[tone]}`}>{children}</Tag>
}

// --- copy-to-clipboard ------------------------------------------------------

function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copy = useCallback((text: string) => {
    const done = () => {
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => done())
    } else {
      done()
    }
  }, [])
  return [copied, copy]
}

export function CopyButton({ value }: { value: string }) {
  const { t } = useTranslation('common')
  const [copied, copy] = useCopy()
  return (
    <Button variant="ghost" onClick={() => copy(value)} className="shrink-0">
      {copied ? t('actions.copied') : t('actions.copy')}
    </Button>
  )
}

/** Read-only labelled value with a copy button — used for secrets/URLs. */
export function CopyField({
  label,
  value,
  mono = true,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div>
      <span className="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-100">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <Input
          readOnly
          size="sm"
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className={mono ? 'font-mono text-xs' : ''}
        />
        <CopyButton value={value} />
      </div>
    </div>
  )
}
