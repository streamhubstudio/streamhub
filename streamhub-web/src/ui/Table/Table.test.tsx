/**
 * Component/DOM test — Table primitive (vitest + jsdom + @testing-library).
 *
 * The mobile-first invariant every data page relies on: the `@/ui` Table wraps
 * its `<table>` in an `overflow-x-auto` container, so wide tables scroll INSIDE
 * their own box instead of pushing the page past the viewport at 320px. Streams,
 * VODs, Tokens, Cluster, the ClusterEdge assignments matrix, Audit, etc. all use
 * this primitive, so locking it here covers them in one place.
 */
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import Table from './Table'

describe('Table primitive — horizontal overflow guard', () => {
  it('wraps the table in an overflow-x-auto container by default', () => {
    const { container } = render(
      <Table>
        <tbody>
          <tr>
            <td>cell</td>
          </tr>
        </tbody>
      </Table>,
    )
    const wrapper = container.querySelector('table')?.parentElement
    expect(wrapper).toBeTruthy()
    expect(wrapper?.className).toContain('overflow-x-auto')
  })

  it('can opt out of the wrapper when overflow=false', () => {
    const { container } = render(
      <Table overflow={false}>
        <tbody>
          <tr>
            <td>cell</td>
          </tr>
        </tbody>
      </Table>,
    )
    const wrapper = container.querySelector('table')?.parentElement
    expect(wrapper?.className).not.toContain('overflow-x-auto')
  })
})
