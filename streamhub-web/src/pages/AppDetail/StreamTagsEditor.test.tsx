/**
 * Component/DOM test — StreamTagsEditor (vitest + jsdom + @testing-library).
 *
 * Guards the per-stream tags UI at the component layer:
 *  - it loads the app's tags + the stream's applied slugs and renders one
 *    checkbox per tag, checked when the slug is currently applied;
 *  - toggling a tag on/off and saving PATCHes the exact slug list and closes;
 *  - the quick create-tag form POSTs a new tag and adds it to the selection.
 *
 * `@/api` tags + streams get/set are mocked; react-i18next echoes keys. No net.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}))

const { tagsList, tagsCreate, getTags, setTags } = vi.hoisted(() => ({
  tagsList: vi.fn(),
  tagsCreate: vi.fn(),
  getTags: vi.fn(),
  setTags: vi.fn(),
}))

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return {
    ...actual,
    api: {
      tags: { list: tagsList, create: tagsCreate },
      streams: { getTags, setTags },
    },
  }
})

import { StreamTagsEditor } from './StreamTagsEditor'
import type { Stream } from '@/api'

const STREAM: Stream = {
  id: 1,
  appId: 1,
  streamId: 'room1/cam',
  type: 'webrtc',
  room: 'room1',
  participant: 'cam',
  status: 'active',
  startedAt: '2026-01-01',
  endedAt: null,
  lastStatsJson: null,
}

const TAGS = [
  { slug: 'store-downtown', label: 'Downtown Store', kind: 'store' },
  { slug: 'zone-entrance', label: 'Entrance', kind: 'zone' },
]

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

function renderEditor(onClose = vi.fn()) {
  return {
    onClose,
    ...render(<StreamTagsEditor app="live" stream={STREAM} onClose={onClose} />, {
      wrapper: wrapper(),
    }),
  }
}

describe('StreamTagsEditor — per-stream tag apply/remove', () => {
  beforeEach(() => {
    tagsList.mockReset().mockResolvedValue(TAGS)
    tagsCreate.mockReset()
    getTags.mockReset()
    setTags.mockReset()
  })

  it('reflects applied tags: applied slug checked, others unchecked', async () => {
    getTags.mockResolvedValue({ streamId: 'room1/cam', tags: ['store-downtown'] })
    renderEditor()

    const a = (await screen.findByRole('checkbox', {
      name: 'Downtown Store',
    })) as HTMLInputElement
    const b = screen.getByRole('checkbox', { name: 'Entrance' }) as HTMLInputElement
    expect(a.checked).toBe(true)
    expect(b.checked).toBe(false)
    expect(getTags).toHaveBeenCalledWith('live', 'room1/cam', expect.anything())
  })

  it('applying a tag PATCHes the new slug list and closes', async () => {
    getTags.mockResolvedValue({ streamId: 'room1/cam', tags: ['store-downtown'] })
    setTags.mockResolvedValue({
      streamId: 'room1/cam',
      tags: ['store-downtown', 'zone-entrance'],
    })
    const { onClose } = renderEditor()

    const b = (await screen.findByRole('checkbox', {
      name: 'Entrance',
    })) as HTMLInputElement
    fireEvent.click(b)
    expect(b.checked).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'tags.save' }))

    await waitFor(() => expect(setTags).toHaveBeenCalledTimes(1))
    expect(setTags).toHaveBeenCalledWith('live', 'room1/cam', [
      'store-downtown',
      'zone-entrance',
    ])
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('removing a tag saves the pruned slug list', async () => {
    getTags.mockResolvedValue({
      streamId: 'room1/cam',
      tags: ['store-downtown', 'zone-entrance'],
    })
    setTags.mockResolvedValue({ streamId: 'room1/cam', tags: ['zone-entrance'] })
    renderEditor()

    const a = (await screen.findByRole('checkbox', {
      name: 'Downtown Store',
    })) as HTMLInputElement
    fireEvent.click(a) // remove store-downtown
    expect(a.checked).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'tags.save' }))
    await waitFor(() =>
      expect(setTags).toHaveBeenCalledWith('live', 'room1/cam', ['zone-entrance']),
    )
  })

  it('quick create-tag POSTs a new tag and adds it to the selection', async () => {
    getTags.mockResolvedValue({ streamId: 'room1/cam', tags: [] })
    tagsCreate.mockResolvedValue({ slug: 'new-tag', label: 'New Tag', kind: 'custom' })
    setTags.mockResolvedValue({ streamId: 'room1/cam', tags: ['new-tag'] })
    renderEditor()

    // Wait for the list to settle (both known tags render).
    await screen.findByRole('checkbox', { name: 'Downtown Store' })

    fireEvent.change(screen.getByPlaceholderText('store-downtown'), {
      target: { value: 'new-tag' },
    })
    fireEvent.change(screen.getByPlaceholderText('Downtown Store'), {
      target: { value: 'New Tag' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'tags.create' }))

    await waitFor(() =>
      expect(tagsCreate).toHaveBeenCalledWith('live', { slug: 'new-tag', label: 'New Tag' }),
    )

    // Saving now includes the freshly created slug.
    fireEvent.click(screen.getByRole('button', { name: 'tags.save' }))
    await waitFor(() =>
      expect(setTags).toHaveBeenCalledWith('live', 'room1/cam', ['new-tag']),
    )
  })
})
