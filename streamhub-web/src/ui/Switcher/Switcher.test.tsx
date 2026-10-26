/**
 * Component/DOM test — Switcher (vitest + jsdom + @testing-library/react).
 *
 * Regression guard for the bug where a CONTROLLED Switcher reported the CURRENT
 * value to `onChange` instead of the intended NEW one, so every controlled
 * dashboard toggle (plugins, recording, config) was stuck: clicking an OFF
 * toggle sent `false`, the parent set it to false, nothing changed. This is
 * exactly the kind of DOM-wiring failure the logic-only `node --test` suite
 * could never catch — it never mounts the component.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'

// Isolate the Switcher from the theme context.
vi.mock('../ConfigProvider', () => ({
  useConfig: () => ({ themeColor: 'blue', primaryColorLevel: 500 }),
}))

import Switcher from './Switcher'

function clickCheckbox(container: HTMLElement) {
  const input = container.querySelector(
    'input[type="checkbox"]',
  ) as HTMLInputElement
  fireEvent.click(input)
}

describe('Switcher — onChange value contract', () => {
  it('CONTROLLED + off → reports true (the intended new value) on click', () => {
    const onChange = vi.fn()
    const { container } = render(
      <Switcher checked={false} onChange={onChange} />,
    )
    clickCheckbox(container)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0]).toBe(true)
  })

  it('CONTROLLED + on → reports false on click', () => {
    const onChange = vi.fn()
    const { container } = render(
      <Switcher checked={true} onChange={onChange} />,
    )
    clickCheckbox(container)
    expect(onChange.mock.calls[0][0]).toBe(false)
  })

  it('UNCONTROLLED → reports the new value on click', () => {
    const onChange = vi.fn()
    const { container } = render(<Switcher onChange={onChange} />)
    clickCheckbox(container)
    expect(onChange.mock.calls[0][0]).toBe(true)
  })

  it('disabled → does not fire onChange', () => {
    const onChange = vi.fn()
    const { container } = render(
      <Switcher checked={false} disabled onChange={onChange} />,
    )
    clickCheckbox(container)
    expect(onChange).not.toHaveBeenCalled()
  })
})
