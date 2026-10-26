/**
 * Component/DOM test — ConfigTab (vitest + jsdom + @testing-library).
 *
 * Covers the CONFIG-UX G4 fold-2 changes:
 *  - the four sections (Presets / Transcoding / raw YAML / Backups) render as
 *    TABS named after their own existing `<SectionTitle>` and default to
 *    "presets" — `?section=` deep-links to a specific one;
 *  - preset toggle with a negative: a not-applied preset shows "Apply
 *    preset"; once `listPresets` reports it `applied`, the row shows the
 *    "Applied ✓" badge and swaps the button for "Deactivate" — both actions
 *    confirm first, hit their own endpoint, and refresh the presets list;
 *  - switching sections never resets in-progress state elsewhere: the raw
 *    YAML editor's own dirty/unsaved-changes flag survives a round trip
 *    through another tab because all four sections stay MOUNTED (hidden via
 *    CSS, not conditionally rendered).
 *
 * `@/api` is mocked (apps + system + admin), react-i18next is stubbed to echo
 * keys (ignoring interpolation options) so assertions are text-independent.
 * No network, no i18n bootstrap. Wrapped in a MemoryRouter since ConfigTab
 * reads/writes `?section=` via `useSearchParams`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

const {
  listPresets,
  applyPreset,
  deactivatePreset,
  getConfig,
  updateConfig,
  update,
  gpu,
  getConfigRaw,
  putConfigRaw,
  reload,
  dryRunConfigRaw,
  adminRestart,
  listConfigBackups,
  tokensList,
  tokensMint,
  tokensRevoke,
  logsQueryApp,
} = vi.hoisted(() => ({
  listPresets: vi.fn(),
  applyPreset: vi.fn(),
  deactivatePreset: vi.fn(),
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  update: vi.fn(),
  gpu: vi.fn(),
  getConfigRaw: vi.fn(),
  putConfigRaw: vi.fn(),
  reload: vi.fn(),
  dryRunConfigRaw: vi.fn(),
  adminRestart: vi.fn(),
  listConfigBackups: vi.fn(),
  tokensList: vi.fn(),
  tokensMint: vi.fn(),
  tokensRevoke: vi.fn(),
  logsQueryApp: vi.fn(),
}))

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return {
    ...actual, // keep the real ApiRequestError etc.
    api: {
      apps: {
        listPresets,
        applyPreset,
        deactivatePreset,
        getConfig,
        updateConfig,
        update,
        getConfigRaw,
        putConfigRaw,
        reload,
        dryRunConfigRaw,
        listConfigBackups,
      },
      system: { gpu },
      admin: { restart: adminRestart },
      // The System section mounts the real Tokens + Logs surfaces.
      tokens: { list: tokensList, mint: tokensMint, revoke: tokensRevoke },
      logs: { queryApp: logsQueryApp },
    },
  }
})

// The System section also mounts IntegracionesTab (a large, separately-tested
// surface with its own API deps). Stub it here so these tests stay focused on
// ConfigTab's composition — it still proves the sub is mounted (its wrapper
// div) without dragging in the integrations endpoints.
vi.mock('./IntegracionesTab', () => ({
  IntegracionesTab: ({ app }: { app: string }) => (
    <div data-testid="integraciones-stub">integraciones:{app}</div>
  ),
}))

import { ConfigTab } from './ConfigTab'

const LOW_LATENCY = {
  name: 'low-latency',
  title: 'Baja latencia',
  description: 'WebRTC-first passthrough',
  useCase: 'CCTV',
  sets: ['transcoding.enabled = false'],
  applied: false,
}

function wrapper(initialSection?: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const initialEntries = [
    initialSection ? `/apps/live?section=${initialSection}` : '/apps/live',
  ]
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
    </QueryClientProvider>
  )
}

function renderTab(initialSection?: string) {
  return render(<ConfigTab app="live" />, { wrapper: wrapper(initialSection) })
}

describe('ConfigTab', () => {
  beforeEach(() => {
    listPresets.mockReset().mockResolvedValue([LOW_LATENCY])
    applyPreset.mockReset()
    deactivatePreset.mockReset()
    getConfig.mockReset().mockResolvedValue({
      adaptive: false,
      rtmpTranscode: false,
      hwaccel: 'auto',
      layers: [],
      rtmp: { transcode: false, passthrough: false },
    })
    updateConfig.mockReset()
    update.mockReset()
    gpu.mockReset().mockResolvedValue({ available: false })
    getConfigRaw.mockReset().mockResolvedValue({ yaml: 'name: live\n' })
    putConfigRaw.mockReset()
    reload.mockReset()
    dryRunConfigRaw.mockReset()
    adminRestart.mockReset()
    listConfigBackups.mockReset().mockResolvedValue([])
    tokensList.mockReset().mockResolvedValue([])
    tokensMint.mockReset()
    tokensRevoke.mockReset()
    logsQueryApp.mockReset().mockResolvedValue({ items: [], total: 0 })
  })

  describe('section tabs', () => {
    it('renders all four sections as tabs, named after their own titles, and defaults to Presets', async () => {
      renderTab()
      await screen.findByTestId('config-section-presets')

      expect(screen.getByRole('tab', { name: 'presets.title' })).toBeTruthy()
      expect(screen.getByRole('tab', { name: 'transcoding.title' })).toBeTruthy()
      expect(screen.getByRole('tab', { name: 'raw.title' })).toBeTruthy()
      expect(screen.getByRole('tab', { name: 'backups.title' })).toBeTruthy()

      // Presets is visible by default; the others are present but hidden.
      expect(screen.getByTestId('config-section-presets').className).not.toContain('hidden')
      expect(screen.getByTestId('config-section-transcoding').className).toContain('hidden')
      expect(screen.getByTestId('config-section-raw').className).toContain('hidden')
      expect(screen.getByTestId('config-section-backups').className).toContain('hidden')
    })

    it('deep-links to a specific section via ?section=', async () => {
      renderTab('backups')
      await waitFor(() =>
        expect(screen.getByTestId('config-section-backups').className).not.toContain('hidden'),
      )
      expect(screen.getByTestId('config-section-presets').className).toContain('hidden')
    })

    it('clicking a tab toggles which section is visible (others stay mounted, just hidden)', async () => {
      renderTab()
      await screen.findByTestId('config-section-presets')

      fireEvent.click(screen.getByRole('tab', { name: 'raw.title' }))

      expect(screen.getByTestId('config-section-raw').className).not.toContain('hidden')
      expect(screen.getByTestId('config-section-presets').className).toContain('hidden')
      // Still in the DOM (mounted) — proves it wasn't unmounted, just hidden.
      expect(screen.getByTestId('config-section-presets')).toBeTruthy()
    })
  })

  describe('timezone section (owner item 11)', () => {
    it('pre-fills the current app timezone and shows a preview', async () => {
      getConfig.mockReset().mockResolvedValue({
        adaptive: false,
        rtmpTranscode: false,
        hwaccel: 'auto',
        layers: [],
        rtmp: { transcode: false, passthrough: false },
        timezone: 'America/Argentina/Buenos_Aires',
      })
      renderTab('timezone')
      const input = (await screen.findByLabelText('timezone.label')) as HTMLInputElement
      await waitFor(() => expect(input.value).toBe('America/Argentina/Buenos_Aires'))
      expect(screen.getByText('timezone.preview')).toBeTruthy()
    })

    it('shows "no override" copy when the app has none configured; Clear is a no-op', async () => {
      renderTab('timezone')
      await screen.findByLabelText('timezone.label')
      expect(screen.getByText('timezone.serverDefault')).toBeTruthy()
      // The Button component doesn't set the native `disabled` DOM attribute
      // (it guards inside its own onClick) — assert the GUARDED BEHAVIOUR
      // instead: clicking Clear while already empty never calls the mutation.
      fireEvent.click(screen.getByRole('button', { name: 'timezone.clear' }))
      expect(update).not.toHaveBeenCalled()
    })

    it('flags a garbage timezone as invalid and refuses to save it', async () => {
      renderTab('timezone')
      const input = await screen.findByLabelText('timezone.label')
      fireEvent.change(input, { target: { value: 'Not/AZone' } })
      expect(screen.getByText('timezone.invalid')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'timezone.save' }))
      expect(update).not.toHaveBeenCalled()
    })

    it('saves a trimmed, valid timezone via PATCH /apps/:name', async () => {
      update.mockResolvedValue({})
      renderTab('timezone')
      const input = await screen.findByLabelText('timezone.label')
      fireEvent.change(input, { target: { value: '  Asia/Tokyo  ' } })
      fireEvent.click(screen.getByRole('button', { name: 'timezone.save' }))
      await waitFor(() =>
        expect(update).toHaveBeenCalledWith('live', { timezone: 'Asia/Tokyo' }),
      )
      await screen.findByText('timezone.saved')
    })

    it('the Clear button resets the field to empty (server default)', async () => {
      getConfig.mockReset().mockResolvedValue({
        adaptive: false,
        rtmpTranscode: false,
        hwaccel: 'auto',
        layers: [],
        rtmp: { transcode: false, passthrough: false },
        timezone: 'Europe/Madrid',
      })
      renderTab('timezone')
      const input = (await screen.findByLabelText('timezone.label')) as HTMLInputElement
      await waitFor(() => expect(input.value).toBe('Europe/Madrid'))
      fireEvent.click(screen.getByRole('button', { name: 'timezone.clear' }))
      expect(input.value).toBe('')
      expect(screen.getByText('timezone.serverDefault')).toBeTruthy()
    })
  })

  describe('preset toggle with a negative (apply ⇄ deactivate)', () => {
    it('shows "Apply preset" for a not-applied preset, then "Applied ✓" + "Deactivate" once the backend reports it applied', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
      listPresets
        .mockReset()
        .mockResolvedValueOnce([LOW_LATENCY])
        .mockResolvedValue([{ ...LOW_LATENCY, applied: true }])
      applyPreset.mockResolvedValue({
        preset: 'low-latency',
        applied: true,
        reloaded: true,
        changed: true,
        diff: '+ transcoding:\n+   enabled: false',
        warnings: [],
      })

      renderTab()
      const applyBtn = await screen.findByRole('button', { name: 'presets.apply' })
      expect(screen.queryByText('presets.appliedBadge')).toBeFalsy()

      fireEvent.click(applyBtn)
      expect(confirmSpy).toHaveBeenCalledWith('presets.confirm')

      await waitFor(() => expect(applyPreset).toHaveBeenCalledWith('live', 'low-latency'))

      // The presets list is invalidated + refetched → now reads `applied: true`.
      await waitFor(() => expect(screen.getByText('presets.appliedBadge')).toBeTruthy())
      expect(screen.getByRole('button', { name: 'presets.deactivate' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'presets.apply' })).toBeFalsy()

      // The success panel renders the APPLY copy (not the deactivate one).
      expect(screen.getByText('presets.result.appliedReloaded')).toBeTruthy()

      confirmSpy.mockRestore()
    })

    it('deactivating an applied preset calls the deactivate endpoint and reverts the row back to "Apply"', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
      listPresets
        .mockReset()
        .mockResolvedValueOnce([{ ...LOW_LATENCY, applied: true }])
        .mockResolvedValue([{ ...LOW_LATENCY, applied: false }])
      deactivatePreset.mockResolvedValue({
        preset: 'low-latency',
        applied: false,
        reloaded: true,
        changed: true,
        diff: '- transcoding:\n-   enabled: false',
        warnings: [],
      })

      renderTab()
      const deactivateBtn = await screen.findByRole('button', { name: 'presets.deactivate' })
      expect(screen.getByText('presets.appliedBadge')).toBeTruthy()

      fireEvent.click(deactivateBtn)
      expect(confirmSpy).toHaveBeenCalledWith('presets.confirmDeactivate')

      await waitFor(() =>
        expect(deactivatePreset).toHaveBeenCalledWith('live', 'low-latency'),
      )

      // Refetch reports it's no longer applied → back to "Apply preset".
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'presets.apply' })).toBeTruthy(),
      )
      expect(screen.queryByText('presets.appliedBadge')).toBeFalsy()
      expect(screen.queryByRole('button', { name: 'presets.deactivate' })).toBeFalsy()

      // The success panel renders the DEACTIVATE copy (not the apply one).
      expect(screen.getByText('presets.deactivateResult.appliedReloaded')).toBeTruthy()

      confirmSpy.mockRestore()
    })

    it('does not call apply/deactivate when the confirm dialog is dismissed', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false)
      renderTab()
      const applyBtn = await screen.findByRole('button', { name: 'presets.apply' })
      fireEvent.click(applyBtn)
      expect(applyPreset).not.toHaveBeenCalled()
      vi.restoreAllMocks()
    })

    it('surfaces a deactivate error without touching the apply error banner', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      listPresets.mockReset().mockResolvedValue([{ ...LOW_LATENCY, applied: true }])
      deactivatePreset.mockRejectedValue(new Error('boom'))

      renderTab()
      const deactivateBtn = await screen.findByRole('button', { name: 'presets.deactivate' })
      fireEvent.click(deactivateBtn)

      // errMessage() surfaces a real Error's own message over the i18n fallback.
      await waitFor(() => expect(screen.getByText('boom')).toBeTruthy())
      expect(screen.queryByText('presets.applyError')).toBeFalsy()

      vi.restoreAllMocks()
    })
  })

  describe('cross-section state preservation', () => {
    it('the raw YAML editor keeps its unsaved edits + dirty warning after switching sections and back', async () => {
      renderTab()
      await screen.findByTestId('config-section-presets')

      fireEvent.click(screen.getByRole('tab', { name: 'raw.title' }))
      const textarea = await screen.findByLabelText('config.yaml')
      fireEvent.change(textarea, { target: { value: 'name: live\nextra: true\n' } })
      expect(screen.getByText('raw.unsavedChanges')).toBeTruthy()

      // Switch away to another section…
      fireEvent.click(screen.getByRole('tab', { name: 'transcoding.title' }))
      expect(screen.getByTestId('config-section-raw').className).toContain('hidden')

      // …and back: the edited value + dirty warning are still there — the raw
      // editor was never unmounted, so its local `dirty`/`yaml` state survived.
      fireEvent.click(screen.getByRole('tab', { name: 'raw.title' }))
      expect(screen.getByTestId('config-section-raw').className).not.toContain('hidden')
      expect(screen.getByText('raw.unsavedChanges')).toBeTruthy()
      expect((screen.getByLabelText('config.yaml') as HTMLTextAreaElement).value).toBe(
        'name: live\nextra: true\n',
      )
    })
  })

  describe('System section (Tokens / Integraciones / Logs sub-nav)', () => {
    it('adds a System section tab whose content is lazily mounted (absent until opened)', async () => {
      renderTab()
      await screen.findByTestId('config-section-presets')

      // The section tab exists and its container is present but hidden…
      expect(screen.getByRole('tab', { name: 'system.title' })).toBeTruthy()
      expect(screen.getByTestId('config-section-system').className).toContain('hidden')
      // …the sub-surfaces are NOT mounted yet (lazy) — no token/log queries fired.
      expect(screen.queryByTestId('system-sub-tokens')).toBeNull()
      expect(tokensList).not.toHaveBeenCalled()
      expect(logsQueryApp).not.toHaveBeenCalled()
    })

    it('deep-links to System and lands on the Tokens sub content by default', async () => {
      renderTab('system')
      // Tokens content (the mint form) renders and its sub is visible.
      await screen.findByText('mint.title')
      expect(screen.getByTestId('config-section-system').className).not.toContain('hidden')
      expect(screen.getByTestId('system-sub-tokens').className).not.toContain('hidden')
      // The other two subs are MOUNTED (in the DOM) but hidden.
      expect(screen.getByTestId('integraciones-stub')).toBeTruthy()
      expect(screen.getByTestId('system-sub-integraciones').className).toContain('hidden')
      expect(screen.getByTestId('system-sub-logs').className).toContain('hidden')
    })

    it('deep-links straight to a specific sub via ?sub=', async () => {
      renderTab('system&sub=logs')
      await screen.findByTestId('config-section-system')
      // Logs sub visible, Tokens hidden — both mounted.
      expect(screen.getByTestId('system-sub-logs').className).not.toContain('hidden')
      expect(screen.getByTestId('system-sub-tokens').className).toContain('hidden')
      expect(screen.getByTestId('system-sub-tokens')).toBeTruthy()
    })

    it('switching subs never loses in-progress state (the Tokens form survives a round trip)', async () => {
      renderTab('system')
      const room = (await screen.findByPlaceholderText('demo')) as HTMLInputElement
      fireEvent.change(room, { target: { value: 'my-room' } })
      expect(room.value).toBe('my-room')

      // Switch to Logs…
      fireEvent.click(screen.getByRole('tab', { name: 'system.logs' }))
      expect(screen.getByTestId('system-sub-tokens').className).toContain('hidden')

      // …and back — the edit survives (Tokens was hidden, never unmounted).
      fireEvent.click(screen.getByRole('tab', { name: 'system.tokens' }))
      expect((screen.getByPlaceholderText('demo') as HTMLInputElement).value).toBe('my-room')
    })

    it('keeps System mounted after switching to another config section and back', async () => {
      renderTab('system')
      const room = (await screen.findByPlaceholderText('demo')) as HTMLInputElement
      fireEvent.change(room, { target: { value: 'kept' } })

      // Leave System for the Presets section — System's container hides…
      fireEvent.click(screen.getByRole('tab', { name: 'presets.title' }))
      expect(screen.getByTestId('config-section-system').className).toContain('hidden')
      // …but stays MOUNTED (the lazy latch never unmounts it).
      expect(screen.getByTestId('system-sub-tokens')).toBeTruthy()

      // Returning shows the preserved value.
      fireEvent.click(screen.getByRole('tab', { name: 'system.title' }))
      expect((screen.getByPlaceholderText('demo') as HTMLInputElement).value).toBe('kept')
    })
  })
})
