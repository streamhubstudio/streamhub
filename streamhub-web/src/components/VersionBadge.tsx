/**
 * VersionBadge — "StreamHub v2.7.0" in the app footer.
 *
 * The version comes from the public bootstrap endpoint GET /auth/config
 * (`appVersion` — the repo-root VERSION file read by the core at boot), NOT
 * from any package.json. Shares the ['auth-config'] query key with the login
 * screen so the value is cached once per session. Renders nothing while
 * loading or against an older backend that doesn't send the field — the
 * footer just stays as it was. Links to the changelog in a new tab.
 */
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/api'
import { CHANGELOG_URL } from '@/lib/links'

export function VersionBadge({ className = '' }: { className?: string }) {
  const { t } = useTranslation('shell')
  const { data } = useQuery({
    queryKey: ['auth-config'],
    queryFn: ({ signal }) => api.auth.config(signal),
    staleTime: 5 * 60_000,
  })

  const version = data?.appVersion?.trim()
  if (!version) return null

  return (
    <a
      href={CHANGELOG_URL}
      target="_blank"
      rel="noopener noreferrer"
      title={t('layout.changelog')}
      className={['font-mono tabular-nums transition hover:text-fg', className]
        .filter(Boolean)
        .join(' ')}
    >
      {`StreamHub v${version}`}
    </a>
  )
}
