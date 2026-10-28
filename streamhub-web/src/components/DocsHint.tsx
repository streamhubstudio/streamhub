/**
 * DocsHint — the dashboard's contextual "?" help affordance.
 *
 * Renders a subtle external link to the matching page on the public docs site
 * (https://streamhub.studio/docs — see lib/links.ts DOCS_URL for why not the
 * docs.streamhub.studio subdomain). The target is resolved through the single
 * section → docs-path map in `@/lib/docs`, so every surface links consistently
 * and adding a hint is `<DocsHint section="streams" />`. Opens in a new tab
 * (`noopener` — never hand the opener to another origin).
 *
 * Two shapes:
 *  - icon-only (default): a small question-mark next to a title/caption;
 *  - `showLabel`: icon + "Learn more ↗" text, for tab captions.
 */
import { useTranslation } from 'react-i18next'
import { HiOutlineQuestionMarkCircle } from 'react-icons/hi'
import { docsUrl, type DocsSection } from '@/lib/docs'

export function DocsHint({
  section,
  showLabel = false,
  className = '',
}: {
  /** Key into DOCS_PATHS (@/lib/docs) — the docs page to deep-link. */
  section: DocsSection
  /** Also render the "Learn more ↗" text (default: icon only). */
  showLabel?: boolean
  className?: string
}) {
  const { t } = useTranslation('common')
  const label = t('docsHint.learnMore')
  return (
    <a
      href={docsUrl(section)}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      aria-label={label}
      data-docs-section={section}
      className={[
        'inline-flex items-center gap-1 align-middle text-fg-subtle transition',
        'hover:text-primary-400',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <HiOutlineQuestionMarkCircle aria-hidden className="text-base" />
      {showLabel && (
        <span className="text-xs whitespace-nowrap">{label} ↗</span>
      )}
    </a>
  )
}
