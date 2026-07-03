/**
 * Mi cuenta — self-service account panel.
 *
 *  - "Perfil": my own profile (name/email) + the tenant/role of the session
 *    (GET/PATCH /account).
 *  - "Seguridad": password change + 2FA (TOTP) enrolment/disable.
 *  - "Equipo": my tenant + quota usage + members + email invitations
 *    (GET /teams/mine, /tenant/invites — owner-only mutations).
 *  - "Plataforma" (superadmin only): all tenants + quota management.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/useAuth'
import { ProfileCard } from './Account/ProfileCard'
import { SecurityCard } from './Account/SecurityCard'
import { TeamCard } from './Account/TeamCard'
import { SuperadminTenants } from './Account/SuperadminTenants'
import { RoleBadge } from './Account/ui'

type TabId = 'profile' | 'security' | 'team' | 'platform'

export default function Account() {
  const { t } = useTranslation('account')
  const {
    identity,
    role,
    isSuperadmin,
    canManageTenant,
    currentTenant,
    setCurrentTenant,
  } = useAuth()

  const tabs = useMemo(() => {
    const base: { id: TabId; label: string }[] = [
      { id: 'profile', label: t('tabs.profile') },
      { id: 'security', label: t('tabs.security') },
      { id: 'team', label: t('tabs.team') },
    ]
    if (isSuperadmin) base.push({ id: 'platform', label: t('tabs.platform') })
    return base
  }, [isSuperadmin, t])

  const [active, setActive] = useState<TabId>('profile')

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-fg">{t('title')}</h1>
          <p className="text-sm text-slate-400">
            {identity?.email || identity?.name || t('sessionActive')}
          </p>
        </div>
        {role && (
          <span className="mt-1">
            <RoleBadge role={role} />
          </span>
        )}
      </div>

      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-gray-200 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:flex-wrap md:overflow-visible dark:border-gray-700">
        {tabs.map((tab) => {
          const isActive = tab.id === active
          return (
            <button
              key={tab.id}
              onClick={() => setActive(tab.id)}
              className={[
                '-mb-px shrink-0 whitespace-nowrap rounded-t-lg px-4 py-2 text-sm transition',
                isActive
                  ? 'border-b-2 border-primary-500 font-semibold text-primary-500'
                  : 'border-b-2 border-transparent text-slate-400 hover:text-fg',
              ].join(' ')}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      {active === 'profile' && <ProfileCard />}
      {active === 'security' && <SecurityCard />}
      {active === 'team' && (
        <TeamCard canManage={canManageTenant} selfId={identity?.sub} />
      )}
      {active === 'platform' && isSuperadmin && (
        <SuperadminTenants
          selectedId={currentTenant}
          onSelect={setCurrentTenant}
        />
      )}
    </div>
  )
}
