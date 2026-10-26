/**
 * Unit specs for the transcription pure helpers (module transcription):
 * SRT building (timecodes, ordering, speaker prefixes), track merging, the
 * ffmpeg mp3-extract / ffprobe arg builders and their never-throw wrappers
 * (with an injected fake runner — no process is ever spawned), and the
 * SRT-next-to-the-VOD S3 key convention.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildAudioProbeArgs,
  buildMp3ExtractArgs,
  buildSrt,
  collectSpeakers,
  extractMp3Track,
  formatSrtTimestamp,
  mergeTrackSegments,
  plainTranscriptText,
  probeAudioStreamCount,
  srtKeyForVod,
} from './transcription.util';

describe('formatSrtTimestamp', () => {
  it('formats zero and sub-second values', () => {
    expect(formatSrtTimestamp(0)).toBe('00:00:00,000');
    expect(formatSrtTimestamp(0.5)).toBe('00:00:00,500');
  });

  it('formats hours/minutes/seconds/millis', () => {
    expect(formatSrtTimestamp(3661.25)).toBe('01:01:01,250');
    expect(formatSrtTimestamp(59.999)).toBe('00:00:59,999');
  });

  it('rounds to the millisecond and clamps negatives to zero', () => {
    expect(formatSrtTimestamp(1.0006)).toBe('00:00:01,001');
    expect(formatSrtTimestamp(-5)).toBe('00:00:00,000');
    expect(formatSrtTimestamp(Number.NaN)).toBe('00:00:00,000');
  });
});

describe('buildSrt', () => {
  it('builds numbered cues with valid timecodes', () => {
    const srt = buildSrt([
      { start: 0, end: 2.5, text: 'hola' },
      { start: 2.5, end: 4, text: 'mundo' },
    ]);
    expect(srt).toBe(
      '1\n00:00:00,000 --> 00:00:02,500\nhola\n\n' +
        '2\n00:00:02,500 --> 00:00:04,000\nmundo\n',
    );
  });

  it('sorts by start time and skips empty-text segments', () => {
    const srt = buildSrt([
      { start: 5, end: 6, text: 'second' },
      { start: 1, end: 2, text: '   ' },
      { start: 0, end: 1, text: 'first' },
    ]);
    const lines = srt.trim().split('\n\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('first');
    expect(lines[1]).toContain('second');
  });

  it('prefixes the speaker label when present', () => {
    const srt = buildSrt([
      { start: 0, end: 1, text: 'hi there', speaker: 'alice' },
    ]);
    expect(srt).toContain('[alice] hi there');
  });

  it('enforces a minimum cue duration for zero-length segments', () => {
    const srt = buildSrt([{ start: 10, end: 10, text: 'blip' }]);
    expect(srt).toContain('00:00:10,000 --> 00:00:10,500');
  });

  it('returns an empty string for no usable segments', () => {
    expect(buildSrt([])).toBe('');
    expect(buildSrt([{ start: 0, end: 1, text: '' }])).toBe('');
  });
});

describe('mergeTrackSegments + speakers + plain text', () => {
  const tracks = [
    {
      speaker: 'alice',
      segments: [
        { start: 4, end: 5, text: 'and back to me' },
        { start: 0, end: 1, text: 'hello' },
      ],
    },
    { speaker: 'bob', segments: [{ start: 2, end: 3, text: 'hi alice' }] },
    { speaker: null, segments: [] },
  ];

  it('merges chronologically and attaches each track speaker', () => {
    const merged = mergeTrackSegments(tracks);
    expect(merged.map((s) => s.text)).toEqual([
      'hello',
      'hi alice',
      'and back to me',
    ]);
    expect(merged.map((s) => s.speaker)).toEqual(['alice', 'bob', 'alice']);
  });

  it('collects distinct speakers in appearance order', () => {
    expect(collectSpeakers(mergeTrackSegments(tracks))).toEqual([
      'alice',
      'bob',
    ]);
  });

  it('renders speaker-prefixed plain text lines', () => {
    expect(plainTranscriptText(mergeTrackSegments(tracks))).toBe(
      '[alice] hello\n[bob] hi alice\n[alice] and back to me',
    );
  });

  it('omits the prefix for unattributed segments', () => {
    expect(plainTranscriptText([{ start: 0, end: 1, text: 'mixed room' }])).toBe(
      'mixed room',
    );
  });
});

describe('buildMp3ExtractArgs (the mp3-extract command builder)', () => {
  it('extracts the first audio stream as 16 kHz mono mp3', () => {
    expect(buildMp3ExtractArgs('/in/rec.mp4', '/out/rec.mp3')).toEqual([
      '-y',
      '-i',
      '/in/rec.mp4',
      '-vn',
      '-map',
      '0:a:0',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '128k',
      '-ac',
      '1',
      '-ar',
      '16000',
      '/out/rec.mp3',
    ]);
  });

  it('maps the requested audio stream index', () => {
    const args = buildMp3ExtractArgs('/in/rec.mp4', '/out/rec-a2.mp3', 2);
    expect(args).toContain('0:a:2');
  });
});

describe('probeAudioStreamCount', () => {
  it('counts the audio streams from the ffprobe JSON', async () => {
    const run = jest.fn(async () =>
      JSON.stringify({ streams: [{ index: 1 }, { index: 2 }] }),
    );
    await expect(probeAudioStreamCount('/in/rec.mp4', run)).resolves.toBe(2);
    expect(run).toHaveBeenCalledWith(
      'ffprobe',
      buildAudioProbeArgs('/in/rec.mp4'),
      expect.any(Number),
    );
  });

  it('returns 0 for a source without audio and null on probe failure', async () => {
    await expect(
      probeAudioStreamCount('/x.mp4', async () => JSON.stringify({})),
    ).resolves.toBe(0);
    await expect(
      probeAudioStreamCount('/x.mp4', async () => {
        throw new Error('ffprobe missing');
      }),
    ).resolves.toBeNull();
  });
});

describe('extractMp3Track', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-transcribe-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('runs ffmpeg with the extract args and confirms the output exists', async () => {
    const out = path.join(dir, 'nested', 'a0.mp3');
    const run = jest.fn(async (_bin: string, args: string[]) => {
      fs.writeFileSync(args[args.length - 1], 'mp3');
      return '';
    });
    await expect(extractMp3Track('/in/rec.mp4', out, 0, run)).resolves.toBe(
      true,
    );
    expect(run).toHaveBeenCalledWith(
      'ffmpeg',
      buildMp3ExtractArgs('/in/rec.mp4', out, 0),
      expect.any(Number),
    );
  });

  it('returns false when ffmpeg fails or produces nothing (never throws)', async () => {
    const out = path.join(dir, 'a0.mp3');
    await expect(
      extractMp3Track('/in/rec.mp4', out, 0, async () => {
        throw new Error('boom');
      }),
    ).resolves.toBe(false);
    await expect(
      extractMp3Track('/in/rec.mp4', out, 0, async () => ''),
    ).resolves.toBe(false);
  });
});

describe('srtKeyForVod', () => {
  it('swaps the container extension for .srt next to the VOD', () => {
    expect(srtKeyForVod('rec-1699999999.mp4', 7)).toBe('rec-1699999999.srt');
    expect(srtKeyForVod('streamhub/live/rec.mp4', 7)).toBe(
      'streamhub/live/rec.srt',
    );
    expect(srtKeyForVod('noext', 7)).toBe('noext.srt');
  });

  it('falls back to transcripts/vod-<id>.srt without a fileKey', () => {
    expect(srtKeyForVod(null, 42)).toBe('transcripts/vod-42.srt');
    expect(srtKeyForVod('  ', 42)).toBe('transcripts/vod-42.srt');
  });
});
