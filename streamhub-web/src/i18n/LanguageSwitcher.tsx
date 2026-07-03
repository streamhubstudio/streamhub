import { useTranslation } from 'react-i18next'
import { SUPPORTED_LNGS, type SupportedLng } from './index'

const LABELS: Record<SupportedLng, string> = {
  en: 'EN',
  es: 'ES',
}

/**
 * Compact ES/EN toggle. Drop it next to <ThemeToggle /> in the layout.
 * Uses i18n.changeLanguage; the choice is persisted to localStorage by the
 * language detector (key 'streamhub-lang').
 */
export function LanguageSwitcher({ className = '' }: { className?: string }) {
  const { i18n } = useTranslation()

  // Normalise e.g. "es-AR" -> "es" for active-state comparison.
  const current = (i18n.resolvedLanguage ?? i18n.language ?? 'en').split('-')[0]

  return (
    <div
      role="group"
      aria-label="Language"
      className={[
        'inline-flex h-9 items-center rounded-lg p-0.5',
        'ring-1 ring-navy-600',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {SUPPORTED_LNGS.map((lng) => {
        const active = current === lng
        return (
          <button
            key={lng}
            type="button"
            onClick={() => {
              if (!active) void i18n.changeLanguage(lng)
            }}
            aria-pressed={active}
            className={[
              'inline-flex h-8 min-w-8 items-center justify-center rounded-md px-2',
              'text-xs font-semibold transition',
              active
                ? 'bg-navy-700 text-slate-100'
                : 'text-slate-400 hover:text-slate-100',
            ].join(' ')}
          >
            {LABELS[lng]}
          </button>
        )
      })}
    </div>
  )
}
