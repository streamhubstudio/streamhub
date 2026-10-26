/**
 * Unit spec — shaka-packager plumbing (drm-packager.util).
 *
 * The argv builders are PURE and locked down exactly (they are the encryption
 * command a production run would execute). The binary probe / shell-out are
 * exercised only against a guaranteed-nonexistent binary name — no packager
 * needs to be installed, nothing real is spawned successfully, no network.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildRawKeyArgs,
  buildShakaHlsArgs,
  DEFAULT_PACKAGER_BIN,
  isShakaPackagerAvailable,
  packageDrmHls,
  resetShakaAvailabilityCache,
  shakaPackagerBin,
} from './drm-packager.util';

const KEY_ID = '0123456789abcdef0123456789abcdef';
const KEY = 'deadbeefdeadbeefdeadbeefdeadbeef';
const IV = '00112233445566778899aabbccddeeff';
const NO_BIN = 'streamhub-definitely-not-a-packager-xyz';

describe('buildRawKeyArgs', () => {
  it('single key → default label, cbcs scheme, clear_lead 0', () => {
    expect(
      buildRawKeyArgs({ assetId: 'a', keys: [{ keyId: KEY_ID, key: KEY }] }, 'cbcs'),
    ).toEqual([
      '--enable_raw_key_encryption',
      '--protection_scheme',
      'cbcs',
      '--clear_lead',
      '0',
      '--keys',
      `label=:key_id=${KEY_ID}:key=${KEY}`,
    ]);
  });

  it('iv included when present; scheme cenc honored', () => {
    const args = buildRawKeyArgs(
      { assetId: 'a', keys: [{ keyId: KEY_ID, key: KEY, iv: IV }] },
      'cenc',
    );
    expect(args).toContain('cenc');
    expect(args[args.indexOf('--keys') + 1]).toBe(
      `label=:key_id=${KEY_ID}:key=${KEY}:iv=${IV}`,
    );
  });

  it('multiple keys: first is the default label, extras get key<i> labels', () => {
    const args = buildRawKeyArgs(
      {
        assetId: 'a',
        keys: [
          { keyId: KEY_ID, key: KEY },
          { keyId: KEY, key: KEY_ID },
        ],
      },
      'cbcs',
    );
    expect(args[args.indexOf('--keys') + 1]).toBe(
      `label=:key_id=${KEY_ID}:key=${KEY},label=key1:key_id=${KEY}:key=${KEY_ID}`,
    );
  });

  it('pssh boxes: base64 concatenated to ONE hex --pssh value', () => {
    const args = buildRawKeyArgs(
      {
        assetId: 'a',
        keys: [{ keyId: KEY_ID, key: KEY }],
        pssh: [
          { system: 'widevine', boxBase64: Buffer.from('WV').toString('base64') },
          { system: 'playready', boxBase64: Buffer.from('PR').toString('base64') },
        ],
      },
      'cbcs',
    );
    expect(args[args.indexOf('--pssh') + 1]).toBe(
      Buffer.from('WVPR').toString('hex'),
    );
  });

  it('FairPlay hls key uri forwarded as --hls_key_uri', () => {
    const args = buildRawKeyArgs(
      {
        assetId: 'a',
        keys: [{ keyId: KEY_ID, key: KEY }],
        hlsKeyUri: 'skd://asset-a',
      },
      'cbcs',
    );
    expect(args[args.indexOf('--hls_key_uri') + 1]).toBe('skd://asset-a');
  });
});

describe('buildShakaHlsArgs', () => {
  it('one video descriptor per rendition + shared audio group + master output', () => {
    const args = buildShakaHlsArgs({
      renditions: [
        { height: 720, mp4Path: '/w/720p.mp4' },
        { height: 480, mp4Path: '/w/480p.mp4' },
      ],
      audioSourcePath: '/w/source.mp4',
      outDir: '/w/out',
      keyArgs: ['--enable_raw_key_encryption'],
    });
    expect(args).toEqual([
      'in=/w/720p.mp4,stream=video,output=/w/out/720p.mp4,playlist_name=720p.m3u8',
      'in=/w/480p.mp4,stream=video,output=/w/out/480p.mp4,playlist_name=480p.m3u8',
      'in=/w/source.mp4,stream=audio,output=/w/out/audio.mp4,playlist_name=audio.m3u8,hls_group_id=audio,hls_name=default',
      '--segment_duration',
      '4',
      '--hls_master_playlist_output',
      '/w/out/master.m3u8',
      '--enable_raw_key_encryption',
    ]);
  });

  it('honors an explicit segment duration', () => {
    const args = buildShakaHlsArgs({
      renditions: [{ height: 720, mp4Path: '/w/720p.mp4' }],
      audioSourcePath: '/w/source.mp4',
      outDir: '/w/out',
      segmentSeconds: 6,
      keyArgs: [],
    });
    expect(args[args.indexOf('--segment_duration') + 1]).toBe('6');
  });
});

describe('binary probe + shell-out (no packager installed)', () => {
  beforeEach(() => resetShakaAvailabilityCache());

  it('shakaPackagerBin: env override wins, default is `packager`', () => {
    const prev = process.env.SHAKA_PACKAGER_BIN;
    try {
      delete process.env.SHAKA_PACKAGER_BIN;
      expect(shakaPackagerBin()).toBe(DEFAULT_PACKAGER_BIN);
      process.env.SHAKA_PACKAGER_BIN = '/opt/shaka/packager';
      expect(shakaPackagerBin()).toBe('/opt/shaka/packager');
    } finally {
      if (prev === undefined) delete process.env.SHAKA_PACKAGER_BIN;
      else process.env.SHAKA_PACKAGER_BIN = prev;
    }
  });

  it('isShakaPackagerAvailable → false for a missing binary (cached, no throw)', async () => {
    expect(await isShakaPackagerAvailable(NO_BIN)).toBe(false);
    // second call hits the cache (same answer, still no throw)
    expect(await isShakaPackagerAvailable(NO_BIN)).toBe(false);
  });

  it('packageDrmHls → false when the binary is missing (never throws)', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drm-pkg-'));
    try {
      await expect(
        packageDrmHls({
          renditions: [{ height: 720, mp4Path: '/nope/720p.mp4' }],
          audioSourcePath: '/nope/source.mp4',
          outDir,
          keyArgs: [],
          bin: NO_BIN,
        }),
      ).resolves.toBe(false);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
