/**
 * Unit spec — StreamflowSecretsService (write-only per-app secrets).
 *
 * Real StreamflowStore (temp dir) + a fake ConfigService (jwtSecret) + fake apps.
 * Locks: put stores CIPHERTEXT (never plaintext); list returns masked meta only
 * (no value); resolve returns plaintext; bad name / empty / masked rejected;
 * expandConfig expands {{secret.NAME}} and reports the resolved values used.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { StreamflowSecretsService } from './streamflow-secrets.service';
import { StreamflowStore } from './streamflow.store';

const APP = 'live';

describe('StreamflowSecretsService', () => {
  let tmp: string;
  let appDir: string;
  let store: StreamflowStore;
  let svc: StreamflowSecretsService;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-sec-'));
    appDir = path.join(tmp, 'apps', APP);
    store = new StreamflowStore();
    const config = { jwtSecret: 'test-jwt-secret' } as never;
    const apps = { get: jest.fn(async () => ({ name: APP })), appDir: () => appDir } as never;
    svc = new StreamflowSecretsService(config, store, apps);
  });

  afterEach(() => {
    store.onModuleDestroy();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('stores ciphertext, not plaintext, and lists masked meta only', async () => {
    const meta = await svc.put(APP, 'HOOK_KEY', 'sk-live-SECRETVALUE');
    expect(meta.name).toBe('HOOK_KEY');
    expect(meta.last4).toBe('ALUE');
    // The raw stored column is ciphertext.
    const enc = store.getSecretEnc(APP, appDir, 'HOOK_KEY');
    expect(enc?.startsWith('aesgcm$')).toBe(true);
    expect(enc?.includes('SECRETVALUE')).toBe(false);
    // The list never carries the value.
    const list = await svc.list(APP);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'HOOK_KEY', last4: 'ALUE' });
    expect(JSON.stringify(list).includes('SECRETVALUE')).toBe(false);
  });

  it('resolves a stored secret to plaintext (run-time only)', async () => {
    await svc.put(APP, 'API', 'plaintext-123');
    expect(svc.resolve(APP, appDir, 'API')).toBe('plaintext-123');
    expect(svc.resolve(APP, appDir, 'MISSING')).toBe('');
  });

  it('rejects bad names, empty, and masked round-trips', async () => {
    await expect(svc.put(APP, 'bad name', 'v')).rejects.toThrow(/UPPER_SNAKE/);
    await expect(svc.put(APP, 'OK', '')).rejects.toThrow(/required/);
    await expect(svc.put(APP, 'OK', 'sk-…abcd')).rejects.toThrow(/masked/);
  });

  it('deletes a secret and 404s when absent', async () => {
    await svc.put(APP, 'GONE', 'v');
    expect(await svc.remove(APP, 'GONE')).toEqual({ deleted: true });
    await expect(svc.remove(APP, 'GONE')).rejects.toThrow(/not found/);
  });

  it('expandConfig replaces {{secret.NAME}} and reports used values', async () => {
    await svc.put(APP, 'TOKEN', 'sekret-abc');
    const { config, used } = svc.expandConfig(APP, appDir, {
      headers: { authorization: 'Bearer {{secret.TOKEN}}' },
      body: { keep: '{{trigger.x}}' }, // non-secret template left intact
      missing: '{{secret.NOPE}}',
    });
    expect((config.headers as Record<string, string>).authorization).toBe('Bearer sekret-abc');
    expect((config.body as Record<string, string>).keep).toBe('{{trigger.x}}');
    expect((config as Record<string, string>).missing).toBe(''); // absent → empty
    expect(used).toEqual(['sekret-abc']);
  });
});
