/**
 * Unit spec — MPEG-TS-over-UDP source parse / validate / canonicalize
 * (mpegts-source.util). Pins the EXACT canonical ffmpeg input URL (incl. SSM
 * `sources=`, `localaddr=`, `fifo_size=`, `overrun_nonfatal=`) and every
 * validation edge case, so the passthrough plane never hands ffmpeg an
 * unsanitized udp:// string. No network — pure string logic.
 */
import {
  buildUdpUrl,
  isMulticastIpv4,
  isValidIpv4,
  MpegtsSourceError,
  MPEGTS_MAX_SOURCE_IPS,
  parseMpegtsSource,
} from './mpegts-source.util';

describe('isValidIpv4 / isMulticastIpv4', () => {
  it('accepts dotted-quad IPv4 and rejects malformed / out-of-range', () => {
    expect(isValidIpv4('239.1.1.1')).toBe(true);
    expect(isValidIpv4('0.0.0.0')).toBe(true);
    expect(isValidIpv4('255.255.255.255')).toBe(true);
    expect(isValidIpv4('256.1.1.1')).toBe(false);
    expect(isValidIpv4('10.0.0')).toBe(false);
    expect(isValidIpv4('10.0.0.01')).toBe(false); // leading zero
    expect(isValidIpv4('camera.local')).toBe(false);
    expect(isValidIpv4('')).toBe(false);
  });

  it('flags the 224.0.0.0/4 multicast range only', () => {
    expect(isMulticastIpv4('224.0.0.1')).toBe(true);
    expect(isMulticastIpv4('239.255.255.255')).toBe(true);
    expect(isMulticastIpv4('233.10.20.30')).toBe(true);
    expect(isMulticastIpv4('223.255.255.255')).toBe(false); // just below
    expect(isMulticastIpv4('240.0.0.1')).toBe(false); // just above
    expect(isMulticastIpv4('10.0.0.5')).toBe(false); // unicast
  });
});

describe('parseMpegtsSource — canonical URL construction', () => {
  it('builds a multicast receive URL with overrun_nonfatal on by default', () => {
    const p = parseMpegtsSource({ url: 'udp://@239.1.1.1:5000' });
    expect(p.sourceUrl).toBe('udp://@239.1.1.1:5000?overrun_nonfatal=1');
    expect(p.host).toBe('239.1.1.1');
    expect(p.port).toBe(5000);
    expect(p.multicast).toBe(true);
    expect(p.overrunNonfatal).toBe(true);
  });

  it('builds a unicast receive URL for an empty host (udp://@:PORT)', () => {
    const p = parseMpegtsSource({ url: 'udp://@:5000' });
    expect(p.sourceUrl).toBe('udp://@:5000?overrun_nonfatal=1');
    expect(p.host).toBe('');
    expect(p.multicast).toBe(false);
  });

  it('accepts a source WITHOUT the leading @ and normalizes to the @ receive form', () => {
    const p = parseMpegtsSource({ url: 'udp://239.1.1.1:5000' });
    expect(p.sourceUrl).toBe('udp://@239.1.1.1:5000?overrun_nonfatal=1');
  });

  it('emits SSM sources= (IGMPv3 include) for a multicast group', () => {
    const p = parseMpegtsSource({
      url: 'udp://@239.1.1.1:5000',
      sources: '10.0.0.5,10.0.0.6',
    });
    expect(p.ssmSources).toEqual(['10.0.0.5', '10.0.0.6']);
    expect(p.sourceUrl).toBe(
      'udp://@239.1.1.1:5000?sources=10.0.0.5,10.0.0.6&overrun_nonfatal=1',
    );
  });

  it('accepts a sources array as well as a comma string', () => {
    const p = parseMpegtsSource({
      url: 'udp://@239.1.1.1:5000',
      sources: ['10.0.0.5'],
    });
    expect(p.sourceUrl).toBe(
      'udp://@239.1.1.1:5000?sources=10.0.0.5&overrun_nonfatal=1',
    );
  });

  it('emits localaddr + fifo_size in a STABLE key order (sources,localaddr,fifo,overrun)', () => {
    const p = parseMpegtsSource({
      url: 'udp://@239.1.1.1:5000',
      sources: '10.0.0.5',
      localaddr: '192.168.1.10',
      fifoSize: 1000000,
    });
    expect(p.sourceUrl).toBe(
      'udp://@239.1.1.1:5000?sources=10.0.0.5&localaddr=192.168.1.10&fifo_size=1000000&overrun_nonfatal=1',
    );
  });

  it('emits overrun_nonfatal=0 when explicitly disabled', () => {
    const p = parseMpegtsSource({
      url: 'udp://@239.1.1.1:5000',
      overrunNonfatal: false,
    });
    expect(p.sourceUrl).toBe('udp://@239.1.1.1:5000?overrun_nonfatal=0');
  });

  it('parses + merges query params carried in the url; structured fields win', () => {
    const p = parseMpegtsSource({
      url: 'udp://@239.1.1.1:5000?sources=10.0.0.5&fifo_size=500000&overrun_nonfatal=1',
      // structured localaddr adds; structured sources (absent) → url sources used
      localaddr: '192.168.1.10',
    });
    expect(p.ssmSources).toEqual(['10.0.0.5']);
    expect(p.fifoSize).toBe(500000);
    expect(p.sourceUrl).toBe(
      'udp://@239.1.1.1:5000?sources=10.0.0.5&localaddr=192.168.1.10&fifo_size=500000&overrun_nonfatal=1',
    );
  });

  it('lets a structured field OVERRIDE the same query key in the url', () => {
    const p = parseMpegtsSource({
      url: 'udp://@239.1.1.1:5000?fifo_size=1',
      fifoSize: 2000000,
    });
    expect(p.fifoSize).toBe(2000000);
    expect(p.sourceUrl).toContain('fifo_size=2000000');
    expect(p.sourceUrl).not.toContain('fifo_size=1&');
  });
});

describe('parseMpegtsSource — validation edge cases (each a 400 upstream)', () => {
  const bad = (opts: Parameters<typeof parseMpegtsSource>[0]): Error | null => {
    try {
      parseMpegtsSource(opts);
      return null;
    } catch (e) {
      return e as Error;
    }
  };

  it('rejects a non-udp scheme', () => {
    const e = bad({ url: 'rtsp://cam/stream' });
    expect(e).toBeInstanceOf(MpegtsSourceError);
    expect(e?.message).toMatch(/udp:\/\//);
  });

  it('rejects a missing port', () => {
    expect(bad({ url: 'udp://@239.1.1.1' })?.message).toMatch(/port/);
  });

  it('rejects an out-of-range port', () => {
    expect(bad({ url: 'udp://@239.1.1.1:70000' })?.message).toMatch(/port/);
    expect(bad({ url: 'udp://@239.1.1.1:0' })?.message).toMatch(/port/);
  });

  it('rejects a non-IPv4 host (hostnames are not multicast groups)', () => {
    expect(bad({ url: 'udp://@camera.local:5000' })?.message).toMatch(/IPv4/);
  });

  it('rejects sources= on a NON-multicast host (SSM needs a group)', () => {
    expect(
      bad({ url: 'udp://@:5000', sources: '10.0.0.5' })?.message,
    ).toMatch(/multicast group/);
    expect(
      bad({ url: 'udp://@10.0.0.9:5000', sources: '10.0.0.5' })?.message,
    ).toMatch(/multicast group/);
  });

  it('rejects a malformed SSM source IP', () => {
    expect(
      bad({ url: 'udp://@239.1.1.1:5000', sources: 'not-an-ip' })?.message,
    ).toMatch(/IPv4/);
  });

  it('rejects too many SSM sources', () => {
    const many = Array.from({ length: MPEGTS_MAX_SOURCE_IPS + 1 }, (_, i) => `10.0.0.${i}`);
    expect(
      bad({ url: 'udp://@239.1.1.1:5000', sources: many })?.message,
    ).toMatch(/at most/);
  });

  it('rejects a malformed localaddr', () => {
    expect(
      bad({ url: 'udp://@239.1.1.1:5000', localaddr: 'eth0' })?.message,
    ).toMatch(/localaddr/);
  });

  it('rejects an out-of-range fifo_size', () => {
    expect(
      bad({ url: 'udp://@239.1.1.1:5000', fifoSize: 0 })?.message,
    ).toMatch(/fifo_size/);
    expect(
      bad({ url: 'udp://@239.1.1.1:5000', fifoSize: 999_999_999 })?.message,
    ).toMatch(/fifo_size/);
  });

  it('rejects an unsupported query parameter (no arbitrary ffmpeg option injection)', () => {
    expect(
      bad({ url: 'udp://@239.1.1.1:5000?timeout=1&pkt_size=1316' })?.message,
    ).toMatch(/unsupported query parameter/);
  });
});

describe('buildUdpUrl', () => {
  it('always emits overrun_nonfatal last and omits unset optional keys', () => {
    expect(buildUdpUrl({ host: '239.1.1.1', port: 5000, overrunNonfatal: true })).toBe(
      'udp://@239.1.1.1:5000?overrun_nonfatal=1',
    );
    expect(
      buildUdpUrl({
        host: '239.1.1.1',
        port: 5000,
        ssmSources: ['1.2.3.4'],
        blockSources: ['5.6.7.8'],
        localaddr: '192.168.1.1',
        fifoSize: 100,
        overrunNonfatal: false,
      }),
    ).toBe(
      'udp://@239.1.1.1:5000?sources=1.2.3.4&block=5.6.7.8&localaddr=192.168.1.1&fifo_size=100&overrun_nonfatal=0',
    );
  });
});
