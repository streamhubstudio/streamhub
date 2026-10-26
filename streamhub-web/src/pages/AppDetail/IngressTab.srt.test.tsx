/**
 * Component/DOM test — IngressTab, SRT (push) ingest flow.
 *
 * SRT is passthrough-ONLY (LiveKit's ingress API has no SRT input type; the
 * backend 400s `inputType:'srt'` without `mode:'passthrough'`). Covers the UI
 * contract at the component layer:
 *  - selecting "SRT (push)" FORCES + LOCKS the passthrough toggle ON
 *    (checked + disabled, with the "SRT only works in passthrough" note),
 *    disables the transcode + backup controls, and renders the passthrough
 *    loss warning + the SRT note (UDP / ~120 ms latency / streamid credential);
 *    switching back to RTMP releases the lock;
 *  - submitting posts exactly `{ inputType:'srt', mode:'passthrough' }` (no
 *    `enableTranscoding`/`backup`/`url`);
 *  - an SRT create RESPONSE reveals the `srt://…?streamid=…` push URL + the
 *    `ptk_` key + `capabilities.latencyMs` note (and NO rtmp_url field);
 *  - the listing gives SRT passthrough rows an "SRT" badge next to the
 *    passthrough badge (suppressing the generic lowercase inputType badge);
 *  - REGRESSION: the default RTMP flow is unchanged (transcode/backup usable,
 *    payload keeps enableTranscoding+backup and no mode).
 *
 * `@/api` is mocked (ingress + ws-ingest); react-i18next is stubbed to echo
 * keys so assertions are text-independent. No network, no i18n bootstrap.
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

/** Wire shape of POST /apps/:app/ingress for an SRT passthrough create. */
const SRT_RESPONSE = {
  mode: 'passthrough' as const,
  ingressId: 'pti_srt_abc123',
  inputType: 'srt' as const,
  stream_key: 'ptk_srt_secret',
  // NO rtmp_url — the push URL has no path; the key rides as ?streamid=.
  srt_url: 'srt://stream.example.com:1938?streamid=ptk_srt_secret',
  hls_url: '/hls/live/ch1/index.m3u8',
  player_url: '/play/live/ch1',
  capabilities: {
    mode: 'passthrough' as const,
    latencyMs: 120,
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

/** Switch the create form's input-type <select> (the tab's only combobox). */
function selectInputType(value: string) {
  fireEvent.change(screen.getByRole('combobox'), { target: { value } })
}

describe('IngressTab — SRT (push) ingest flow', () => {
  beforeEach(() => {
    ingressList.mockReset().mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 })
    wsList.mockReset().mockResolvedValue([])
    ingressCreate.mockReset().mockResolvedValue(SRT_RESPONSE)
    ingressRemove.mockReset()
    wsCreate.mockReset()
    wsRemove.mockReset()
  })

  it('selecting SRT forces+locks passthrough ON and disables transcode/backup; RTMP releases the lock', () => {
    renderTab()

    selectInputType('srt')

    const passthrough = screen.getByRole('checkbox', {
      name: 'create.passthrough.title',
    }) as HTMLInputElement
    const transcode = screen.getByRole('checkbox', {
      name: 'create.transcodeTitle',
    }) as HTMLInputElement
    const backup = screen.getByRole('checkbox', {
      name: 'create.backupTitle',
    }) as HTMLInputElement

    // Locked ON: checked (Switcher mirrors `checked` into value/label class)
    // and disabled, with the "SRT only works in passthrough" note.
    expect(passthrough.disabled).toBe(true)
    expect(passthrough.value).toBe('true')
    expect(passthrough.closest('label')?.className).toContain('switcher-checked')
    expect(screen.getByText('create.passthrough.srtForced')).toBeTruthy()

    // Mutually-exclusive controls are disabled.
    expect(transcode.disabled).toBe(true)
    expect(backup.disabled).toBe(true)

    // Passthrough loss warning + the SRT note (UDP / latency / streamid=credential).
    expect(screen.getByText('create.passthrough.warningTitle')).toBeTruthy()
    expect(screen.getByText('create.srt.noteTitle')).toBeTruthy()
    expect(screen.getByText('create.srt.note.udp')).toBeTruthy()
    expect(screen.getByText('create.srt.note.latency')).toBeTruthy()
    expect(screen.getByText('create.srt.note.credential')).toBeTruthy()

    // Switching back to RTMP releases the lock (nothing sticks).
    selectInputType('rtmp')
    expect(
      (screen.getByRole('checkbox', { name: 'create.passthrough.title' }) as HTMLInputElement)
        .disabled,
    ).toBe(false)
    expect(
      (screen.getByRole('checkbox', { name: 'create.transcodeTitle' }) as HTMLInputElement)
        .disabled,
    ).toBe(false)
    expect(
      (screen.getByRole('checkbox', { name: 'create.backupTitle' }) as HTMLInputElement)
        .disabled,
    ).toBe(false)
    expect(screen.queryByText('create.passthrough.srtForced')).toBeNull()
  })

  it('submitting an SRT create posts exactly {inputType:srt, mode:passthrough}', async () => {
    renderTab()

    selectInputType('srt')
    fireEvent.click(screen.getByRole('button', { name: 'create.submit' }))

    await waitFor(() => expect(ingressCreate).toHaveBeenCalledTimes(1))
    const [app, payload] = ingressCreate.mock.calls[0]
    expect(app).toBe('live')
    // The whole payload: no enableTranscoding/backup/url ever rides along.
    expect(payload).toEqual({ inputType: 'srt', mode: 'passthrough' })
  })

  it('renders the srt://…?streamid=… URL, the key and the latency note on an SRT create', async () => {
    renderTab()

    selectInputType('srt')
    fireEvent.click(screen.getByRole('button', { name: 'create.submit' }))

    // The SRT push URL is revealed in a copyable field (key rides as streamid).
    const srtField = await screen.findByDisplayValue(
      'srt://stream.example.com:1938?streamid=ptk_srt_secret',
    )
    expect((srtField as HTMLInputElement).value).toContain('?streamid=')
    expect(screen.getByText('details.srtUrl')).toBeTruthy()

    // The ptk_ key, HLS URL + player link render too.
    expect(screen.getByDisplayValue('ptk_srt_secret')).toBeTruthy()
    expect(screen.getByDisplayValue('/hls/live/ch1/index.m3u8')).toBeTruthy()
    expect(screen.getByDisplayValue('/play/live/ch1')).toBeTruthy()

    // capabilities.latencyMs surfaces as the SRT latency note + SRT badge; an
    // SRT create has NO rtmp_url field.
    expect(screen.getByText('details.srtLatency')).toBeTruthy()
    expect(screen.getByText('details.srtBadge')).toBeTruthy()
    expect(screen.queryByText('details.rtmpUrl')).toBeNull()

    // The exact capabilities.lost lines the API returned render in the warning.
    expect(screen.getByText('No WebRTC / sub-second playback — HLS only.')).toBeTruthy()
  })

  it('list rows: SRT passthrough ingresses get an SRT badge next to the passthrough badge', async () => {
    ingressList.mockResolvedValue({
      items: [
        {
          ingressId: 'pti_srt_x1',
          mode: 'passthrough',
          inputType: 'srt',
          room: 'live-ch1',
          roomName: 'live-ch1',
          status: 'inactive',
          stream_key: 'ptk_k1',
          srt_url: 'srt://h:1938?streamid=ptk_k1',
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

    // The SRT row shows the dedicated badge + the passthrough badge…
    expect(await screen.findByText('list.srtBadge')).toBeTruthy()
    expect(screen.getByText('list.passthroughBadge')).toBeTruthy()
    // …and its generic lowercase inputType badge is suppressed (no double
    // "srt"+"SRT"), while the RTMP row keeps its generic badge.
    expect(screen.queryByText('srt')).toBeNull()
    expect(screen.getByText('rtmp')).toBeTruthy()
  })

  it('REGRESSION: the default RTMP flow still posts enableTranscoding+backup and no mode', async () => {
    renderTab()

    // Untouched form: transcode + backup usable, passthrough unchecked.
    const passthrough = screen.getByRole('checkbox', {
      name: 'create.passthrough.title',
    }) as HTMLInputElement
    expect(passthrough.disabled).toBe(false)
    expect(passthrough.value).toBe('false')
    expect(
      (screen.getByRole('checkbox', { name: 'create.transcodeTitle' }) as HTMLInputElement)
        .disabled,
    ).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'create.submit' }))

    await waitFor(() => expect(ingressCreate).toHaveBeenCalledTimes(1))
    const [app, payload] = ingressCreate.mock.calls[0]
    expect(app).toBe('live')
    expect(payload).toEqual({
      inputType: 'rtmp',
      enableTranscoding: true,
      backup: true,
    })
  })
})
