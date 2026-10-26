/**
 * Component/DOM test — Account/SmtpCard (owner item 29: per-user SMTP
 * override). vitest + jsdom + @testing-library, `@/api` mocked (no network).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

const { getSmtp, putSmtp, testSmtp } = vi.hoisted(() => ({
  getSmtp: vi.fn(),
  putSmtp: vi.fn(),
  testSmtp: vi.fn(),
}))

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return {
    ...actual,
    api: { account: { getSmtp, putSmtp, testSmtp } },
  }
})

import { SmtpCard } from './SmtpCard'

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

describe('Account/SmtpCard (owner item 29)', () => {
  beforeEach(() => {
    getSmtp.mockReset().mockResolvedValue({
      enabled: false,
      host: '',
      port: 587,
      user: '',
      from: '',
      pass: '',
      hasPass: false,
      configured: false,
    })
    putSmtp.mockReset()
    testSmtp.mockReset()
  })

  it('loads the masked config and leaves the password field empty', async () => {
    getSmtp.mockResolvedValue({
      enabled: true,
      host: 'smtp.example.com',
      port: 465,
      user: 'me@example.com',
      from: 'Me <me@example.com>',
      pass: 'ab***yz',
      hasPass: true,
      configured: true,
    })
    render(<SmtpCard />, { wrapper: wrapper() })

    const hostInput = (await screen.findByPlaceholderText(
      'smtp.example.com',
    )) as HTMLInputElement
    await waitFor(() => expect(hostInput.value).toBe('smtp.example.com'))

    const passInput = screen.getByPlaceholderText('ab***yz') as HTMLInputElement
    expect(passInput.value).toBe('')
  })

  it('Save omits pass when left empty (keeps the stored one)', async () => {
    putSmtp.mockResolvedValue({})
    render(<SmtpCard />, { wrapper: wrapper() })

    const hostInput = await screen.findByPlaceholderText('smtp.example.com')
    fireEvent.change(hostInput, { target: { value: 'new.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'security.smtp.save' }))

    await waitFor(() =>
      expect(putSmtp).toHaveBeenCalledWith({
        enabled: false,
        host: 'new.example.com',
        port: 587,
        user: '',
        from: '',
      }),
    )
  })

  it('Save sends a trimmed pass when a new one is typed', async () => {
    putSmtp.mockResolvedValue({})
    render(<SmtpCard />, { wrapper: wrapper() })

    const hostInput = await screen.findByPlaceholderText('smtp.example.com')
    fireEvent.change(hostInput, { target: { value: 'smtp.example.com' } })
    const passInput = screen.getByPlaceholderText('••••••••')
    fireEvent.change(passInput, { target: { value: '  new-secret  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'security.smtp.save' }))

    await waitFor(() =>
      expect(putSmtp).toHaveBeenCalledWith(
        expect.objectContaining({ pass: 'new-secret' }),
      ),
    )
  })

  it('disables "Send test" while there are unsaved changes', async () => {
    render(<SmtpCard />, { wrapper: wrapper() })

    const testToInput = await screen.findByPlaceholderText('you@example.com')
    fireEvent.change(testToInput, { target: { value: 'you@example.com' } })

    const hostInput = screen.getByPlaceholderText('smtp.example.com')
    fireEvent.change(hostInput, { target: { value: 'dirty.example.com' } })

    fireEvent.click(
      screen.getByRole('button', { name: 'security.smtp.testSend' }),
    )
    expect(testSmtp).not.toHaveBeenCalled()
  })

  it('sends a test email with { to } once the form is clean', async () => {
    testSmtp.mockResolvedValue({ ok: true, messageId: '<id>' })
    render(<SmtpCard />, { wrapper: wrapper() })

    const testToInput = await screen.findByPlaceholderText('you@example.com')
    fireEvent.change(testToInput, { target: { value: 'you@example.com' } })

    fireEvent.click(
      screen.getByRole('button', { name: 'security.smtp.testSend' }),
    )
    await waitFor(() =>
      expect(testSmtp).toHaveBeenCalledWith({ to: 'you@example.com' }),
    )
    await screen.findByText('security.smtp.testSent')
  })
})
