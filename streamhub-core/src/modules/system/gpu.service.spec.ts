/**
 * Unit spec — GpuService (system module, GPU detection).
 *
 * Drives the NVIDIA (nvidia-smi) + VAAPI (/dev/dri) probes via a mocked
 * child_process.execFile + fs, and asserts the ROBUSTNESS CONTRACT: a missing
 * binary / denied permission / weird output degrades to `available:false,
 * type:'none'` and NEVER throws.
 *
 * Owned by the transcoding/GPU agent. Touches only this *.spec.ts.
 */
jest.mock('child_process', () => ({ execFile: jest.fn() }));
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, readdirSync: jest.fn() };
});

import { execFile } from 'child_process';
import * as fs from 'fs';

import { GpuService } from './gpu.service';
import { makeTestConfig, mockLogsService } from '../../../test/helpers';

const mockExecFile = execFile as unknown as jest.Mock;
const mockReaddir = fs.readdirSync as unknown as jest.Mock;

/** Make execFile behave like a specific binary succeeding/failing. */
function execRouter(
  routes: Record<string, { stdout?: string; error?: Error }>,
): void {
  mockExecFile.mockImplementation(
    (bin: string, _args: unknown, _opts: unknown, cb: Function) => {
      const r = routes[bin];
      if (!r || r.error) {
        cb(r?.error ?? new Error(`ENOENT: ${bin}`));
        return;
      }
      cb(null, r.stdout ?? '');
    },
  );
}

function buildGpu(): GpuService {
  const { config } = makeTestConfig();
  return new GpuService(config, mockLogsService());
}

describe('GpuService', () => {
  beforeEach(() => {
    delete process.env.GPU_DISABLE;
    // Default: no /dev/dri (VAAPI absent) unless a test opts in.
    mockReaddir.mockImplementation(() => {
      throw new Error('ENOENT: /dev/dri');
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('reports none (available:false) when no nvidia-smi and no /dev/dri — never throws', async () => {
    execRouter({}); // every binary fails
    const gpu = buildGpu();
    const status = await gpu.status();
    expect(status.available).toBe(false);
    expect(status.type).toBe('none');
    expect(status.devices).toEqual([]);
    expect(typeof status.checkedAt).toBe('string');
  });

  it('detects NVIDIA from nvidia-smi CSV', async () => {
    execRouter({
      'nvidia-smi': {
        stdout:
          '0, NVIDIA GeForce RTX 3090, 24576, 550.90.07\n' +
          '1, NVIDIA GeForce RTX 3090, 24576, 550.90.07\n',
      },
    });
    const gpu = buildGpu();
    const status = await gpu.refresh();
    expect(status.available).toBe(true);
    expect(status.type).toBe('nvidia');
    expect(status.devices).toHaveLength(2);
    expect(status.devices[0]).toMatchObject({
      kind: 'nvidia',
      name: 'NVIDIA GeForce RTX 3090',
      index: 0,
      memoryMiB: 24576,
    });
    expect(status.driver).toBe('550.90.07');
  });

  it('falls back to VAAPI when nvidia-smi is absent but /dev/dri has render nodes', async () => {
    execRouter({}); // nvidia-smi + vainfo fail
    mockReaddir.mockReturnValue(['card0', 'renderD128', 'renderD129'] as never);
    const gpu = buildGpu();
    const status = await gpu.refresh();
    expect(status.available).toBe(true);
    expect(status.type).toBe('vaapi');
    expect(status.devices.map((d) => d.name)).toEqual([
      '/dev/dri/renderD128',
      '/dev/dri/renderD129',
    ]);
  });

  it('prefers NVIDIA over VAAPI when both are present', async () => {
    execRouter({
      'nvidia-smi': { stdout: '0, NVIDIA A10, 24576, 535.0\n' },
    });
    mockReaddir.mockReturnValue(['renderD128'] as never);
    const gpu = buildGpu();
    const status = await gpu.refresh();
    expect(status.type).toBe('nvidia');
  });

  it('honours GPU_DISABLE=true (treats node as CPU-only)', async () => {
    process.env.GPU_DISABLE = 'true';
    execRouter({ 'nvidia-smi': { stdout: '0, NVIDIA A10, 24576, 535.0\n' } });
    const gpu = buildGpu();
    const status = await gpu.refresh();
    expect(status.available).toBe(false);
    expect(status.type).toBe('none');
    expect(status.detail).toContain('GPU_DISABLE');
  });

  it('caches the result and re-probes on refresh()', async () => {
    execRouter({});
    const gpu = buildGpu();
    const first = await gpu.status();
    const cached = await gpu.status();
    expect(cached).toBe(first); // same cached object
    const refreshed = await gpu.refresh();
    expect(refreshed).not.toBe(first); // fresh probe
  });

  it('does not throw when nvidia-smi output is malformed', async () => {
    execRouter({ 'nvidia-smi': { stdout: 'garbage,,,\n\n' } });
    const gpu = buildGpu();
    const status = await gpu.refresh();
    // No parseable device ⇒ falls through to VAAPI (absent) ⇒ none.
    expect(status.available).toBe(false);
    expect(status.type).toBe('none');
  });
});
