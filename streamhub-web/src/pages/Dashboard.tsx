/**
 * Dashboard — server health banner, live resource/usage metric cards, and an
 * apps overview table. Data via @tanstack/react-query + the typed `api` client;
 * health/stats poll every 12s, apps every 30s. Follows the pattern in Logs.tsx.
 *
 * Composed from local components under ./Dashboard/.
 */
import { useTranslation } from 'react-i18next'
import { HealthBanner } from './Dashboard/HealthBanner'
import { StatsGrid } from './Dashboard/StatsGrid'
import { AppsTable } from './Dashboard/AppsTable'

export default function Dashboard() {
  const { t } = useTranslation('dashboard')
  return (
    <div className="space-y-7">
      <div>
        <h1 className="text-2xl font-semibold text-fg">{t('page.title')}</h1>
        <p className="text-sm text-slate-400">{t('page.subtitle')}</p>
      </div>

      <HealthBanner />
      <StatsGrid />
      <AppsTable />
    </div>
  )
}
