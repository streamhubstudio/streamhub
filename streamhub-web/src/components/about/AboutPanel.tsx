/**
 * About / Build panel — opened from the version badge (sidebar footer / top
 * bar). One place to answer "what exactly is running here?":
 *   - the product version (big, it's what support asks for first);
 *   - the core build: commit, build date, dirty tree, Go toolchain
 *     (GET /system/build — runtime.Version + debug.ReadBuildInfo);
 *   - the dashboard build: version/commit/date + the Node/Vite/React that
 *     produced the bundle (vite `define`, see vite.config.ts) — with a warning
 *     when the SPA and the core come from different commits;
 *   - the changelog (GET /system/changelog, embedded in the core), newest
 *     first, one collapsible section per release, the running one open and
 *     marked.
 * Everything renders as text (safe markdown AST, no HTML injection).
 */
import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { HiOutlineChevronRight, HiOutlineClipboardCopy, HiOutlineCheck } from 'react-icons/hi'
import { api } from '@/api'
import type { CoreBuildInfo } from '@/api'
import { Drawer } from '@/ui'
import { Markdown } from '@/components/Markdown'
import { parseChangelog, normalizeVersion, type ChangelogRelease } from '@/lib/changelog'
import { bareVersion, buildsDiverge, shortCommit, webBuild, type WebBuildInfo } from '@/lib/buildInfo'
import { formatDateTime } from '@/lib/datetime'
import { CHANGELOG_URL } from '@/lib/links'

const STALE = 10 * 60_000

function Row({ label, children, mono }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-2 last:border-b-0">
      <dt className="shrink-0 text-xs text-fg-subtle">{label}</dt>
      <dd className={`min-w-0 truncate text-right text-sm text-fg ${mono ? 'font-mono text-[0.8rem]' : ''}`}>{children}</dd>
    </div>
  )
}

function Section({ title, children, aside }: { title: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="mt-7">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

function dash(v: string | null | undefined) {
  return v && v.trim() ? v : '—'
}

function when(iso: string | null | undefined) {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : formatDateTime(d)
}

function supportText(version: string, core: CoreBuildInfo | undefined, web: WebBuildInfo) {
  const lines = [
    `StreamHub ${version || '?'}`,
    core
      ? `core: commit ${core.commit || '?'}${core.dirty ? ' (modified)' : ''}, built ${core.buildDate || '?'}, ${core.toolchain.goVersion} ${core.toolchain.goos}/${core.toolchain.goarch}`
      : 'core: build info unavailable',
    `web: ${web.version || '?'} commit ${web.commit || '?'}, built ${web.builtAt || '?'}, node ${web.node || '?'}, vite ${web.vite || '?'}, react ${web.react || '?'}`,
  ]
  return lines.join('\n')
}

function Release({ rel, running, open, onToggle }: { rel: ChangelogRelease; running: boolean; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation('about')
  const id = `rel-${rel.version.replace(/[^\w-]/g, '_')}`
  const date = rel.title.replace(rel.version, '').replace(/^[\s—–-]+/, '').trim()
  return (
    <li className={`rounded-control border ${running ? 'border-sky2/50 bg-sky2/[0.04]' : 'border-border'}`}>
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={onToggle}
          className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
        >
          <HiOutlineChevronRight
            aria-hidden="true"
            className={`shrink-0 text-fg-subtle transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
          />
          <span className="font-mono text-sm font-semibold text-fg tabular-nums">{rel.semver ? `v${rel.version}` : rel.version}</span>
          {date && <span className="text-xs text-fg-subtle">{date}</span>}
          {running && (
            <span className="ml-auto inline-flex items-center gap-1.5 rounded-chip bg-sky2/10 px-2 py-0.5 text-[11px] font-medium text-sky2">
              <span className="tally text-sky2" aria-hidden="true" />
              {t('changelog.running')}
            </span>
          )}
        </button>
      </h3>
      {open && (
        <div id={id} className="border-t border-border/70 px-4 pb-3 pt-2">
          {rel.body ? <Markdown source={rel.body} /> : <p className="text-sm text-fg-subtle">{t('changelog.emptyRelease')}</p>}
        </div>
      )}
    </li>
  )
}

export function ChangelogList({ markdown, running }: { markdown: string; running: string }) {
  const { t } = useTranslation('about')
  const log = useMemo(() => parseChangelog(markdown), [markdown])
  const current = normalizeVersion(running)
  const [open, setOpen] = useState<Set<string>>(() => {
    const has = log.releases.some((r) => r.version === current)
    return new Set([has ? current : (log.releases.find((r) => r.semver)?.version ?? '')])
  })
  const [all, setAll] = useState(false)
  if (!log.releases.length) return <p className="text-sm text-fg-subtle">{t('changelog.unavailable')}</p>
  const shown = all ? log.releases : log.releases.slice(0, 12)
  const toggle = (v: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(v)) next.delete(v)
      else next.add(v)
      return next
    })
  return (
    <>
      <ol className="space-y-1.5" aria-label={t('changelog.title')}>
        {shown.map((r) => (
          <Release key={r.title} rel={r} running={r.version === current} open={open.has(r.version)} onToggle={() => toggle(r.version)} />
        ))}
      </ol>
      {!all && log.releases.length > shown.length && (
        <button type="button" onClick={() => setAll(true)} className="mt-3 text-sm font-medium text-primary-400 hover:text-primary-300">
          {t('changelog.showAll', { count: log.releases.length })}
        </button>
      )}
    </>
  )
}

export function AboutPanel({ isOpen, onClose, appVersion }: { isOpen: boolean; onClose: () => void; appVersion?: string }) {
  const { t } = useTranslation('about')
  const web = webBuild()
  const build = useQuery({
    queryKey: ['system-build'],
    queryFn: ({ signal }) => api.system.build(signal),
    staleTime: STALE,
    retry: false,
    enabled: isOpen,
  })
  const changelog = useQuery({
    queryKey: ['system-changelog'],
    queryFn: ({ signal }) => api.system.changelog(signal),
    staleTime: Infinity,
    retry: false,
    enabled: isOpen,
  })
  const [copied, setCopied] = useState(false)

  const core = build.data
  const version = normalizeVersion(core?.version || appVersion || web.version)
  const diverge = buildsDiverge(core, web)
  // clientWidth, not innerWidth: a page that overflows sideways on a phone
  // inflates innerWidth and the drawer would run off-screen.
  const width = typeof document === 'undefined' ? 640 : Math.min(680, document.documentElement.clientWidth || 680)

  async function copy() {
    try {
      await navigator.clipboard.writeText(supportText(version, core, web))
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard blocked — nothing to do */
    }
  }

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      onRequestClose={onClose}
      placement="right"
      width={width}
      ariaHideApp={false}
      lockScroll
      closable
      title={<span className="text-base font-semibold text-fg">{t('title')}</span>}
      contentLabel={t('title')}
    >
      {/* The slate: product + version, the one thing support always asks for. */}
      <div className="rounded-panel border border-border bg-surface-sunken p-5" data-testid="about-slate">
        <div className="flex items-center gap-2 text-xs text-fg-subtle">
          <span className="tally text-success" aria-hidden="true" />
          <span>{t('slate.running')}</span>
        </div>
        <p className="mt-2 font-mono text-4xl font-semibold tracking-tight text-fg tabular-nums">
          {version ? `v${version}` : '—'}
        </p>
        <dl className="mt-4 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
          <Row label={t('core.commit')} mono>
            <span title={core?.commit || undefined}>{dash(shortCommit(core?.commit))}</span>
            {core?.dirty && <span className="ml-2 text-warn">{t('core.modified')}</span>}
          </Row>
          <Row label={t('core.built')}>{when(core?.buildDate)}</Row>
        </dl>
        <button
          type="button"
          onClick={copy}
          className="mt-4 inline-flex items-center gap-1.5 rounded-control border border-border-strong px-2.5 py-1.5 text-xs font-medium text-fg-muted transition hover:bg-surface-raised hover:text-fg"
        >
          {copied ? <HiOutlineCheck aria-hidden="true" /> : <HiOutlineClipboardCopy aria-hidden="true" />}
          {copied ? t('copied') : t('copy')}
        </button>
      </div>

      {build.isError && (
        <p role="status" className="mt-4 rounded-control border border-border bg-surface-raised px-3 py-2 text-sm text-fg-muted">
          {t('core.unavailable')}
        </p>
      )}
      {diverge && (
        <p role="alert" className="mt-4 rounded-control border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
          {t('diverge', { web: shortCommit(web.commit), core: shortCommit(core?.commit) })}
        </p>
      )}

      <Section title={t('toolchain.title')}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-panel border border-border p-4">
            <h4 className="mb-1 text-xs font-medium text-fg-muted">{t('toolchain.core')}</h4>
            <dl>
              <Row label="Go" mono>{dash(core ? bareVersion(core.toolchain.goVersion) : '')}</Row>
              <Row label={t('toolchain.target')} mono>{core ? `${core.toolchain.goos}/${core.toolchain.goarch}` : '—'}</Row>
              <Row label="CGO" mono>{dash(core?.toolchain.cgo)}</Row>
              <Row label="-trimpath" mono>{core ? (core.toolchain.trimpath ? t('yes') : t('no')) : '—'}</Row>
              <Row label={t('toolchain.vcs')} mono>
                {core?.vcs?.revision ? `${shortCommit(core.vcs.revision)}${core.vcs.modified ? ' +' : ''}` : t('toolchain.noVcs')}
              </Row>
            </dl>
          </div>
          <div className="rounded-panel border border-border p-4">
            <h4 className="mb-1 text-xs font-medium text-fg-muted">{t('toolchain.web')}</h4>
            <dl>
              <Row label={t('toolchain.version')} mono>{dash(web.version)}</Row>
              <Row label={t('core.commit')} mono>{dash(shortCommit(web.commit))}</Row>
              <Row label={t('core.built')}>{when(web.builtAt)}</Row>
              <Row label="Node" mono>{dash(bareVersion(web.node))}</Row>
              <Row label="Vite · React" mono>{web.vite || web.react ? `${dash(web.vite)} · ${dash(web.react)}` : '—'}</Row>
            </dl>
          </div>
        </div>
        <p className="mt-3 text-xs text-fg-subtle">{t('toolchain.media')}</p>
      </Section>

      <Section
        title={t('changelog.title')}
        aside={
          <a href={CHANGELOG_URL} target="_blank" rel="noopener noreferrer" className="text-xs text-fg-subtle hover:text-fg">
            {t('changelog.source')}
          </a>
        }
      >
        {changelog.isLoading ? (
          <p className="text-sm text-fg-subtle">{t('loading')}</p>
        ) : changelog.data?.markdown ? (
          <ChangelogList markdown={changelog.data.markdown} running={version} />
        ) : (
          <p className="text-sm text-fg-subtle">{t('changelog.unavailable')}</p>
        )}
      </Section>
    </Drawer>
  )
}
