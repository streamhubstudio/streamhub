/**
 * volume.js — volumedetect stderr parsing over RECORDED FIXTURES + the argv
 * builder (audio-only decode, null muxer — the CPU contract).
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { buildVolumeArgs, parseVolumeDetect } from '../src/volume.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');

test('buildVolumeArgs: -vn (never decodes video) + volumedetect into null', () => {
  const args = buildVolumeArgs('/x/seg.ts');
  assert.ok(args.includes('-vn'));
  assert.ok(args.includes('volumedetect'));
  const f = args.indexOf('-f');
  assert.equal(args[f + 1], 'null');
  assert.equal(args[args.indexOf('-i') + 1], '/x/seg.ts');
});

test('normal segment: mean/max parsed', () => {
  const r = parseVolumeDetect(fixture('volumedetect-normal.txt'));
  assert.deepEqual(r, { meanDb: -23.4, maxDb: -5.1 });
});

test('silent segment: deeply negative mean', () => {
  const r = parseVolumeDetect(fixture('volumedetect-silent.txt'));
  assert.equal(r.meanDb, -91);
});

test('no audio stream: no volumedetect line → null (missing ≠ silent)', () => {
  assert.equal(parseVolumeDetect(fixture('volumedetect-noaudio.txt')), null);
  assert.equal(parseVolumeDetect(''), null);
  assert.equal(parseVolumeDetect(undefined), null);
});
