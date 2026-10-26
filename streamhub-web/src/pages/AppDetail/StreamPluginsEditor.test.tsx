/**
 * Component/DOM test — StreamPluginsEditor (vitest + jsdom + @testing-library).
 *
 * Guards the per-stream plugin opt-out UI end-to-end at the component layer:
 *  - it loads the stream's current opt-out list and renders one toggle per
 *    app-enabled overlay plugin, ON = affected (default), OFF = opted out;
 *  - flipping a toggle OFF and saving PATCHes the exact disabled id list and
 *    closes the editor;
 *  - a stream that opts out of nothing shows every toggle ON.
 *
 * `@/api` streams get/set are mocked; react-i18next is stubbed to echo keys so
 * assertions are text-independent. No network, no i18n bootstrap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}))

const { getPlugins, setPlugins } = vi.hoisted(() => ({
  getPlugins: vi.fn(),
  setPlugins: vi.fn(),
}))

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return {
    ...actual,
    api: { streams: { getPlugins, setPlugins } },
  }
})

import { StreamPluginsEditor } from './StreamPluginsEditor'
import type { Stream } from '@/api'

const STREAM: Stream = {
  id: 1,
  appId: 1,
  streamId: 'room1/cam',
  type: 'webrtc',
  room: 'room1',
  participant: 'cam',
  status: 'active',
  startedAt: '2026-01-01',
  endedAt: null,
  lastStatsJson: null,
}

const PLUGINS = [
  { id: 'ov-a', name: 'Overlay A' },
  { id: 'ov-b', name: 'Overlay B' },
]

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

function renderEditor(onClose = vi.fn()) {
  return {
    onClose,
    ...render(
      <StreamPluginsEditor
        app="live"
        stream={STREAM}
        plugins={PLUGINS}
        onClose={onClose}
      />,
      { wrapper: wrapper() },
    ),
  }
}

describe('StreamPluginsEditor — per-stream plugin toggles', () => {
  beforeEach(() => {
    getPlugins.mockReset()
    setPlugins.mockReset()
  })

  it('reflects the stream opt-out: opted-out plugin OFF, others ON', async () => {
    getPlugins.mockResolvedValue({ streamId: 'room1/cam', disabled: ['ov-a'] })
    renderEditor()

    const a = (await screen.findByRole('checkbox', {
      name: 'Overlay A',
    })) as HTMLInputElement
    const b = screen.getByRole('checkbox', { name: 'Overlay B' }) as HTMLInputElement

    // ov-a is opted OUT → not affected → unchecked; ov-b is affected → checked.
    expect(a.checked).toBe(false)
    expect(b.checked).toBe(true)
    expect(getPlugins).toHaveBeenCalledWith('live', 'room1/cam', expect.anything())
  })

  it('opting a stream out of a plugin PATCHes just that id and closes', async () => {
    getPlugins.mockResolvedValue({ streamId: 'room1/cam', disabled: ['ov-a'] })
    setPlugins.mockResolvedValue({
      streamId: 'room1/cam',
      disabled: ['ov-a', 'ov-b'],
    })
    const { onClose } = renderEditor()

    const b = (await screen.findByRole('checkbox', {
      name: 'Overlay B',
    })) as HTMLInputElement
    // Turn Overlay B OFF → opt this stream out of ov-b too.
    fireEvent.click(b)
    expect(b.checked).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'plugins.save' }))

    await waitFor(() => expect(setPlugins).toHaveBeenCalledTimes(1))
    expect(setPlugins).toHaveBeenCalledWith('live', 'room1/cam', ['ov-a', 'ov-b'])
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('DEFAULT (no opt-out): every toggle ON; opting one out saves only that id', async () => {
    getPlugins.mockResolvedValue({ streamId: 'room1/cam', disabled: [] })
    setPlugins.mockResolvedValue({ streamId: 'room1/cam', disabled: ['ov-a'] })
    renderEditor()

    const a = (await screen.findByRole('checkbox', {
      name: 'Overlay A',
    })) as HTMLInputElement
    const b = screen.getByRole('checkbox', { name: 'Overlay B' }) as HTMLInputElement
    expect(a.checked).toBe(true)
    expect(b.checked).toBe(true)

    fireEvent.click(a) // opt out of ov-a only
    fireEvent.click(screen.getByRole('button', { name: 'plugins.save' }))

    await waitFor(() => expect(setPlugins).toHaveBeenCalledWith('live', 'room1/cam', ['ov-a']))
  })
})
