/**
 * Component/DOM test — NetworkCard (vitest + jsdom + @testing-library).
 *
 * Guards the dashboard Network I/O card at the component layer:
 *  - the "All apps" aggregate sums today's in/out across apps and flags a
 *    breach when any app is over threshold;
 *  - switching the scope selector to a single app shows that app's bytes, its
 *    threshold pill, and a Configure link to its settings.
 *
 * `@/api` (apps.list / net / netHistory) is mocked; react-i18next echoes keys;
 * react-router-dom's Link is stubbed to a plain anchor (no Router needed).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}))

const { list, net, netHistory } = vi.hoisted(() => ({
  list: vi.fn(),
  net: vi.fn(),
  netHistory: vi.fn(),
}))

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return { ...actual, api: { apps: { list, net, netHistory } } }
})

import { NetworkCard } from './NetworkCard'

const MB = 1024 * 1024

function summary(over: {
  tin: number
  tout: number
  gb: number
  exceeded: boolean
}) {
  const total = over.tin + over.tout
  const win = { in: over.tin, out: over.tout, total }
  return {
    today: win,
    last24h: win,
    last7d: win,
    bySource: [],
    threshold: {
      gbPerDay: over.gb,
      thresholdBytes: over.gb * 1024 ** 3,
      usage24hBytes: total,
      percent: over.gb > 0 ? (total / (over.gb * 1024 ** 3)) * 100 : null,
      exceeded: over.exceeded,
    },
  }
}

function history() {
  return {
    hours: 24,
    buckets: [
      { bucket: '2026-07-11T10', in: 1 * MB, out: 1 * MB },
      { bucket: '2026-07-11T11', in: 2 * MB, out: 0 },
    ],
  }
}

function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <NetworkCard />
    </QueryClientProvider>,
  )
}

describe('NetworkCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    list.mockResolvedValue([{ name: 'alpha' }, { name: 'beta' }])
    net.mockImplementation((name: string) =>
      Promise.resolve(
        name === 'alpha'
          ? summary({ tin: 1 * MB, tout: 2 * MB, gb: 10, exceeded: false })
          : summary({ tin: 3 * MB, tout: 0, gb: 1, exceeded: true }),
      ),
    )
    netHistory.mockResolvedValue(history())
  })

  it('aggregates today in/out across apps and flags a breach in All-apps view', async () => {
    renderCard()

    // In = 1MB (alpha) + 3MB (beta) = 4.0 MB ; Out = 2MB + 0 = 2.0 MB
    await waitFor(() => expect(screen.getByText('4.0 MB')).toBeTruthy())
    expect(screen.getByText('2.0 MB')).toBeTruthy()
    // beta is over threshold → aggregate pill shows the exceeded-count key.
    expect(screen.getByTestId('net-threshold').textContent).toBe(
      'net.exceededCount',
    )
    expect(screen.getByTestId('net-spark')).toBeTruthy()
  })

  it('switches to a single app: its bytes, threshold pill, and Configure link', async () => {
    renderCard()
    await waitFor(() => expect(screen.getByText('4.0 MB')).toBeTruthy())

    fireEvent.change(screen.getByTestId('net-scope'), {
      target: { value: 'beta' },
    })

    // beta today: in 3.0 MB, out 0 → '—'
    await waitFor(() => expect(screen.getByText('3.0 MB')).toBeTruthy())
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.getByTestId('net-threshold').textContent).toBe('net.exceeded')
    const link = screen.getByText('net.configure →').closest('a')
    expect(link?.getAttribute('href')).toBe('/apps/beta')
  })

  it('shows the within-threshold pill for a compliant app', async () => {
    renderCard()
    await waitFor(() => expect(screen.getByText('4.0 MB')).toBeTruthy())

    fireEvent.change(screen.getByTestId('net-scope'), {
      target: { value: 'alpha' },
    })
    await waitFor(() =>
      expect(screen.getByTestId('net-threshold').textContent).toBe('net.ok'),
    )
  })
})
