/**
 * Component test — NodeCanvas run-flow animation (Mission C).
 *
 * Renders the canvas with an edge and asserts that an `activeEdges` set draws the
 * animated `sf-flow` overlay (data-testid="sf-edge-active") only for the active
 * edge, and none when the set is empty.
 */
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}))

import { NodeCanvas } from './NodeCanvas.tsx'
import type { BoxSpec, CanvasGraph } from './graph.util.ts'

const CATALOGUE: BoxSpec[] = [
  { type: 'trigger.manual', group: 'trigger', label: 'Manual', description: '', inputs: [], outputs: ['out'], fields: [] },
  { type: 'action.notify', group: 'action', label: 'Notify', description: '', inputs: ['in'], outputs: ['out'], fields: [] },
]

const graph: CanvasGraph = {
  boxes: [
    { id: 't', type: 'trigger.manual', config: {}, position: { x: 0, y: 0 } },
    { id: 'n', type: 'action.notify', config: {}, position: { x: 300, y: 0 } },
  ],
  edges: [{ id: 'e1', from: 't', fromPort: 'out', to: 'n', toPort: 'in' }],
}

describe('NodeCanvas flow animation', () => {
  it('draws the animated overlay for an active edge', () => {
    const { container } = render(
      <NodeCanvas catalogue={CATALOGUE} graph={graph} onChange={() => {}} activeEdges={new Set(['e1'])} />,
    )
    expect(container.querySelectorAll('[data-testid="sf-edge-active"]').length).toBe(1)
  })

  it('draws no overlay when no edge is active', () => {
    const { container } = render(
      <NodeCanvas catalogue={CATALOGUE} graph={graph} onChange={() => {}} activeEdges={new Set()} />,
    )
    expect(container.querySelectorAll('[data-testid="sf-edge-active"]').length).toBe(0)
  })
})
