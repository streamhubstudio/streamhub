/**
 * Authenticated shell — the "Control Room" console chrome: a collapsible
 * left rail (full ⇄ icon rail) on the darkest surface, a sticky header with
 * the sidebar toggle, language switch and a user dropdown, and the running
 * version always visible (sidebar footer; top bar under lg) as the entry to
 * the About / Build panel. On < lg the sidebar collapses into a Drawer.
 *
 * This is CHROME ONLY: it wraps the existing <Outlet/> untouched — routes,
 * data-layer, auth and plugins are unchanged. Dark only: the semantic tokens
 * in index.css drive the colours; the active nav row carries the cyan
 * "selected source" bar; ported primitives (Avatar, Dropdown, Drawer) come
 * from `@/ui`.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  HiOutlineChartSquareBar,
  HiOutlineViewBoards,
  HiOutlinePuzzle,
  HiOutlineDocumentText,
  HiOutlineServer,
  HiOutlineTrendingUp,
  HiOutlineCog,
  HiOutlineClipboardList,
  HiOutlineShieldCheck,
  HiOutlineUserCircle,
  HiOutlineMenuAlt2,
  HiOutlineLogout,
  HiOutlineChevronDown,
  HiOutlineX,
} from 'react-icons/hi'
import { useAuth } from '@/auth/useAuth'
import { LanguageSwitcher } from '@/i18n'
import { Logo } from '@/components/Logo'
import { VersionBadge } from '@/components/VersionBadge'
import { Avatar, Dropdown, Drawer } from '@/ui'
import { DOCS_URL, REPO_URL } from '@/lib/links'
import { StudioLauncher } from './StudioLauncher'

interface NavItem {
  to: string
  /** i18n key under the `shell:nav` section. */
  labelKey: string
  icon: ReactNode
  end?: boolean
  /** Only rendered for a superadmin (global-scope) principal. */
  superadminOnly?: boolean
}

// "Transmitir" (Broadcast) is intentionally NOT here: it is a per-app action,
// launched from inside the app (AppDetail header / Live tab). The /broadcast/:app
// route still exists — only the global menu entry was removed.
const NAV: NavItem[] = [
  { to: '/', labelKey: 'nav.dashboard', end: true, icon: <HiOutlineChartSquareBar /> },
  { to: '/apps', labelKey: 'nav.apps', icon: <HiOutlineViewBoards /> },
  { to: '/studio', labelKey: 'nav.plugins', icon: <HiOutlinePuzzle /> },
  { to: '/cluster', labelKey: 'nav.cluster', icon: <HiOutlineServer /> },
  { to: '/logs', labelKey: 'nav.logs', icon: <HiOutlineDocumentText /> },
  { to: '/resources', labelKey: 'nav.resources', icon: <HiOutlineTrendingUp />, superadminOnly: true },
  { to: '/settings', labelKey: 'nav.serverSettings', icon: <HiOutlineCog />, superadminOnly: true },
  { to: '/audit', labelKey: 'nav.audit', icon: <HiOutlineClipboardList />, superadminOnly: true },
  { to: '/compliance', labelKey: 'nav.compliance', icon: <HiOutlineShieldCheck />, superadminOnly: true },
  { to: '/account', labelKey: 'nav.account', icon: <HiOutlineUserCircle /> },
]

const ROLE_KEYS = new Set(['owner', 'editor', 'viewer', 'superadmin'])
const SIDEBAR_KEY = 'streamhub-sidebar-collapsed'

function navRowClass({ isActive }: { isActive: boolean }, collapsed: boolean) {
  return [
    'relative flex min-h-[40px] items-center rounded-control text-sm font-medium transition-colors',
    collapsed ? 'justify-center px-0' : 'gap-3 px-3',
    'py-2',
    isActive
      ? "bg-surface-raised text-fg before:absolute before:inset-y-2 before:-left-3 before:w-[3px] before:rounded-r-full before:bg-sky2 before:content-['']"
      : 'text-fg-muted hover:bg-surface-raised/60 hover:text-fg',
  ].join(' ')
}

/** Shared nav list, used by the desktop rail and the mobile Drawer. */
function NavList({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean
  onNavigate?: () => void
}) {
  const { t } = useTranslation('shell')
  const { isSuperadmin } = useAuth()
  const items = NAV.filter((item) => !item.superadminOnly || isSuperadmin)
  return (
    <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          title={collapsed ? t(item.labelKey) : undefined}
          className={(state) => navRowClass(state, collapsed)}
        >
          <span className="shrink-0 text-lg">{item.icon}</span>
          {!collapsed && <span className="truncate">{t(item.labelKey)}</span>}
        </NavLink>
      ))}
    </nav>
  )
}

/** Avatar + email + role, in a click dropdown (account / logout). */
function UserMenu() {
  const { logout, identity, role, canEdit } = useAuth()
  const navigate = useNavigate()
  const { t } = useTranslation('shell')

  const label = identity?.email || identity?.name || t('layout.session')
  const initial = (label || '?').trim().charAt(0).toUpperCase()

  function handleLogout() {
    logout()
    navigate('/login', { replace: true })
  }

  const title = (
    <button
      type="button"
      className="flex items-center gap-2 rounded-lg py-1 pr-2 pl-1 text-fg transition hover:bg-surface-raised"
    >
      <Avatar size={30} shape="circle" className="bg-primary-500 text-white!">
        {initial}
      </Avatar>
      <span className="hidden max-w-[10rem] truncate text-sm font-medium sm:block">
        {label}
      </span>
      <HiOutlineChevronDown className="text-fg-subtle" />
    </button>
  )

  return (
    <Dropdown placement="bottom-end" renderTitle={title} menuClass="min-w-[13rem]">
      <Dropdown.Item variant="header">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-fg">{label}</div>
          <div className="mt-0.5 flex items-center gap-1.5">
            {role && (
              <span className="rounded-full bg-surface-raised px-2 py-0.5 text-[10px] font-medium text-fg-muted">
                {ROLE_KEYS.has(role) ? t(`role.${role}`) : role}
              </span>
            )}
            {!canEdit && (
              <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[10px] font-medium text-warn">
                {t('layout.readOnly')}
              </span>
            )}
          </div>
        </div>
      </Dropdown.Item>
      <Dropdown.Item variant="divider" />
      <Dropdown.Item eventKey="account" onSelect={() => navigate('/account')}>
        <HiOutlineUserCircle className="text-lg" />
        <span>{t('layout.account')}</span>
      </Dropdown.Item>
      <Dropdown.Item eventKey="logout" onSelect={handleLogout}>
        <HiOutlineLogout className="text-lg" />
        <span>{t('layout.logout')}</span>
      </Dropdown.Item>
    </Dropdown>
  )
}

export function AppLayout() {
  const { t } = useTranslation('shell')
  const location = useLocation()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === '1'
    } catch {
      return false
    }
  })

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setDrawerOpen(false)
  }, [location.pathname])

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0')
      } catch {
        /* ignore */
      }
      return next
    })
  }

  return (
    <div className="flex min-h-full">
      {/* Desktop sidebar (>=lg) — collapsible full ⇄ icon rail. */}
      <aside
        className={[
          'hidden shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200 ease-in-out lg:flex',
          collapsed ? 'w-20' : 'w-64',
        ].join(' ')}
      >
        <div
          className={[
            'flex h-16 items-center border-b border-border',
            collapsed ? 'justify-center px-0' : 'px-5',
          ].join(' ')}
        >
          <NavLink to="/" aria-label="StreamHub">
            {collapsed ? (
              <img src="/favicon.svg" alt="StreamHub" className="h-8 w-8" />
            ) : (
              <Logo className="h-9 w-auto" />
            )}
          </NavLink>
        </div>
        <NavList collapsed={collapsed} />
        {/* Running version — always visible; opens About / Build. */}
        <div className="border-t border-border p-3">
          <VersionBadge variant="slate" collapsed={collapsed} />
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-2 border-b border-border bg-bg/90 px-4 backdrop-blur sm:px-6">
          <div className="flex items-center gap-2">
            {/* Desktop collapse toggle */}
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={collapsed ? t('layout.expand') : t('layout.collapse')}
              className="hidden h-10 w-10 items-center justify-center rounded-lg text-fg-muted transition hover:bg-surface-raised hover:text-fg lg:inline-flex"
            >
              <HiOutlineMenuAlt2 className="text-xl" />
            </button>
            {/* Mobile hamburger + logo */}
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label={t('layout.openMenu')}
              aria-expanded={drawerOpen}
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-fg-muted transition hover:bg-surface-raised hover:text-fg lg:hidden"
            >
              <HiOutlineMenuAlt2 className="text-xl" />
            </button>
            <NavLink to="/" className="lg:hidden" aria-label="StreamHub">
              {/* Phones: mark only, so the version chip always fits. */}
              <img src="/favicon.svg" alt="" className="h-7 w-auto sm:hidden" />
              <span className="hidden sm:inline">
                <Logo className="h-7 w-auto" />
              </span>
            </NavLink>
          </div>

          <div className="flex items-center gap-2">
            {/* Sidebar (and its version slate) is hidden under lg. */}
            <VersionBadge variant="chip" className="lg:hidden" />
            <StudioLauncher />
            <LanguageSwitcher />
            <div className="mx-1 hidden h-6 w-px bg-border sm:block" />
            <UserMenu />
          </div>
        </header>

        <main className="mx-auto w-full min-w-0 max-w-7xl flex-1 p-4 sm:p-6 lg:p-8">
          <Outlet />
        </main>

        <footer className="flex flex-col gap-2 border-t border-border px-4 py-4 text-xs text-fg-subtle sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{t('layout.footer')}</span>
          </div>
          <nav className="flex items-center gap-4">
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="transition hover:text-fg"
            >
              {t('layout.docs')}
            </a>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="transition hover:text-fg"
            >
              {t('layout.source')}
            </a>
          </nav>
        </footer>
      </div>

      {/* Mobile navigation Drawer (<lg). */}
      <Drawer
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onRequestClose={() => setDrawerOpen(false)}
        placement="left"
        width={280}
        ariaHideApp={false}
        lockScroll
        title={<Logo className="h-8 w-auto" />}
        bodyClass="p-0"
        closable
      >
        <div className="flex h-full flex-col">
          <NavList collapsed={false} onNavigate={() => setDrawerOpen(false)} />
          <div className="border-t border-border px-3 pt-3">
            <VersionBadge variant="slate" />
          </div>
          <div className="flex items-center justify-between gap-2 px-4 py-4">
            <LanguageSwitcher />
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label={t('layout.closeMenu')}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-fg-muted transition hover:bg-surface-raised hover:text-fg"
            >
              <HiOutlineX />
            </button>
          </div>
        </div>
      </Drawer>
    </div>
  )
}
