/**
 * Component/DOM test — IntegracionesTab's SmtpCard (owner item 29: per-app
 * SMTP override). vitest + jsdom + @testing-library. `IntegracionesTab`
 * mounts ALL its sections at once (no tab-hide like ConfigTab), so every
 * `api.apps.*` method any sibling card calls must be stubbed too, even though
 * this suite only asserts on the SMTP ones.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))

const {
  getConfig,
  updateConfig,
  getMqtt,
  putMqtt,
  getSmtp,
  putSmtp,
  testSmtp,
  getS3,
  putS3,
  mintToken,
} = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  getMqtt: vi.fn(),
  putMqtt: vi.fn(),
  getSmtp: vi.fn(),
  putSmtp: vi.fn(),
  testSmtp: vi.fn(),
  getS3: vi.fn(),
  putS3: vi.fn(),
  mintToken: vi.fn(),
}))

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return {
    ...actual,
    api: {
      apps: {
        getConfig,
        updateConfig,
        getMqtt,
        putMqtt,
        getSmtp,
        putSmtp,
        testSmtp,
        getS3,
        putS3,
      },
      tokens: { mint: mintToken },
    },
  }
})

import { IntegracionesTab } from './IntegracionesTab'

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

describe('IntegracionesTab — SmtpCard (owner item 29)', () => {
  beforeEach(() => {
    getConfig.mockReset().mockResolvedValue({ callbacks: { url: '', secret: '' }, features: {} })
    updateConfig.mockReset()
    getMqtt.mockReset().mockResolvedValue({ enabled: false, events: ['all'], logs: {} })
    putMqtt.mockReset()
    getS3.mockReset().mockResolvedValue({})
    putS3.mockReset()
    mintToken.mockReset()
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
      user: 'no-reply@example.com',
      from: 'App <no-reply@example.com>',
      pass: 'ab***yz',
      hasPass: true,
      configured: true,
    })
    render(<IntegracionesTab app="live" />, { wrapper: wrapper() })

    const hostInput = (await screen.findByPlaceholderText(
      'smtp.example.com',
    )) as HTMLInputElement
    await waitFor(() => expect(hostInput.value).toBe('smtp.example.com'))

    const passInput = screen.getByPlaceholderText('ab***yz') as HTMLInputElement
    expect(passInput.value).toBe('')
  })

  it('Save omits pass when left empty (keeps the stored one)', async () => {
    putSmtp.mockResolvedValue({})
    render(<IntegracionesTab app="live" />, { wrapper: wrapper() })

    const hostInput = await screen.findByPlaceholderText('smtp.example.com')
    fireEvent.change(hostInput, { target: { value: 'new.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'smtp.save' }))

    await waitFor(() =>
      expect(putSmtp).toHaveBeenCalledWith('live', {
        enabled: false,
        host: 'new.example.com',
        port: 587,
        user: '',
        from: '',
      }),
    )
  })

  it('Save sends a trimmed pass when the operator types a new one', async () => {
    putSmtp.mockResolvedValue({})
    render(<IntegracionesTab app="live" />, { wrapper: wrapper() })

    const hostInput = await screen.findByPlaceholderText('smtp.example.com')
    fireEvent.change(hostInput, { target: { value: 'smtp.example.com' } })
    const smtpSection = within(document.getElementById('int-smtp')!)
    const passInput = smtpSection.getByPlaceholderText('••••••••')
    fireEvent.change(passInput, { target: { value: '  new-secret  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'smtp.save' }))

    await waitFor(() =>
      expect(putSmtp).toHaveBeenCalledWith(
        'live',
        expect.objectContaining({ pass: 'new-secret' }),
      ),
    )
  })

  it('disables "Send test" while there are unsaved changes', async () => {
    render(<IntegracionesTab app="live" />, { wrapper: wrapper() })

    const testToInput = await screen.findByPlaceholderText('ops@example.com')
    fireEvent.change(testToInput, { target: { value: 'ops@example.com' } })

    const hostInput = screen.getByPlaceholderText('smtp.example.com')
    fireEvent.change(hostInput, { target: { value: 'dirty.example.com' } })

    fireEvent.click(screen.getByRole('button', { name: 'smtp.testSend' }))
    expect(testSmtp).not.toHaveBeenCalled()
  })

  it('sends a test email with { to } once the form is clean', async () => {
    testSmtp.mockResolvedValue({ ok: true, messageId: '<id>' })
    render(<IntegracionesTab app="live" />, { wrapper: wrapper() })

    const testToInput = await screen.findByPlaceholderText('ops@example.com')
    fireEvent.change(testToInput, { target: { value: 'ops@example.com' } })

    fireEvent.click(screen.getByRole('button', { name: 'smtp.testSend' }))
    await waitFor(() =>
      expect(testSmtp).toHaveBeenCalledWith('live', { to: 'ops@example.com' }),
    )
    await screen.findByText('smtp.testSent')
  })
})
