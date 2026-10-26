/**
 * Unit spec — the DrmProvider seam: NoopDrmProvider (default) +
 * ExternalDrmProvider (SPEKE-style key server stub).
 *
 * NO network: the external provider takes an injected `fetchFn`; every call
 * is a jest fake. Locks down:
 *  - Noop is inert: never ready, no keys, no license URLs, no packaging args.
 *  - External is only ready() with enabled+external+key_server_url; when not
 *    ready getContentKeys returns null WITHOUT dialing.
 *  - request shape (POST, bearer token, {asset_id, systems, scheme} body).
 *  - response normalization: snake/camel key ids, 0x/UUID/uppercase hex,
 *    invalid keys dropped, pssh + hls_key_uri passthrough.
 *  - every failure mode (non-2xx, malformed JSON, thrown fetch) → null.
 */
import type { DrmFeatures } from '../../../shared/contracts';
import { resolveDrmFeatures } from './drm-config';
import { ExternalDrmProvider } from './external-drm.provider';
import { NoopDrmProvider } from './drm-provider';

const KEY_ID = '0123456789abcdef0123456789abcdef';
const KEY = 'deadbeefdeadbeefdeadbeefdeadbeef';

function externalCfg(over: Partial<DrmFeatures> = {}): DrmFeatures {
  return {
    ...resolveDrmFeatures({ enabled: true, provider: 'external' }),
    keyServerUrl: 'https://keys.example/speke',
    ...over,
  };
}

/** fetch fake returning a canned JSON body. */
function fetchOk(body: unknown): jest.Mock {
  return jest.fn(async () => ({
    ok: true,
    json: async () => body,
  }));
}

describe('NoopDrmProvider', () => {
  const noop = new NoopDrmProvider();

  it('is inert: not ready, null keys, null license URL, empty args', async () => {
    expect(noop.id).toBe('none');
    expect(noop.ready()).toBe(false);
    expect(await noop.getContentKeys()).toBeNull();
    expect(noop.getLicenseUrl()).toBeNull();
    expect(noop.packagingArgs()).toEqual([]);
  });
});

describe('ExternalDrmProvider', () => {
  describe('ready()', () => {
    it('requires enabled + provider external + key server URL', () => {
      expect(new ExternalDrmProvider(externalCfg()).ready()).toBe(true);
      expect(
        new ExternalDrmProvider(externalCfg({ enabled: false })).ready(),
      ).toBe(false);
      expect(
        new ExternalDrmProvider(externalCfg({ provider: 'none' })).ready(),
      ).toBe(false);
      expect(
        new ExternalDrmProvider(externalCfg({ keyServerUrl: '' })).ready(),
      ).toBe(false);
    });

    it('not ready → getContentKeys resolves null WITHOUT dialing', async () => {
      const fetchFn = jest.fn();
      const p = new ExternalDrmProvider(
        externalCfg({ keyServerUrl: '' }),
        undefined,
        fetchFn as never,
      );
      expect(await p.getContentKeys('vod-1')).toBeNull();
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  describe('getContentKeys()', () => {
    it('POSTs {asset_id, systems, scheme} with the bearer token', async () => {
      const fetchFn = fetchOk({ keys: [{ key_id: KEY_ID, key: KEY }] });
      const p = new ExternalDrmProvider(
        externalCfg({ systems: ['widevine'], scheme: 'cenc' }),
        'tok-123',
        fetchFn as never,
      );
      const keys = await p.getContentKeys('vod-1');
      expect(keys).toEqual({
        assetId: 'vod-1',
        keys: [{ keyId: KEY_ID, key: KEY }],
      });
      const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://keys.example/speke');
      expect(init.method).toBe('POST');
      expect(
        (init.headers as Record<string, string>).authorization,
      ).toBe('Bearer tok-123');
      expect(JSON.parse(init.body as string)).toEqual({
        asset_id: 'vod-1',
        systems: ['widevine'],
        scheme: 'cenc',
      });
    });

    it('omits the authorization header when no token is resolved', async () => {
      const fetchFn = fetchOk({ keys: [{ key_id: KEY_ID, key: KEY }] });
      const p = new ExternalDrmProvider(
        externalCfg(),
        undefined,
        fetchFn as never,
      );
      await p.getContentKeys('vod-1');
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(
        (init.headers as Record<string, string>).authorization,
      ).toBeUndefined();
    });

    it('normalizes camelCase / 0x-prefixed / UUID-dashed / uppercase hex', async () => {
      const fetchFn = fetchOk({
        keys: [
          {
            keyId: `0x${KEY_ID.toUpperCase()}`,
            key: '01234567-89ab-cdef-0123-456789abcdef',
            iv: KEY.toUpperCase(),
          },
        ],
      });
      const p = new ExternalDrmProvider(
        externalCfg(),
        undefined,
        fetchFn as never,
      );
      expect(await p.getContentKeys('vod-1')).toEqual({
        assetId: 'vod-1',
        keys: [{ keyId: KEY_ID, key: KEY_ID, iv: KEY }],
      });
    });

    it('drops invalid keys; all-invalid → null', async () => {
      const p = new ExternalDrmProvider(
        externalCfg(),
        undefined,
        fetchOk({
          keys: [
            { key_id: 'short', key: KEY },
            { key_id: KEY_ID, key: 'not-hex!' },
            { key_id: KEY_ID }, // key missing
          ],
        }) as never,
      );
      expect(await p.getContentKeys('vod-1')).toBeNull();
    });

    it('passes pssh boxes + hls_key_uri through (unknown systems dropped)', async () => {
      const p = new ExternalDrmProvider(
        externalCfg(),
        undefined,
        fetchOk({
          keys: [{ key_id: KEY_ID, key: KEY }],
          pssh: [
            { system: 'Widevine', box: 'AAAA' },
            { system: 'verimatrix', box: 'BBBB' },
            { system: 'playready', boxBase64: 'CCCC' },
          ],
          hls_key_uri: ' skd://vod-1 ',
        }) as never,
      );
      expect(await p.getContentKeys('vod-1')).toEqual({
        assetId: 'vod-1',
        keys: [{ keyId: KEY_ID, key: KEY }],
        pssh: [
          { system: 'widevine', boxBase64: 'AAAA' },
          { system: 'playready', boxBase64: 'CCCC' },
        ],
        hlsKeyUri: 'skd://vod-1',
      });
    });

    it('non-2xx / malformed JSON / thrown fetch → null (never throws)', async () => {
      const cases: Array<typeof fetch> = [
        jest.fn(async () => ({ ok: false, json: async () => ({}) })) as never,
        jest.fn(async () => ({
          ok: true,
          json: async () => {
            throw new Error('bad json');
          },
        })) as never,
        jest.fn(async () => {
          throw new Error('ECONNREFUSED');
        }) as never,
        jest.fn(async () => ({ ok: true, json: async () => 'nope' })) as never,
      ];
      for (const fetchFn of cases) {
        const p = new ExternalDrmProvider(externalCfg(), undefined, fetchFn);
        expect(await p.getContentKeys('vod-1')).toBeNull();
      }
    });
  });

  describe('getLicenseUrl()', () => {
    const p = new ExternalDrmProvider(
      externalCfg({
        systems: ['widevine', 'fairplay'],
        licenseUrls: {
          widevine: 'https://lic.example/wv',
          playready: 'https://lic.example/pr',
          fairplay: '',
        },
      }),
    );

    it('returns the configured URL for an enabled system', () => {
      expect(p.getLicenseUrl('widevine')).toBe('https://lic.example/wv');
    });

    it('null for a system not in features.drm.systems (even if a URL exists)', () => {
      expect(p.getLicenseUrl('playready')).toBeNull();
    });

    it('null when the URL is unset', () => {
      expect(p.getLicenseUrl('fairplay')).toBeNull();
    });
  });

  describe('packagingArgs()', () => {
    it('emits raw-key shaka args for the requested scheme', () => {
      const p = new ExternalDrmProvider(externalCfg());
      const args = p.packagingArgs(
        { assetId: 'vod-1', keys: [{ keyId: KEY_ID, key: KEY }] },
        'cbcs',
      );
      expect(args).toEqual([
        '--enable_raw_key_encryption',
        '--protection_scheme',
        'cbcs',
        '--clear_lead',
        '0',
        '--keys',
        `label=:key_id=${KEY_ID}:key=${KEY}`,
      ]);
    });
  });
});
