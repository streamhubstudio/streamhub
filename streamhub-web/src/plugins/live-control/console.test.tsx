/**
 * Component/DOM test — the Live Control console, mounted through the real plugin
 * default export. `./api.ts` is mocked (no network); react-i18next echoes keys.
 *
 * Guards the operator contract at the component layer:
 *  - the stream list renders with a state badge from GET .../streams;
 *  - clicking Pause opens the cover editor and confirming POSTs pause with the
 *    resolved override body;
 *  - a paused stream shows Resume, which POSTs resume.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) => (o && 'count' in o ? `${k}:${o.count}` : k),
    i18n: { language: 'en' },
  }),
}))

const api = vi.hoisted(() => ({
  listStreams: vi.fn(),
  getSettings: vi.fn(),
  listAssets: vi.fn(),
  pauseStream: vi.fn(),
  resumeStream: vi.fn(),
  finishStream: vi.fn(),
  uploadAsset: vi.fn(),
  deleteAsset: vi.fn(),
  updateSettings: vi.fn(),
}))
vi.mock('./api.ts', () => api)

import plugin from './index.tsx'
const Tab = plugin.TabComponent!

const SETTINGS = {
  defaultMode: 'text',
  defaultCardTitle: 'Back soon',
  defaultCardText: 'Paused',
  defaultCardColor: '#0b0b0f',
  muteAudioServerSide: true,
  pollSeconds: 30,
  defaultPauseAssetId: null,
  defaultFinishAssetId: null,
}

function stream(state: 'live' | 'paused' | 'finished') {
  return {
    streamId: 's1',
    type: 'rtmp',
    room: 'live-r1',
    status: 'live',
    startedAt: '',
    participant: 'pub1',
    control: { streamId: 's1', room: 'live-r1', state, since: null, cover: null },
  }
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.getSettings.mockResolvedValue(SETTINGS)
  api.listAssets.mockResolvedValue([])
  api.pauseStream.mockResolvedValue({})
  api.resumeStream.mockResolvedValue({})
})

describe('Live Control console', () => {
  it('lists streams and pauses with the resolved override body', async () => {
    api.listStreams.mockResolvedValue({ streams: [stream('live')], generatedAt: '' })

    render(<Tab ctx={{ app: 'live', config: {} }} pluginId="live-control" />)

    await waitFor(() => expect(screen.getByText('s1')).toBeTruthy())
    expect(screen.getByText('state.live')).toBeTruthy()

    fireEvent.click(screen.getByText('actions.pause'))
    // Editor opened → confirm button visible.
    const confirm = await screen.findByText('actions.confirmPause')
    fireEvent.click(confirm)

    await waitFor(() => expect(api.pauseStream).toHaveBeenCalled())
    const [, streamId, body] = api.pauseStream.mock.calls[0]
    expect(streamId).toBe('s1')
    expect(body).toMatchObject({ mode: 'text', cardTitle: 'Back soon' })
  })

  it('offers Resume for a paused stream and calls resume', async () => {
    api.listStreams.mockResolvedValue({ streams: [stream('paused')], generatedAt: '' })

    render(<Tab ctx={{ app: 'live', config: {} }} pluginId="live-control" />)

    const resume = await screen.findByText('actions.resume')
    fireEvent.click(resume)
    await waitFor(() => expect(api.resumeStream).toHaveBeenCalledWith('live', 's1'))
  })
})
