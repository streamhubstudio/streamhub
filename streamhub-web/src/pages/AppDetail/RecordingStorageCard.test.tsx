/**
 * Component test — RecordingStorageCard (vitest + jsdom + @testing-library).
 *
 * Covers the recording/VOD config UI (missions 2/3/4/5):
 *  - loads the filename/snapshot templates, retention + variables from config;
 *  - the no-bucket warning banner appears only when no S3 bucket is configured
 *    (mission 5 UI) and links to the storage config;
 *  - editing + Save PATCHes /apps/:name with the templated fields + variables
 *    (whole-map replace, empty keys dropped).
 *
 * react-i18next echoes keys; `@/api` is fully mocked (no network).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  return {
    ...actual,
    useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
  }
})

const { getConfigMock, getS3Mock, updateMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(),
  getS3Mock: vi.fn(),
  updateMock: vi.fn(),
}))

vi.mock('@/api', () => ({
  api: {
    apps: { getConfig: getConfigMock, getS3: getS3Mock, update: updateMock },
  },
}))

import { RecordingStorageCard } from './ConfigTab'

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  )
}

function config(over: Record<string, unknown> = {}) {
  return {
    recording: {
      enabled: true,
      splitMinutes: 0,
      snapshotSeconds: 0,
      filenameTemplate: '${app}_${room}',
      snapshotTemplate: '',
      retentionDays: 30,
    },
    variables: { site: 'HQ' },
    ...over,
  }
}

describe('RecordingStorageCard', () => {
  beforeEach(() => {
    getConfigMock.mockReset()
    getS3Mock.mockReset()
    updateMock.mockReset()
    updateMock.mockResolvedValue({})
  })

  it('loads templates + retention + variables from config', async () => {
    getConfigMock.mockResolvedValue(config())
    getS3Mock.mockResolvedValue({ bucket: 'my-bucket' })
    wrap(<RecordingStorageCard app="live" />)

    // Filename template input reflects the config value.
    expect(await screen.findByDisplayValue('${app}_${room}')).toBeTruthy()
    // The variable row (key + value) is populated.
    expect(screen.getByDisplayValue('site')).toBeTruthy()
    expect(screen.getByDisplayValue('HQ')).toBeTruthy()
    // No bucket warning when storage IS configured.
    expect(screen.queryByTestId('no-bucket-warning')).toBeNull()
  })

  it('shows the no-bucket warning + storage link when no bucket is configured', async () => {
    getConfigMock.mockResolvedValue(config())
    getS3Mock.mockResolvedValue({ bucket: '' })
    wrap(<RecordingStorageCard app="live" />)

    const warn = await screen.findByTestId('no-bucket-warning')
    expect(warn).toBeTruthy()
    // Links to the Integrations storage config, now under Config → System.
    const link = warn.querySelector('a')
    expect(link?.getAttribute('href')).toContain('section=system')
    expect(link?.getAttribute('href')).toContain('sub=integraciones')
  })

  it('saves templated fields + variables (empty keys dropped) via PATCH', async () => {
    getConfigMock.mockResolvedValue(config())
    getS3Mock.mockResolvedValue({ bucket: 'my-bucket' })
    wrap(<RecordingStorageCard app="live" />)

    // Edit the filename template.
    const tpl = await screen.findByDisplayValue('${app}_${room}')
    fireEvent.change(tpl, { target: { value: '${room}_${ts}' } })

    fireEvent.click(screen.getByText('recordingStorage.save'))

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1))
    const [appArg, payload] = updateMock.mock.calls[0]
    expect(appArg).toBe('live')
    expect(payload).toMatchObject({
      filenameTemplate: '${room}_${ts}',
      retentionDays: 30,
      variables: { site: 'HQ' },
    })
  })
})
