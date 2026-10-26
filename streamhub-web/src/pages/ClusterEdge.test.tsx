/**
 * Component/DOM test — the Cluster · Edge tab (vitest + jsdom +
 * @testing-library). Guards the cluster-level edge surface:
 *   - edge node cards render with telemetry + a restart command that hits the
 *     typed api.edge.command;
 *   - the assignments matrix lists app · plugin · stream · node · status rows.
 *
 * The api client + react-i18next are mocked; react-query drives the fetches.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}))

const { nodesMock, assignmentsMock, commandMock, patchMock } = vi.hoisted(() => ({
  nodesMock: vi.fn(),
  assignmentsMock: vi.fn(),
  commandMock: vi.fn(),
  patchMock: vi.fn(),
}))

vi.mock('@/api', () => ({
  api: {
    edge: {
      nodes: nodesMock,
      assignments: assignmentsMock,
      command: commandMock,
      patchNode: patchMock,
    },
  },
  ApiRequestError: class ApiRequestError extends Error {},
}))

import { EdgeTab, groupByApp } from './ClusterEdge'
import type { EdgeAssignment } from '@/api'

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

const NODE = {
  id: 'n1',
  name: 'edge-gpu-1',
  url: null,
  region: 'us-east',
  type: 'edge' as const,
  weight: 100,
  status: 'online',
  connected: true,
  stale: false,
  createdAt: '2026-01-01T00:00:00Z',
  lastSeenAt: '2026-01-01T00:00:00Z',
  stats: { cpu: 12, mem: 40, disk: 55, grid: { gpu: true, gpuName: 'Tesla T4', vramGb: 16, vramFreeMb: 8000 } },
}

const ASSIGN: EdgeAssignment = {
  id: 'a1',
  nodeId: 'n1',
  app: 'live',
  pluginId: 'occupancy',
  streamId: 'gate',
  config: {},
  status: 'running',
  detail: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

beforeEach(() => {
  nodesMock.mockReset().mockResolvedValue([NODE])
  assignmentsMock.mockReset().mockResolvedValue([ASSIGN])
  commandMock.mockReset().mockResolvedValue({ ok: true })
  patchMock.mockReset().mockImplementation((id: string, payload: Record<string, unknown>) =>
    Promise.resolve({ ...NODE, id, ...payload }),
  )
})

describe('groupByApp', () => {
  it('groups by app and sorts apps + rows deterministically', () => {
    const rows = [
      { ...ASSIGN, id: 'b', app: 'zeta', pluginId: 'lpr', streamId: 's2' },
      { ...ASSIGN, id: 'a', app: 'alpha', pluginId: 'occupancy', streamId: 's1' },
      { ...ASSIGN, id: 'c', app: 'alpha', pluginId: 'counting', streamId: 's0' },
    ]
    const grouped = groupByApp(rows)
    expect(grouped.map(([app]) => app)).toEqual(['alpha', 'zeta'])
    // alpha's rows sorted by plugin: counting before occupancy.
    expect(grouped[0][1].map((r) => r.pluginId)).toEqual(['counting', 'occupancy'])
  })
})

describe('Cluster · Edge tab', () => {
  it('renders an edge node card and sends a restart command', async () => {
    render(<EdgeTab />, { wrapper: wrapper() })

    const card = await screen.findByTestId('edge-node-n1')
    expect(card.textContent).toContain('edge-gpu-1')
    expect(card.textContent).toContain('Tesla T4')

    fireEvent.click(screen.getByText('nodes.restart'))
    await waitFor(() => expect(commandMock).toHaveBeenCalledWith('n1', 'restart'))
  })

  it('lists an assignment row (app · plugin · stream · node)', async () => {
    render(<EdgeTab />, { wrapper: wrapper() })
    const row = await screen.findByTestId('assignment-a1')
    expect(row.textContent).toContain('occupancy')
    expect(row.textContent).toContain('gate')
    // node id resolves to the node's display name.
    expect(row.textContent).toContain('edge-gpu-1')
  })

  it('edits a node weight on blur and PATCHes it', async () => {
    render(<EdgeTab />, { wrapper: wrapper() })
    const input = (await screen.findByTestId('edge-weight-n1')) as HTMLInputElement
    expect(input.value).toBe('100') // seeded from the node's current weight

    fireEvent.change(input, { target: { value: '250' } })
    fireEvent.blur(input)

    await waitFor(() => expect(patchMock).toHaveBeenCalledWith('n1', { weight: 250 }))
  })

  it('does not PATCH when the weight is committed unchanged', async () => {
    render(<EdgeTab />, { wrapper: wrapper() })
    const input = await screen.findByTestId('edge-weight-n1')
    fireEvent.blur(input) // no edit → no-op
    await Promise.resolve()
    expect(patchMock).not.toHaveBeenCalled()
  })

  it('retypes a node via the type selector', async () => {
    render(<EdgeTab />, { wrapper: wrapper() })
    const select = await screen.findByTestId('edge-type-n1')
    fireEvent.change(select, { target: { value: 'common' } })
    await waitFor(() => expect(patchMock).toHaveBeenCalledWith('n1', { type: 'common' }))
  })
})
