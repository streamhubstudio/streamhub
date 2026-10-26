/**
 * Component/DOM test — the Live Control Overlay cover, mounted through the real
 * plugin default export. `@/api/http` + `@livekit/components-react` are mocked
 * (no network, no LiveKit); react-i18next echoes keys.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}))

vi.mock('@livekit/components-react', () => ({
  useMaybeRoomContext: () => null,
  useDataChannel: () => ({}),
}))

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))
vi.mock('@/api/http', () => ({ request: requestMock }))

import plugin from './index.tsx'
const Overlay = plugin.OverlayComponent!

beforeEach(() => requestMock.mockReset())

describe('Live Control Overlay', () => {
  it('renders the text-card cover while paused', async () => {
    requestMock.mockResolvedValue({
      streamId: 's1',
      room: 'r1',
      state: 'paused',
      since: 't',
      cover: { mode: 'text', assetId: null, cardTitle: 'Back soon', cardText: 'Paused', cardColor: '#101014', assetUrl: null },
    })

    render(<Overlay ctx={{ app: 'live', room: 'r1', config: {} }} pluginId="live-control-overlay" />)

    await waitFor(() => expect(screen.getByTestId('live-control-cover')).toBeTruthy())
    expect(screen.getByText('Back soon')).toBeTruthy()
  })

  it('renders nothing while the stream is live', async () => {
    requestMock.mockResolvedValue({ streamId: 's1', room: 'r1', state: 'live', since: null, cover: null })

    const { container } = render(
      <Overlay ctx={{ app: 'live', room: 'r1', config: {} }} pluginId="live-control-overlay" />,
    )
    await waitFor(() => expect(requestMock).toHaveBeenCalled())
    expect(screen.queryByTestId('live-control-cover')).toBeNull()
    expect(container.querySelector('img,video')).toBeNull()
  })
})
