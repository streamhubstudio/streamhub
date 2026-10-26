/**
 * Component/DOM test — OnboardingWizard (vitest + jsdom + @testing-library).
 *
 * Drives the wizard shell: it mounts, advances only once a purpose is chosen,
 * always offers "Skip" (which persists a dismissal + closes), and "Finish"
 * from step ≥2 runs the built plan then lands on the closing screen.
 *
 * react-i18next is stubbed to echo keys (assertions are copy-independent) and
 * the network-touching runner is mocked so we assert wiring, not HTTP.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { PlanAction } from '@/lib/onboardingPlan'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}))

const runPlan = vi.fn(
  async (_app: string, actions: PlanAction[]) => actions.map((a) => ({ action: a, ok: true })),
)
const persistOnboarding = vi.fn(async () => {})
vi.mock('./runner', () => ({
  runPlan: (...args: unknown[]) => runPlan(...(args as [string, PlanAction[]])),
  persistOnboarding: (...args: unknown[]) => persistOnboarding(...(args as [])),
  loadOnboarding: vi.fn(async () => null),
}))

import { OnboardingWizard } from './OnboardingWizard'

describe('OnboardingWizard', () => {
  beforeEach(() => {
    runPlan.mockClear()
    persistOnboarding.mockClear()
  })

  it('mounts and gates Next until a purpose is picked', () => {
    render(<OnboardingWizard app="demo" onClose={() => {}} />)
    expect(screen.getByTestId('onboarding-wizard')).toBeTruthy()
    // No Finish on step 1.
    expect(screen.queryByTestId('onboarding-finish')).toBeNull()

    // Next is inert until a purpose is chosen — clicking it doesn't advance.
    fireEvent.click(screen.getByTestId('onboarding-next'))
    expect(screen.queryByTestId('recording-yes')).toBeNull()

    // With a purpose picked, Next advances into the tailored flow.
    fireEvent.click(screen.getByTestId('purpose-surveillance'))
    fireEvent.click(screen.getByTestId('onboarding-next'))
    expect(screen.getByTestId('recording-yes')).toBeTruthy()
  })

  it('advances into the tailored flow and surfaces Finish from step 2', () => {
    render(<OnboardingWizard app="demo" onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('purpose-surveillance'))
    fireEvent.click(screen.getByTestId('onboarding-next'))

    // Step 2 (recording) is showing and Finish is now available.
    expect(screen.getByTestId('recording-yes')).toBeTruthy()
    expect(screen.getByTestId('onboarding-finish')).toBeTruthy()
  })

  it('Skip persists a dismissal and closes', async () => {
    const onClose = vi.fn()
    render(<OnboardingWizard app="demo" onClose={onClose} />)
    fireEvent.click(screen.getByTestId('onboarding-skip'))

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(persistOnboarding).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({ status: 'dismissed' }),
    )
  })

  it('Finish runs the built plan and marks onboarding completed', async () => {
    render(<OnboardingWizard app="demo" onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('purpose-surveillance'))
    fireEvent.click(screen.getByTestId('onboarding-next')) // → recording
    fireEvent.click(screen.getByTestId('recording-yes'))
    fireEvent.click(screen.getByTestId('onboarding-finish'))

    await waitFor(() => expect(runPlan).toHaveBeenCalledTimes(1))
    const [app, actions] = runPlan.mock.calls[0]
    expect(app).toBe('demo')
    expect(actions).toEqual([{ type: 'config.recording', enabled: true }])

    await waitFor(() =>
      expect(persistOnboarding).toHaveBeenCalledWith(
        'demo',
        expect.objectContaining({ status: 'completed', purpose: 'surveillance' }),
      ),
    )
    // Landed on the closing screen.
    await waitFor(() => expect(screen.getByTestId('onboarding-close')).toBeTruthy())
  })

  it('reaching the summary lists the planned actions', () => {
    render(<OnboardingWizard app="demo" onClose={() => {}} />)
    // radio → purpose, recording, extras, summary (short path).
    fireEvent.click(screen.getByTestId('purpose-radio'))
    fireEvent.click(screen.getByTestId('onboarding-next')) // recording
    fireEvent.click(screen.getByTestId('recording-no'))
    fireEvent.click(screen.getByTestId('onboarding-next')) // extras
    fireEvent.click(screen.getByTestId('onboarding-next')) // summary

    const list = screen.getByTestId('onboarding-summary-list')
    // recording off + radio plugin + passthrough ingress = 3 items.
    expect(list.querySelectorAll('li').length).toBe(3)
    expect(screen.getByTestId('onboarding-apply')).toBeTruthy()
  })
})
