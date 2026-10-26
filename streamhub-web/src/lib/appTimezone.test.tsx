/**
 * Component/DOM test — AppTimezoneProvider / useAppTimezone (vitest + jsdom).
 *
 * Owner item 11 (per-app timezone). Covers:
 *  - useAppTimezone() outside any provider returns '' (safe default, never throws);
 *  - AppTimezoneProvider fetches GET /apps/:app/config and exposes its
 *    (trimmed) `timezone` to descendants;
 *  - an absent/empty `timezone` on the resolved config exposes '' (server
 *    default — unchanged pre-existing behaviour for apps with no override);
 *  - a fetch failure degrades to '' rather than throwing/blocking children
 *    (best-effort, matches the doc comment).
 *
 * `@/api` is mocked — no network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const { getConfig } = vi.hoisted(() => ({ getConfig: vi.fn() }))

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return {
    ...actual,
    api: { apps: { getConfig } },
  }
})

import { AppTimezoneProvider, useAppTimezone } from './appTimezone'

function Probe() {
  const tz = useAppTimezone()
  return <span data-testid="tz">{tz || '(none)'}</span>
}

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

describe('useAppTimezone', () => {
  beforeEach(() => {
    getConfig.mockReset()
  })

  it('returns the empty string outside any provider (safe default)', () => {
    render(<Probe />, { wrapper: wrapper() })
    expect(screen.getByTestId('tz').textContent).toBe('(none)')
  })

  it("exposes the app's configured timezone once the config resolves", async () => {
    getConfig.mockResolvedValue({ timezone: 'America/Argentina/Buenos_Aires' })
    render(
      <AppTimezoneProvider app="live">
        <Probe />
      </AppTimezoneProvider>,
      { wrapper: wrapper() },
    )
    await waitFor(() =>
      expect(screen.getByTestId('tz').textContent).toBe('America/Argentina/Buenos_Aires'),
    )
    expect(getConfig).toHaveBeenCalledWith('live', expect.anything())
  })

  it('exposes "" when the app has no timezone configured', async () => {
    getConfig.mockResolvedValue({ timezone: '' })
    render(
      <AppTimezoneProvider app="live">
        <Probe />
      </AppTimezoneProvider>,
      { wrapper: wrapper() },
    )
    await waitFor(() => expect(getConfig).toHaveBeenCalled())
    expect(screen.getByTestId('tz').textContent).toBe('(none)')
  })

  it('trims whitespace around a hand-edited timezone value', async () => {
    getConfig.mockResolvedValue({ timezone: '  Asia/Tokyo  ' })
    render(
      <AppTimezoneProvider app="live">
        <Probe />
      </AppTimezoneProvider>,
      { wrapper: wrapper() },
    )
    await waitFor(() => expect(screen.getByTestId('tz').textContent).toBe('Asia/Tokyo'))
  })

  it('degrades to "" (never throws) when the config fetch fails', async () => {
    getConfig.mockRejectedValue(new Error('network down'))
    render(
      <AppTimezoneProvider app="live">
        <Probe />
      </AppTimezoneProvider>,
      { wrapper: wrapper() },
    )
    await waitFor(() => expect(getConfig).toHaveBeenCalled())
    expect(screen.getByTestId('tz').textContent).toBe('(none)')
  })
})
