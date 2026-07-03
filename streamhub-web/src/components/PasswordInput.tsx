/**
 * Password field with an Elstar-style reveal toggle. Thin wrapper over the
 * ported `<Input>` that adds a show/hide eye in the suffix slot. Purely
 * presentational — it forwards every prop straight through to `<Input>`, so the
 * page keeps owning the value/onChange (no form library involved).
 */
import { useState } from 'react'
import { HiOutlineEye, HiOutlineEyeOff } from 'react-icons/hi'
import { Input, type InputProps } from '@/ui'

export function PasswordInput(props: InputProps) {
  const [show, setShow] = useState(false)
  return (
    <Input
      {...props}
      type={show ? 'text' : 'password'}
      suffix={
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setShow((s) => !s)}
          aria-label={show ? 'Hide password' : 'Show password'}
          className="text-lg text-fg-subtle transition hover:text-fg"
        >
          {show ? <HiOutlineEyeOff /> : <HiOutlineEye />}
        </button>
      }
    />
  )
}
