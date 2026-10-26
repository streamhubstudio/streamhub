/**
 * SetupWizardBanner — the re-entry point for the onboarding wizard, shown on an
 * app's Overview (Tablero) while its onboarding is still unresolved (neither
 * completed nor dismissed). Reads the state from the app's config.yaml
 * `onboarding:` block (best-effort: a read failure — e.g. a viewer without
 * `config:read` — simply hides the banner).
 *
 * Opening the wizard here is always available; finishing or dismissing it
 * invalidates the query so the banner disappears.
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Card } from '@/ui'
import { useAuth } from '@/auth/useAuth'
import { isOnboardingResolved } from '@/lib/onboarding'
import { loadOnboarding } from './runner'
import { OnboardingWizard } from './OnboardingWizard'

export function SetupWizardBanner({ app }: { app: string }) {
  const { t } = useTranslation('onboarding')
  const { canEdit } = useAuth()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)

  const { data, isSuccess } = useQuery({
    queryKey: ['app-onboarding', app],
    queryFn: ({ signal }) => loadOnboarding(app, signal),
    // Best-effort background read; don't retry-storm on a 403.
    retry: false,
    staleTime: 30_000,
  })

  function close() {
    setOpen(false)
    qc.invalidateQueries({ queryKey: ['app-onboarding', app] })
  }

  // Only prompt when we could positively read the state AND it's unresolved.
  const show = canEdit && isSuccess && !isOnboardingResolved(data)
  if (!show && !open) return null

  return (
    <>
      {show && (
        <Card
          bordered
          className="border-primary-500/30 bg-primary-500/5"
          bodyClass="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-fg">{t('banner.title', { app })}</h3>
            <p className="mt-0.5 text-xs text-slate-400">{t('banner.body')}</p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            data-testid="setup-wizard-cta"
            className="btn-accent shrink-0 self-start rounded-lg px-4 py-2 text-xs font-semibold sm:self-auto"
          >
            {t('banner.cta')}
          </button>
        </Card>
      )}
      {open && <OnboardingWizard app={app} onClose={close} />}
    </>
  )
}
