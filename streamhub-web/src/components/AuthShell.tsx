/**
 * Auth screen chrome — the StreamHub re-skin of Elstar's "SignInCover" layout.
 *
 * Wraps every auth form in the ported `<Cover>` (split screen: brand gradient
 * panel on the left ≥lg, form panel on the right). Adds the theme toggle and a
 * mobile-only logo (the brand panel — and its logo — is hidden below lg). It is
 * pure chrome: it owns no auth logic, it just frames whatever form you pass in.
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Cover } from '@/layout/AuthLayout'
import { ThemeToggle } from '@/theme'
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher'
import { Logo } from '@/components/Logo'

export function AuthShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation('auth')
  return (
    <div className="relative min-h-dvh">
      <div className="absolute right-4 top-4 z-20 flex items-center gap-2">
        <LanguageSwitcher />
        <ThemeToggle />
      </div>
      <Cover
        className="min-h-dvh"
        panelTitle={t('panel.title')}
        panelText={t('panel.text')}
      >
        {/* Logo only where the brand panel (which carries the logo) is hidden. */}
        <div className="mb-8 lg:hidden">
          <Logo className="h-12 w-auto" />
        </div>
        {children}
      </Cover>
    </div>
  )
}

/** Per-state heading (title + optional subtitle) above an auth form. */
export function AuthHeading({
  title,
  subtitle,
}: {
  title: ReactNode
  subtitle?: ReactNode
}) {
  return (
    <div className="mb-8">
      <h3 className="mb-1 text-2xl font-bold text-fg">{title}</h3>
      {subtitle && <p className="text-fg-muted">{subtitle}</p>}
    </div>
  )
}
