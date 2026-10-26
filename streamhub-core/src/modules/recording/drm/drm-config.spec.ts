/**
 * Unit spec — `features.drm` config resolution (pure, no I/O).
 *
 * Locks down the plugin-contract rule for the block: EVERY field has a
 * default and garbage input degrades to the safe values — disabled, noop
 * provider, cbcs, fail-closed.
 */
import {
  DRM_FEATURE_DEFAULTS,
  DRM_SYSTEMS,
  drmFeaturesToDisk,
  resolveDrmFeatures,
} from './drm-config';

describe('resolveDrmFeatures', () => {
  it('absent block → full defaults (disabled, noop, cbcs, fail-closed)', () => {
    for (const input of [undefined, null] as const) {
      expect(resolveDrmFeatures(input)).toEqual({
        enabled: false,
        provider: 'none',
        systems: ['widevine', 'playready', 'fairplay'],
        scheme: 'cbcs',
        keyServerUrl: '',
        keyServerTokenEnv: '',
        licenseUrls: { widevine: '', playready: '', fairplay: '' },
        fairplayCertUrl: '',
        failOpen: false,
      });
    }
    expect(resolveDrmFeatures({})).toEqual(DRM_FEATURE_DEFAULTS);
  });

  it('full snake_case block resolves field by field', () => {
    expect(
      resolveDrmFeatures({
        enabled: true,
        provider: 'external',
        systems: ['widevine', 'fairplay'],
        scheme: 'cenc',
        key_server_url: ' https://keys.example/speke ',
        key_server_token_env: 'APP_LIVE_DRM_TOKEN',
        license_urls: {
          widevine: 'https://lic.example/wv',
          playready: 'https://lic.example/pr',
          fairplay: 'https://lic.example/fp',
        },
        fairplay_cert_url: 'https://lic.example/fp.cer',
        fail_open: true,
      }),
    ).toEqual({
      enabled: true,
      provider: 'external',
      systems: ['widevine', 'fairplay'],
      scheme: 'cenc',
      keyServerUrl: 'https://keys.example/speke',
      keyServerTokenEnv: 'APP_LIVE_DRM_TOKEN',
      licenseUrls: {
        widevine: 'https://lic.example/wv',
        playready: 'https://lic.example/pr',
        fairplay: 'https://lic.example/fp',
      },
      fairplayCertUrl: 'https://lic.example/fp.cer',
      failOpen: true,
    });
  });

  it('enabled / fail_open are STRICT booleans — truthy strings/numbers stay off', () => {
    for (const v of ['true', 'yes', 1, {}] as const) {
      const r = resolveDrmFeatures({ enabled: v, fail_open: v });
      expect(r.enabled).toBe(false);
      expect(r.failOpen).toBe(false);
    }
  });

  it('unknown provider → none; case-insensitive external accepted', () => {
    expect(resolveDrmFeatures({ provider: 'axinom' }).provider).toBe('none');
    expect(resolveDrmFeatures({ provider: 'EXTERNAL' }).provider).toBe(
      'external',
    );
  });

  it('systems: unknown entries dropped, deduped case-insensitively', () => {
    expect(
      resolveDrmFeatures({
        systems: ['Widevine', 'widevine', 'clearkey', 'FAIRPLAY'],
      }).systems,
    ).toEqual(['widevine', 'fairplay']);
  });

  it('systems: empty / non-array / all-invalid → all three systems', () => {
    for (const v of [[], 'widevine', 42, ['verimatrix']] as const) {
      expect(resolveDrmFeatures({ systems: v }).systems).toEqual([
        ...DRM_SYSTEMS,
      ]);
    }
  });

  it('unknown scheme → cbcs; CENC accepted case-insensitively', () => {
    expect(resolveDrmFeatures({ scheme: 'aes-128' }).scheme).toBe('cbcs');
    expect(resolveDrmFeatures({ scheme: 'CENC' }).scheme).toBe('cenc');
  });

  it('partial license_urls: missing systems default to empty string', () => {
    expect(
      resolveDrmFeatures({ license_urls: { widevine: 'https://w' } })
        .licenseUrls,
    ).toEqual({ widevine: 'https://w', playready: '', fairplay: '' });
  });

  it('non-string url fields degrade to empty strings', () => {
    const r = resolveDrmFeatures({
      key_server_url: 42,
      key_server_token_env: null,
      fairplay_cert_url: {},
    });
    expect(r.keyServerUrl).toBe('');
    expect(r.keyServerTokenEnv).toBe('');
    expect(r.fairplayCertUrl).toBe('');
  });
});

describe('drmFeaturesToDisk', () => {
  it('round-trips through resolveDrmFeatures losslessly', () => {
    const resolved = resolveDrmFeatures({
      enabled: true,
      provider: 'external',
      systems: ['playready'],
      scheme: 'cenc',
      key_server_url: 'https://keys.example',
      key_server_token_env: 'REF',
      license_urls: { playready: 'https://lic.example/pr' },
      fairplay_cert_url: 'https://lic.example/fp.cer',
      fail_open: true,
    });
    expect(resolveDrmFeatures(drmFeaturesToDisk(resolved))).toEqual(resolved);
  });

  it('emits the snake_case on-disk shape', () => {
    expect(drmFeaturesToDisk(resolveDrmFeatures(undefined))).toEqual({
      enabled: false,
      provider: 'none',
      systems: ['widevine', 'playready', 'fairplay'],
      scheme: 'cbcs',
      key_server_url: '',
      key_server_token_env: '',
      license_urls: { widevine: '', playready: '', fairplay: '' },
      fairplay_cert_url: '',
      fail_open: false,
    });
  });
});
