/**
 * Component/DOM test — IngressTab, MPEG-TS over UDP (multicast/unicast) PULL flow.
 *
 * MPEG-TS is passthrough-ONLY (LiveKit has no such input; the backend 400s
 * `inputType:'mpegts'` without `mode:'passthrough'`) and is a PULL — no push key,
 * no backup. Covers the UI contract at the component layer:
 *  - selecting "MPEG-TS / UDP" FORCES + LOCKS the passthrough toggle ON, disables
 *    transcode, HIDES the backup control, renders the udp source + SSM + interface
 *    + fifo fields and the passthrough-loss warning + the MPEG-TS note;
 *  - submit is disabled until a udp source is entered, then posts exactly
 *    `{ inputType:'mpegts', mode:'passthrough', url, sources }` (no transcode/backup);
 *  - an MPEG-TS create RESPONSE reveals the source_url + hls_url (and NO rtmp_url
 *    / stream key), plus the MPEG-TS badge;
 *  - the listing gives MPEG-TS rows an "MPEG-TS" badge (suppressing the generic
 *    lowercase inputType badge);
 *  - REGRESSION: the default RTMP flow is unchanged.
 *
 * `@/api` is mocked; react-i18next is stubbed to echo keys. No network, no i18n.
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
    ...actual,
    api: {
      ingress: { list: ingressList, create: ingressCreate, remove: ingressRemove },
      wsIngest: { list: wsList, create: wsCreate, remove: wsRemove },
    },
  }
})

import { IngressTab } from './IngressTab'

/** Wire shape of POST /apps/:app/ingress for an MPEG-TS passthrough create. */
const MPEGTS_RESPONSE = {
  mode: 'passthrough' as const,
  ingressId: 'pti_mpegts_abc123',
  inputType: 'mpegts' as const,
  source_url: 'udp://@239.1.1.1:5000?sources=10.0.0.5&overrun_nonfatal=1',
  hls_url: '/hls/live/mc1/index.m3u8',
  player_url: '/play/live/mc1',
  capabilities: {
    mode: 'passthrough' as const,
    lost: ['No WebRTC / sub-second playback — HLS only.'],
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

function selectInputType(value: string) {
  fireEvent.change(screen.getByRole('combobox'), { target: { value } })
}

describe('IngressTab — MPEG-TS / UDP ingest flow', () => {
  beforeEach(() => {
    ingressList.mockReset().mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 })
    wsList.mockReset().mockResolvedValue([])
    ingressCreate.mockReset().mockResolvedValue(MPEGTS_RESPONSE)
    ingressRemove.mockReset()
    wsCreate.mockReset()
    wsRemove.mockReset()
  })

  it('forces+locks passthrough, disables transcode, HIDES backup, shows udp fields + note', () => {
    renderTab()

    selectInputType('mpegts')

    const passthrough = screen.getByRole('checkbox', {
      name: 'create.passthrough.title',
    }) as HTMLInputElement
    const transcode = screen.getByRole('checkbox', {
      name: 'create.transcodeTitle',
    }) as HTMLInputElement

    expect(passthrough.disabled).toBe(true)
    expect(passthrough.value).toBe('true')
    expect(screen.getByText('create.passthrough.mpegtsForced')).toBeTruthy()
    expect(transcode.disabled).toBe(true)
    // Backup control is hidden entirely (a PULL has no push key to fail over).
    expect(screen.queryByRole('checkbox', { name: 'create.backupTitle' })).toBeNull()

    // The udp source + SSM + interface + fifo fields + the MPEG-TS note render.
    expect(screen.getByText('create.mpegts.sourceLabel')).toBeTruthy()
    expect(screen.getByText('create.mpegts.sourcesLabel')).toBeTruthy()
    expect(screen.getByText('create.mpegts.localaddrLabel')).toBeTruthy()
    expect(screen.getByText('create.mpegts.fifoLabel')).toBeTruthy()
    expect(screen.getByText('create.mpegts.noteTitle')).toBeTruthy()
    expect(screen.getByText('create.passthrough.warningTitle')).toBeTruthy()

    // Switching back to RTMP releases the lock + hides the udp fields.
    selectInputType('rtmp')
    expect(
      (screen.getByRole('checkbox', { name: 'create.passthrough.title' }) as HTMLInputElement)
        .disabled,
    ).toBe(false)
    expect(screen.queryByText('create.mpegts.sourceLabel')).toBeNull()
  })

  it('blocks submit until a udp source is entered, then posts inputType+mode+url+sources', async () => {
    renderTab()
    selectInputType('mpegts')

    const submit = screen.getByRole('button', { name: 'create.submit' })
    // The Button guards its click handler while disabled — no source ⇒ no create.
    fireEvent.click(submit)
    expect(ingressCreate).not.toHaveBeenCalled()

    fireEvent.change(screen.getByPlaceholderText('udp://@239.1.1.1:5000'), {
      target: { value: 'udp://@239.1.1.1:5000' },
    })
    fireEvent.change(screen.getByPlaceholderText('10.0.0.5'), {
      target: { value: '10.0.0.5' },
    })

    fireEvent.click(submit)
    await waitFor(() => expect(ingressCreate).toHaveBeenCalledTimes(1))
    const [app, payload] = ingressCreate.mock.calls[0]
    expect(app).toBe('live')
    expect(payload).toEqual({
      inputType: 'mpegts',
      mode: 'passthrough',
      url: 'udp://@239.1.1.1:5000',
      sources: '10.0.0.5',
    })
  })

  it('reveals the source_url + hls_url + MPEG-TS badge on a create (no rtmp_url / key)', async () => {
    renderTab()
    selectInputType('mpegts')
    fireEvent.change(screen.getByPlaceholderText('udp://@239.1.1.1:5000'), {
      target: { value: 'udp://@239.1.1.1:5000' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'create.submit' }))

    const srcField = await screen.findByDisplayValue(
      'udp://@239.1.1.1:5000?sources=10.0.0.5&overrun_nonfatal=1',
    )
    expect(srcField).toBeTruthy()
    expect(screen.getByText('details.sourceUrl')).toBeTruthy()
    expect(screen.getByText('details.mpegtsBadge')).toBeTruthy()
    expect(screen.getByDisplayValue('/hls/live/mc1/index.m3u8')).toBeTruthy()
    // No push URL / stream key for a PULL.
    expect(screen.queryByText('details.rtmpUrl')).toBeNull()
    expect(screen.queryByText('details.streamKey')).toBeNull()
  })

  it('list rows: MPEG-TS ingresses get an MPEG-TS badge; the generic inputType badge is suppressed', async () => {
    ingressList.mockResolvedValue({
      items: [
        {
          ingressId: 'pti_mpegts_x1',
          mode: 'passthrough',
          inputType: 'mpegts',
          room: 'live-mc1',
          roomName: 'live-mc1',
          status: 'inactive',
          source_url: 'udp://@239.1.1.1:5000?overrun_nonfatal=1',
          viewers: null,
        },
        {
          ingressId: 'IN_abc',
          inputType: 'rtmp',
          room: 'live-demo',
          roomName: 'live-demo',
          status: 'inactive',
          stream_key: 'k2',
          rtmp_url: 'rtmp://h:1935/live/k2',
        },
      ],
      total: 2,
      limit: 20,
      offset: 0,
    })
    renderTab()

    expect(await screen.findByText('list.mpegtsBadge')).toBeTruthy()
    expect(screen.getByText('list.passthroughBadge')).toBeTruthy()
    // The generic lowercase "mpegts" badge is suppressed; the RTMP row keeps its badge.
    expect(screen.queryByText('mpegts')).toBeNull()
    expect(screen.getByText('rtmp')).toBeTruthy()
  })

  it('REGRESSION: the default RTMP flow still posts enableTranscoding+backup and no mode', async () => {
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'create.submit' }))
    await waitFor(() => expect(ingressCreate).toHaveBeenCalledTimes(1))
    const [, payload] = ingressCreate.mock.calls[0]
    expect(payload).toEqual({ inputType: 'rtmp', enableTranscoding: true, backup: true })
  })
})
