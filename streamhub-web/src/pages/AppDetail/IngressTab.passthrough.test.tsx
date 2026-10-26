/**
 * Component/DOM test — IngressTab, RTMP→HLS passthrough (remux) create flow.
 *
 * Covers the passthrough UI end-to-end at the component layer:
 *  - selecting "Passthrough" DISABLES the transcode + backup controls (they are
 *    mutually exclusive — the backend also rejects the mix with a 400) and
 *    renders the "what you lose" warning;
 *  - submitting posts `mode: 'passthrough'` (and no `enableTranscoding`/`backup`);
 *  - a passthrough create RESPONSE renders the :1937 push URL + the returned
 *    capabilities.lost lines;
 *  - a 503 (feature disabled server-side) shows the "enable it on the server"
 *    message rather than the generic error.
 *
 * `@/api` is mocked (ingress + ws-ingest); react-i18next is stubbed to echo keys
 * so assertions are text-independent. No network, no i18n bootstrap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}))

const { ingressList, ingressCreate, ingressRemove, wsList, wsCreate, wsRemove } =
  vi.hoisted(() => ({
    ingressList: vi.fn(),
    ingressCreate: vi.fn(),
    ingressRemove: vi.fn(),
    wsList: vi.fn(),
    wsCreate: vi.fn(),
    wsRemove: vi.fn(),
  }))

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return {
    ...actual, // keep the real ApiRequestError (used by isServiceUnavailable/errMessage)
    api: {
      ingress: { list: ingressList, create: ingressCreate, remove: ingressRemove },
      wsIngest: { list: wsList, create: wsCreate, remove: wsRemove },
    },
  }
})

import { ApiRequestError } from '@/api'
import { IngressTab } from './IngressTab'

const PASSTHROUGH_RESPONSE = {
  mode: 'passthrough' as const,
  ingressId: 'pti_abc123',
  stream_key: 'ptk_secret',
  rtmp_url: 'rtmp://stream.example.com:1937/live/ptk_secret',
  hls_url: '/hls/live/ch1/index.m3u8',
  player_url: '/play/live/ch1',
  capabilities: {
    mode: 'passthrough' as const,
    lost: [
      'No WebRTC / sub-second playback — HLS only.',
      'No adaptive bitrate (ABR).',
    ],
  },
}

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

function renderTab() {
  return render(<IngressTab app="live" />, { wrapper: wrapper() })
}

describe('IngressTab — RTMP→HLS passthrough create flow', () => {
  beforeEach(() => {
    ingressList.mockReset().mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 })
    wsList.mockReset().mockResolvedValue([])
    ingressCreate.mockReset().mockResolvedValue(PASSTHROUGH_RESPONSE)
    ingressRemove.mockReset()
    wsCreate.mockReset()
    wsRemove.mockReset()
  })

  it('selecting passthrough disables transcode + backup and warns; submit posts mode=passthrough', async () => {
    renderTab()

    const passthrough = screen.getByRole('checkbox', {
      name: 'create.passthrough.title',
    }) as HTMLInputElement
    const transcode = screen.getByRole('checkbox', {
      name: 'create.transcodeTitle',
    }) as HTMLInputElement
    const backup = screen.getByRole('checkbox', {
      name: 'create.backupTitle',
    }) as HTMLInputElement

    // Before selecting passthrough the mutually-exclusive controls are usable.
    expect(transcode.disabled).toBe(false)
    expect(backup.disabled).toBe(false)

    fireEvent.click(passthrough)

    // (a) transcode + backup become disabled (mutual exclusion).
    expect(transcode.disabled).toBe(true)
    expect(backup.disabled).toBe(true)
    // (b) the "what you lose" warning renders.
    expect(screen.getByText('create.passthrough.warningTitle')).toBeTruthy()

    // (c) submitting calls the API with mode:'passthrough' and no transcode/backup.
    fireEvent.click(screen.getByRole('button', { name: 'create.submit' }))

    await waitFor(() => expect(ingressCreate).toHaveBeenCalledTimes(1))
    const [app, payload] = ingressCreate.mock.calls[0]
    expect(app).toBe('live')
    expect(payload.inputType).toBe('rtmp')
    expect(payload.mode).toBe('passthrough')
    expect(payload.enableTranscoding).toBeUndefined()
    expect(payload.backup).toBeUndefined()
  })

  it('renders the :1937 rtmp_url and the returned lost-capabilities on a passthrough create', async () => {
    renderTab()

    fireEvent.click(screen.getByRole('checkbox', { name: 'create.passthrough.title' }))
    fireEvent.click(screen.getByRole('button', { name: 'create.submit' }))

    // The push URL (:1937) is revealed in a copyable field.
    const rtmpField = await screen.findByDisplayValue(
      'rtmp://stream.example.com:1937/live/ptk_secret',
    )
    expect(rtmpField).toBeTruthy()
    expect((rtmpField as HTMLInputElement).value).toContain(':1937')

    // The HLS URL and the exact capabilities.lost lines the API returned render.
    expect(screen.getByDisplayValue('/hls/live/ch1/index.m3u8')).toBeTruthy()
    expect(
      screen.getByText('No WebRTC / sub-second playback — HLS only.'),
    ).toBeTruthy()
  })

  it('shows the server-disabled message when the API returns 503', async () => {
    ingressCreate.mockRejectedValueOnce(
      new ApiRequestError('RTMP passthrough plane is unavailable', 503),
    )
    renderTab()

    fireEvent.click(screen.getByRole('checkbox', { name: 'create.passthrough.title' }))
    fireEvent.click(screen.getByRole('button', { name: 'create.submit' }))

    await waitFor(() =>
      expect(screen.getByText('create.passthrough.disabled503')).toBeTruthy(),
    )
  })
})
