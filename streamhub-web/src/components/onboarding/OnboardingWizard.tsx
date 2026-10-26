/**
 * OnboardingWizard — the post-create setup flow for a new app (tenant).
 *
 * A full-screen, always-skippable ("Omitir") wizard: pick a purpose, answer a
 * few tailored questions, review, and "Finalizar" applies every choice through
 * the existing REST APIs (best-effort — one failure never aborts the rest). The
 * decision logic lives in pure modules (@/lib/onboardingPlan) and the execution
 * mapping in ./runner; this component is the thin, responsive shell over them.
 *
 * State is persisted as an `onboarding:` block in the app's config.yaml (see
 * @/lib/onboarding) so a completed/dismissed app never re-prompts.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Spinner } from '@/ui'
import type { OnboardingPurpose } from '@/lib/onboarding'
import {
  ALL_PURPOSES,
  PURPOSE_META,
  VISION_MODELS,
  buildPlan,
  stepsForPurpose,
  type PlanAction,
  type StepId,
  type ViewerScale,
  type VisionModel,
  type WizardAnswers,
} from '@/lib/onboardingPlan'
import { persistOnboarding, runPlan, type ActionResult } from './runner'

const BLOG_BASE = 'https://streamhub.studio/blog'

type Phase = 'steps' | 'running' | 'done'

export interface OnboardingWizardProps {
  app: string
  /** Called when the wizard closes for any reason (finished OR skipped). */
  onClose: () => void
}

export function OnboardingWizard({ app, onClose }: OnboardingWizardProps) {
  const { t } = useTranslation('onboarding')
  const [answers, setAnswers] = useState<WizardAnswers>({})
  const [stepIndex, setStepIndex] = useState(0)
  const [phase, setPhase] = useState<Phase>('steps')
  const [results, setResults] = useState<ActionResult[]>([])
  const [busy, setBusy] = useState(false)

  const steps = useMemo(
    () => stepsForPurpose(answers.purpose, { visionOptIn: answers.visionOptIn }),
    [answers.purpose, answers.visionOptIn],
  )
  // Clamp: shrinking the step list (e.g. changing purpose) mustn't strand us.
  const idx = Math.min(stepIndex, steps.length - 1)
  const current: StepId = steps[idx]
  const plan = useMemo(() => buildPlan(answers), [answers])

  const isFirst = idx === 0
  const isSummary = current === 'summary'
  // Finalizar is available from step 2 onward (task rule).
  const canFinish = idx >= 1
  const canNext = current === 'purpose' ? Boolean(answers.purpose) : true

  function patch(p: Partial<WizardAnswers>) {
    setAnswers((a) => ({ ...a, ...p }))
  }

  function goNext() {
    if (idx < steps.length - 1) setStepIndex(idx + 1)
  }
  function goBack() {
    if (idx > 0) setStepIndex(idx - 1)
  }

  async function persist(status: 'completed' | 'dismissed') {
    try {
      await persistOnboarding(app, {
        status,
        purpose: answers.purpose,
        completedAt: new Date().toISOString(),
      })
    } catch {
      /* best-effort — a failure just re-offers the wizard later */
    }
  }

  async function handleSkip() {
    if (busy) return
    setBusy(true)
    await persist('dismissed')
    onClose()
  }

  async function handleFinish() {
    setPhase('running')
    setResults([])
    const res = await runPlan(app, plan, (_d, _tot, last) =>
      setResults((r) => [...r, last]),
    )
    setResults(res)
    await persist('completed')
    setPhase('done')
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/60 p-3 backdrop-blur-sm sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      data-testid="onboarding-wizard"
    >
      <div className="my-auto w-full max-w-2xl rounded-2xl border border-navy-600 bg-navy-800 shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-navy-600 px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <h2 id="onboarding-title" className="truncate text-lg font-semibold text-fg">
              {t('title', { app })}
            </h2>
            {phase === 'steps' && (
              <p className="mt-0.5 text-xs text-slate-400">
                {t('stepCounter', { n: idx + 1, total: steps.length })}
              </p>
            )}
          </div>
          {phase === 'steps' && (
            <button
              type="button"
              onClick={handleSkip}
              disabled={busy}
              className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium text-slate-400 transition hover:bg-navy-700 hover:text-slate-200 disabled:opacity-50"
              data-testid="onboarding-skip"
            >
              {t('actions.skip')}
            </button>
          )}
        </div>

        {/* Body */}
        <div className="max-h-[70vh] overflow-y-auto px-5 py-5 sm:px-6">
          {phase === 'steps' && (
            <StepBody app={app} step={current} answers={answers} patch={patch} />
          )}
          {phase === 'running' && <RunningView results={results} total={plan.length} />}
          {phase === 'done' && <DoneView app={app} answers={answers} results={results} />}
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-navy-600 px-5 py-4 sm:px-6">
          {phase === 'steps' ? (
            <>
              <div>
                {!isFirst && (
                  <Button variant="default" size="sm" onClick={goBack} disabled={busy}>
                    {t('actions.back')}
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                {canFinish && (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={handleFinish}
                    disabled={busy}
                    data-testid="onboarding-finish"
                  >
                    {t('actions.finish')}
                  </Button>
                )}
                {!isSummary && (
                  <Button
                    variant="solid"
                    size="sm"
                    onClick={goNext}
                    disabled={busy || !canNext}
                    data-testid="onboarding-next"
                  >
                    {t('actions.next')}
                  </Button>
                )}
                {isSummary && (
                  <Button
                    variant="solid"
                    size="sm"
                    onClick={handleFinish}
                    disabled={busy}
                    data-testid="onboarding-apply"
                  >
                    {t('actions.finish')}
                  </Button>
                )}
              </div>
            </>
          ) : phase === 'running' ? (
            <div className="flex w-full items-center justify-center gap-2 text-sm text-slate-400">
              <Spinner size={18} /> {t('running.title')}
            </div>
          ) : (
            <div className="ml-auto">
              <Button
                variant="solid"
                size="sm"
                onClick={onClose}
                data-testid="onboarding-close"
              >
                {t('actions.close')}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// --- step bodies -------------------------------------------------------------

function StepBody({
  app,
  step,
  answers,
  patch,
}: {
  app: string
  step: StepId
  answers: WizardAnswers
  patch: (p: Partial<WizardAnswers>) => void
}) {
  const { t } = useTranslation('onboarding')

  switch (step) {
    case 'purpose':
      return (
        <StepShell title={t('purpose.title', { app })} subtitle={t('purpose.subtitle')}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {ALL_PURPOSES.map((p) => (
              <OptionCard
                key={p}
                selected={answers.purpose === p}
                onClick={() => patch({ purpose: p })}
                title={t(`purpose.options.${p}.label`)}
                desc={t(`purpose.options.${p}.desc`)}
                testid={`purpose-${p}`}
              />
            ))}
          </div>
        </StepShell>
      )

    case 'recording':
      return (
        <StepShell title={t('recording.title')} subtitle={t('recording.subtitle')}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <OptionCard
              selected={answers.recording === true}
              onClick={() => patch({ recording: true })}
              title={t('recording.yes')}
              desc={t('recording.yesDesc')}
              testid="recording-yes"
            />
            <OptionCard
              selected={answers.recording === false}
              onClick={() => patch({ recording: false })}
              title={t('recording.no')}
              desc={t('recording.noDesc')}
              testid="recording-no"
            />
          </div>
          <p className="mt-4 rounded-lg border border-navy-600 bg-navy-700/40 px-3 py-2 text-[11px] text-slate-400">
            {t('recording.s3Hint')}{' '}
            <TabLink app={app} tab="config">
              {t('recording.s3Link')}
            </TabLink>
          </p>
        </StepShell>
      )

    case 'viewers': {
      const scales: { id: ViewerScale; testid: string }[] = [
        { id: 'small', testid: 'viewers-small' },
        { id: 'medium', testid: 'viewers-medium' },
        { id: 'large', testid: 'viewers-large' },
      ]
      return (
        <StepShell title={t('viewers.title')} subtitle={t('viewers.subtitle')}>
          <div className="grid grid-cols-1 gap-3">
            {scales.map((s) => (
              <OptionCard
                key={s.id}
                selected={answers.viewers === s.id}
                onClick={() => patch({ viewers: s.id })}
                title={t(`viewers.${s.id}`)}
                desc={t(`viewers.${s.id}Desc`)}
                testid={s.testid}
              />
            ))}
          </div>
        </StepShell>
      )
    }

    case 'vision': {
      const selected = new Set(answers.visionModels ?? [])
      const toggle = (m: VisionModel) => {
        const next = new Set(selected)
        if (next.has(m)) next.delete(m)
        else next.add(m)
        patch({ visionModels: [...next] })
      }
      return (
        <StepShell title={t('vision.title')} subtitle={t('vision.subtitle')}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {VISION_MODELS.map((m) => (
              <OptionCard
                key={m}
                selected={selected.has(m)}
                onClick={() => toggle(m)}
                title={t(`vision.models.${m}.label`)}
                desc={t(`vision.models.${m}.desc`)}
                testid={`vision-${m}`}
                multi
              />
            ))}
          </div>
        </StepShell>
      )
    }

    case 'tags':
      return (
        <StepShell title={t('tags.title')} subtitle={t('tags.subtitle')}>
          <ChipsInput
            values={answers.tags ?? []}
            onChange={(tags) => patch({ tags })}
          />
        </StepShell>
      )

    case 'extras':
      return <ExtrasStep app={app} purpose={answers.purpose} />

    case 'summary':
      return <SummaryStep app={app} answers={answers} />

    default:
      return null
  }
}

function ExtrasStep({ app, purpose }: { app: string; purpose?: OnboardingPurpose }) {
  const { t } = useTranslation('onboarding')
  if (!purpose) return null
  const link = PURPOSE_META[purpose].deepLink?.(app)
  return (
    <StepShell title={t(`extras.${purpose}.title`)} subtitle="">
      <div className="rounded-lg border border-navy-600 bg-navy-700/40 px-4 py-3 text-sm text-slate-300">
        {t(`extras.${purpose}.body`)}
      </div>
      {purpose === 'meetings' && link && (
        <a
          href={link}
          className="mt-3 inline-block text-xs font-medium text-primary-500 hover:text-fg"
        >
          {t('extras.meetings.link')} →
        </a>
      )}
    </StepShell>
  )
}

function SummaryStep({ app, answers }: { app: string; answers: WizardAnswers }) {
  const { t } = useTranslation('onboarding')
  const plan = buildPlan(answers)
  return (
    <StepShell title={t('summary.title')} subtitle={t('summary.subtitle', { app })}>
      {plan.length === 0 ? (
        <p className="rounded-lg border border-navy-600 bg-navy-700/40 px-4 py-3 text-sm text-slate-400">
          {t('summary.empty')}
        </p>
      ) : (
        <ul className="space-y-2" data-testid="onboarding-summary-list">
          {plan.map((a, i) => (
            <li
              key={i}
              className="flex items-center gap-2 rounded-lg border border-navy-600 bg-navy-700/40 px-4 py-2.5 text-sm text-slate-200"
            >
              <span className="text-primary-400">•</span>
              {actionLabel(t, a)}
            </li>
          ))}
        </ul>
      )}
    </StepShell>
  )
}

// --- running / done ----------------------------------------------------------

function RunningView({ results, total }: { results: ActionResult[]; total: number }) {
  const { t } = useTranslation('onboarding')
  return (
    <div>
      <p className="mb-3 text-sm text-slate-400">
        {t('running.ofTotal', { done: results.length, total })}
      </p>
      <ul className="space-y-2">
        {results.map((r, i) => (
          <li
            key={i}
            className="flex items-center gap-2 rounded-lg border border-navy-600 bg-navy-700/40 px-4 py-2.5 text-sm"
          >
            <span className={r.ok ? 'text-emerald-400' : 'text-red-400'}>
              {r.ok ? '✓' : '✗'}
            </span>
            <span className="text-slate-200">{actionLabel(t, r.action)}</span>
            {!r.ok && r.error && (
              <span className="ml-auto truncate text-[11px] text-red-300">{r.error}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function DoneView({
  app,
  answers,
  results,
}: {
  app: string
  answers: WizardAnswers
  results: ActionResult[]
}) {
  const { t } = useTranslation('onboarding')
  const ok = results.filter((r) => r.ok).length
  const failed = results.length - ok
  const purpose = answers.purpose
  const meta = purpose ? PURPOSE_META[purpose] : undefined
  const appLink = meta?.deepLink?.(app) ?? `/apps/${encodeURIComponent(app)}`
  // Empty recipe slug (e.g. 'general') falls back to the blog index.
  const recipe = meta?.recipe ? `${BLOG_BASE}/${meta.recipe}` : BLOG_BASE
  const radio = results.find(
    (r) => r.action.type === 'ingress.passthrough' && r.ok && r.detail,
  )?.detail

  return (
    <div>
      <h3 className="text-base font-semibold text-fg">{t('done.title')}</h3>
      <p className="mt-1 text-sm text-slate-400">
        {failed === 0
          ? t('done.appliedSummaryOk', { ok })
          : t('done.appliedSummary', { ok, failed })}
      </p>

      {radio && (
        <div className="mt-4 rounded-lg border border-emerald-700/40 bg-emerald-900/20 px-4 py-3">
          <div className="text-sm font-medium text-emerald-300">{t('done.radioPayoff')}</div>
          {radio.rtmpUrl && (
            <p className="mt-1 break-all font-mono text-[11px] text-slate-300">
              {t('done.rtmpUrl')}: {radio.rtmpUrl}
            </p>
          )}
          {radio.streamKey && (
            <p className="mt-0.5 break-all font-mono text-[11px] text-slate-300">
              {t('done.streamKey')}: {radio.streamKey}
            </p>
          )}
        </div>
      )}

      <div className="mt-5">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          {t('done.nextSteps')}
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href={appLink}
            className="rounded-lg border border-navy-600 bg-navy-700/40 px-3 py-2 text-xs font-medium text-primary-400 transition hover:text-fg"
          >
            {t('done.openApp', { app })} →
          </a>
          <a
            href={recipe}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-navy-600 bg-navy-700/40 px-3 py-2 text-xs font-medium text-slate-300 transition hover:text-fg"
          >
            {t('done.recipe')} ↗
          </a>
        </div>
      </div>
    </div>
  )
}

// --- primitives --------------------------------------------------------------

function StepShell({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: ReactNode
}) {
  return (
    <div>
      <h3 className="text-base font-semibold text-fg">{title}</h3>
      {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
      <div className="mt-4">{children}</div>
    </div>
  )
}

function OptionCard({
  selected,
  onClick,
  title,
  desc,
  testid,
  multi,
}: {
  selected: boolean
  onClick: () => void
  title: string
  desc: string
  testid?: string
  multi?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      data-testid={testid}
      className={`flex flex-col rounded-xl border px-4 py-3 text-left transition ${
        selected
          ? 'border-primary-500 bg-primary-500/10 ring-1 ring-primary-500/40'
          : 'border-navy-600 bg-navy-700/40 hover:border-navy-500'
      }`}
    >
      <span className="flex items-center gap-2 text-sm font-medium text-slate-100">
        <span
          className={`grid h-4 w-4 shrink-0 place-items-center border text-[10px] ${
            multi ? 'rounded' : 'rounded-full'
          } ${selected ? 'border-primary-400 bg-primary-500 text-white' : 'border-navy-500'}`}
        >
          {selected ? '✓' : ''}
        </span>
        {title}
      </span>
      <span className="mt-1 pl-6 text-xs text-slate-400">{desc}</span>
    </button>
  )
}

function ChipsInput({
  values,
  onChange,
}: {
  values: string[]
  onChange: (v: string[]) => void
}) {
  const { t } = useTranslation('onboarding')
  const [draft, setDraft] = useState('')

  function add() {
    const v = draft.trim()
    if (!v || values.includes(v)) {
      setDraft('')
      return
    }
    onChange([...values, v])
    setDraft('')
  }

  return (
    <div>
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          placeholder={t('tags.placeholder')}
          spellCheck={false}
          data-testid="tags-input"
          className="min-w-0 flex-1 rounded-lg border border-navy-600 bg-navy-900/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-primary-500 focus:outline-none"
        />
        <Button variant="default" size="sm" onClick={add}>
          {t('tags.add')}
        </Button>
      </div>
      {values.length === 0 ? (
        <p className="mt-3 text-xs text-slate-500">{t('tags.empty')}</p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2" data-testid="tags-chips">
          {values.map((v) => (
            <span
              key={v}
              className="inline-flex items-center gap-1.5 rounded-full border border-navy-600 bg-navy-700/60 py-1 pl-3 pr-1.5 text-xs text-slate-200"
            >
              {v}
              <button
                type="button"
                aria-label={`remove ${v}`}
                onClick={() => onChange(values.filter((x) => x !== v))}
                className="grid h-4 w-4 place-items-center rounded-full text-slate-400 hover:bg-navy-600 hover:text-slate-100"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function TabLink({
  app,
  tab,
  children,
}: {
  app: string
  tab: string
  children: ReactNode
}) {
  return (
    <a
      href={`/apps/${encodeURIComponent(app)}?tab=${tab}`}
      className="font-medium text-primary-400 hover:text-fg"
    >
      {children}
    </a>
  )
}

type TFn = (key: string, options?: Record<string, unknown>) => string

/** Human-readable label for a plan action (summary + progress list). */
function actionLabel(t: TFn, a: PlanAction): string {
  switch (a.type) {
    case 'config.recording':
      return t(`summary.actions.config.recording.${a.enabled ? 'on' : 'off'}`)
    case 'config.adaptive':
      return t(`summary.actions.config.adaptive.${a.enabled ? 'on' : 'off'}`)
    case 'features':
      return t('summary.actions.features')
    case 'plugin.install':
      return t('summary.actions.plugin.install', { id: a.id })
    case 'tag.create':
      return t('summary.actions.tag.create', { label: a.label })
    case 'ingress.passthrough':
      return t('summary.actions.ingress.passthrough')
    default:
      return ''
  }
}
