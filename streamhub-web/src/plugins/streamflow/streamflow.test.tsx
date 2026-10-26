/**
 * Component/DOM test — the streamflow Studio App tab (vitest + jsdom +
 * @testing-library), mounted through the real default-exported TabComponent.
 *
 * Guards the canvas flow end-to-end at the component layer:
 *   - the section nav renders and switches;
 *   - opening a workflow loads the box catalogue + graph;
 *   - clicking two palette entries adds two nodes to the canvas;
 *   - dragging from an output port to an input port connects them (pointer
 *     down on the output dot, up on the input dot — geometry-free);
 *   - Save PUTs a graph_json carrying both boxes + the one edge (the shape the
 *     backend runner re-hydrates).
 *
 * react-i18next is stubbed to echo keys (assertions stay text-independent) and
 * the API layer is mocked (no network).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}))

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))
vi.mock('@/api/http', () => ({ request: requestMock }))

import streamflowPlugin from './index.tsx'

const Tab = streamflowPlugin.TabComponent!

const CATALOGUE = [
  { type: 'trigger.manual', group: 'trigger', label: 'Manual', description: 'x', inputs: [], outputs: ['out'], fields: [] },
  { type: 'action.notify', group: 'action', label: 'Notify', description: 'x', inputs: ['in'], outputs: ['out'], fields: [{ key: 'title', type: 'string', label: 'Title' }] },
]

const WORKFLOW = { id: 'wf1', name: 'Test flow', enabled: false, graph: {}, createdAt: '', updatedAt: '' }

/** Route the mocked request by URL + method; captures the last PUT body. */
function wireRequest(putSpy: (body: unknown) => void) {
  requestMock.mockImplementation((path: string, opts?: { method?: string; body?: unknown }) => {
    const method = opts?.method ?? 'GET'
    if (method === 'PUT') {
      putSpy(opts?.body)
      return Promise.resolve(WORKFLOW)
    }
    if (path.endsWith('/boxes')) return Promise.resolve(CATALOGUE)
    if (path.endsWith('/runs')) return Promise.resolve([])
    if (/\/workflows\/wf1$/.test(path)) return Promise.resolve(WORKFLOW)
    if (path.endsWith('/workflows')) return Promise.resolve([WORKFLOW])
    return Promise.resolve([])
  })
}

describe('streamflow tab', () => {
  beforeEach(() => {
    requestMock.mockReset()
  })

  it('renders the section nav', async () => {
    wireRequest(() => {})
    render(<Tab ctx={{ app: 'live', config: {} }} pluginId="streamflow" />)
    expect(await screen.findByTestId('section-workflows')).toBeTruthy()
    expect(screen.getByTestId('section-editor')).toBeTruthy()
    expect(screen.getByTestId('section-runs')).toBeTruthy()
  })

  it('opens a workflow, adds two boxes, connects them and Saves a graph_json', async () => {
    let saved: unknown = null
    wireRequest((body) => {
      saved = body
    })
    render(<Tab ctx={{ app: 'live', config: {} }} pluginId="streamflow" />)

    // Open the (mocked) workflow → editor.
    fireEvent.click((await screen.findAllByTestId('wf-open'))[0])

    // Add a trigger + an action from the palette.
    fireEvent.click(await screen.findByTestId('sf-palette-trigger.manual'))
    fireEvent.click(await screen.findByTestId('sf-palette-action.notify'))

    // Two nodes on the canvas.
    await waitFor(() => expect(screen.getAllByTestId(/^sf-node-/).length).toBe(2))

    // Connect: pointer-down on the first OUTPUT dot, up on the first INPUT dot.
    const outs = document.querySelectorAll('[data-port-side="out"]')
    const ins = document.querySelectorAll('[data-port-side="in"]')
    expect(outs.length).toBeGreaterThan(0)
    expect(ins.length).toBeGreaterThan(0)
    fireEvent.pointerDown(outs[0])
    fireEvent.pointerUp(ins[0])

    // One cable drawn.
    await waitFor(() => expect(screen.getAllByTestId('sf-edge').length).toBe(1))

    // Save → PUT graph_json with 2 boxes + 1 edge.
    fireEvent.click(screen.getByTestId('sf-save'))
    await waitFor(() => expect(saved).not.toBeNull())
    const body = saved as { graph: { boxes: unknown[]; edges: { fromPort: string; toPort: string }[] } }
    expect(body.graph.boxes).toHaveLength(2)
    expect(body.graph.edges).toHaveLength(1)
    expect(body.graph.edges[0].fromPort).toBe('out')
    expect(body.graph.edges[0].toPort).toBe('in')
  })

  it('is CONTROLLED by ctx.section when the host drives the URL (deep link)', async () => {
    wireRequest(() => {})
    const onSectionChange = vi.fn()
    // Host passes section='runs' + a change handler (as StudioAppPage does when
    // the :section route param is present) → the Runs section renders, not the
    // internal default (workflows).
    render(
      <Tab
        ctx={{ app: 'live', config: {}, section: 'runs', onSectionChange }}
        pluginId="streamflow"
      />,
    )
    // Runs section empty-state proves the runs view (not workflows) is active.
    expect(await screen.findByText('runs.empty')).toBeTruthy()

    // Clicking another section asks the HOST to navigate (no internal switch).
    fireEvent.click(screen.getByTestId('section-editor'))
    expect(onSectionChange).toHaveBeenCalledWith('editor')
    // Still on runs — the surface is controlled, so it only changes when the
    // URL (and thus ctx.section) changes.
    expect(screen.getByText('runs.empty')).toBeTruthy()
  })
})
