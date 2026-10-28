/**
 * Component/DOM test — the Fleet tab (vitest + jsdom + @testing-library),
 * mounted through the real plugin default export.
 *
 * Guards the owner requirement at the component layer:
 *  - the grid renders the agents returned by GET .../plugins/fleet/agents
 *    (online/offline badge + metrics), and the online/offline filter narrows it;
 *  - selecting an agent + clicking an action (Ping) POSTs to
 *    .../plugins/fleet/command with the RIGHT body { agentId, command, args }.
 *
 * `@/api/http` is mocked (no network); react-i18next is stubbed to echo keys so
 * assertions are text-independent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) =>
      o && 'count' in o ? `${k}:${o.count}` : k,
    i18n: { language: 'en' },
  }),
}))

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))
vi.mock('@/api/http', () => ({ request: requestMock }))

import plugin from './index.tsx'

const TabComponent = plugin.TabComponent!

const AGENTS = {
  agents: [
    {
      agentId: 'b09994',
      online: true,
      status: 'online',
      version: '1.12',
      lastSeen: '2026-07-10T00:00:00.000Z',
      ageMs: 3000,
      metrics: { cpu: 12, mem: 40, temp: 45, uptime: 7200, cameras: 3, disk: 55, battery: 64, relay: 'running' },
    },
    {
      agentId: 'a20001',
      online: false,
      status: 'offline',
      version: '1.11',
      lastSeen: '2026-07-09T00:00:00.000Z',
      ageMs: 999999,
      metrics: { cpu: null, mem: null, temp: null, uptime: null, cameras: null, disk: null, battery: null, relay: null },
    },
  ],
  generatedAt: '2026-07-10T00:00:01.000Z',
}

const DETAIL = {
  agent: AGENTS.agents[0],
  history: [
    { ts: 't1', cpu: 10, mem: 30, temp: 44, disk: 50, cameras: 3 },
    { ts: 't2', cpu: 14, mem: 42, temp: 46, disk: 55, cameras: 3 },
  ],
  commands: [],
}

function route(path: string, opts?: { method?: string; body?: unknown }) {
  if (opts?.method === 'POST' && path.endsWith('/plugins/fleet/command')) {
    return Promise.resolve({ id: 'cmd-12345678', status: 'pending', command: 'ping' })
  }
  if (/\/plugins\/fleet\/agents\/[^/]+$/.test(path)) return Promise.resolve(DETAIL)
  if (path.endsWith('/plugins/fleet/agents')) return Promise.resolve(AGENTS)
  return Promise.resolve({})
}

describe('Fleet tab', () => {
  beforeEach(() => {
    requestMock.mockReset()
    requestMock.mockImplementation((path: string, opts?: { method?: string; body?: unknown }) =>
      route(path, opts),
    )
  })

  const renderTab = () =>
    render(<TabComponent ctx={{ app: 'live', config: {} }} pluginId="fleet" />)

  it('renders the agents from the mocked GET as cards', async () => {
    renderTab()
    await waitFor(() => {
      expect(screen.getByTestId('agent-card-b09994')).toBeTruthy()
      expect(screen.getByTestId('agent-card-a20001')).toBeTruthy()
    })
    expect(requestMock).toHaveBeenCalledWith('/apps/live/plugins/fleet/agents')
    // battery only on the agent that reports one
    expect(within(screen.getByTestId('agent-card-b09994')).getByText('metric.battery')).toBeTruthy()
    expect(within(screen.getByTestId('agent-card-a20001')).queryByText('metric.battery')).toBeNull()
  })

  it('filters the grid to online agents only', async () => {
    renderTab()
    await waitFor(() => screen.getByTestId('agent-card-a20001'))
    fireEvent.click(screen.getByTestId('filter-online'))
    expect(screen.getByTestId('agent-card-b09994')).toBeTruthy()
    expect(screen.queryByTestId('agent-card-a20001')).toBeNull()
  })

  it('sends a ping command with the right POST body when an agent is selected', async () => {
    renderTab()
    await waitFor(() => screen.getByTestId('agent-card-b09994'))
    fireEvent.click(screen.getByTestId('agent-card-b09994'))
    // detail drawer mounts → the action buttons appear
    const ping = await screen.findByText('action.ping')
    fireEvent.click(ping)

    await waitFor(() => {
      const call = requestMock.mock.calls.find(
        (c) => c[0] === '/apps/live/plugins/fleet/command',
      )
      expect(call).toBeTruthy()
      expect(call?.[1]).toMatchObject({
        method: 'POST',
        body: { agentId: 'b09994', command: 'ping' },
      })
    })
    // the queued-confirmation surfaces
    await waitFor(() => expect(screen.getByTestId('cmd-msg')).toBeTruthy())
  })
})
