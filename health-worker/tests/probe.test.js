/**
 * probe.js — ffprobe output parsing over RECORDED FIXTURES (no ffmpeg binary
 * anywhere near these tests) + the argv builder.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { buildFfprobeArgs, parseFfprobe, parseFps } from '../src/probe.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');

test('buildFfprobeArgs: json, format+streams, no decode flags', () => {
  const args = buildFfprobeArgs('/x/seg.ts');
  assert.deepEqual(args, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    '/x/seg.ts',
  ]);
});

test('parseFps: rational, integer, degenerate', () => {
  assert.equal(parseFps('30000/1001'), 30);
  assert.equal(parseFps('25/1'), 25);
  assert.equal(parseFps('25'), 25);
  assert.equal(parseFps('0/0'), null);
  assert.equal(parseFps(''), null);
  assert.equal(parseFps('x/y'), null);
});

test('full A/V fixture: facts + tiny start-time drift', () => {
  const r = parseFfprobe(fixture('ffprobe-av.json'));
  assert.equal(r.video.codec, 'h264');
  assert.equal(r.video.width, 1280);
  assert.equal(r.video.height, 720);
  assert.equal(r.video.fps, 30);
  assert.equal(r.video.bitrateKbps, 2143);
  assert.equal(r.audio.codec, 'aac');
  assert.equal(r.audio.sampleRate, 48000);
  assert.equal(r.audio.channels, 2);
  assert.equal(r.overallBitrateKbps, 2296);
  assert.equal(r.durationSec, 6.006);
  // |1.400 - 1.412| = 12 ms — in sync.
  assert.equal(r.desyncMs, 12);
});

test('video-only fixture: audio null, desync null, avg 0/0 falls back to r_frame_rate', () => {
  const r = parseFfprobe(fixture('ffprobe-video-only.json'));
  assert.equal(r.audio, null);
  assert.equal(r.desyncMs, null);
  assert.equal(r.video.fps, 25);
  assert.equal(r.video.width, 1920);
});

test('desync fixture: 352 ms drift surfaces', () => {
  const r = parseFfprobe(fixture('ffprobe-desync.json'));
  assert.equal(r.desyncMs, 352);
});

test('garbage / empty input parses to null, never throws', () => {
  assert.equal(parseFfprobe('not json'), null);
  assert.equal(parseFfprobe(''), null);
  assert.equal(parseFfprobe('42'), null);
  assert.equal(parseFfprobe(undefined), null);
});

test('missing streams array yields nulls without throwing', () => {
  const r = parseFfprobe('{"format":{"duration":"6.0"}}');
  assert.equal(r.video, null);
  assert.equal(r.audio, null);
  assert.equal(r.durationSec, 6);
});
