/**
 * Unit — system/OsTuning (read-only OS performance-tuning reporter).
 *
 * Two layers, both without any real I/O:
 *
 *  1. VERDICTS — `buildReport` over a FAKE {@link TuningReader} maps a set of
 *     fake `/proc` values → the correct applied / not-applied / unknown verdict
 *     for every knob (UDP buffers, somaxconn, udp_mem, port range, fd limits,
 *     swappiness, transparent hugepages), including the gte/lte thresholds and
 *     the multi-field parsers.
 *  2. DEGRADATION — a non-Linux platform makes every knob `unknown`,
 *     `supported:false`, and the live {@link OsTuningService} never throws and
 *     reports the host's real platform (macOS CI ⇒ unsupported, all unknown).
 *
 * `buildReport` is pure and deterministic (bar the timestamp), so this is the
 * whole verdict contract — the service just wires the real fs reader in.
 */
import {
  KNOBS,
  UDP_BUFFER_MIN,
  buildReport,
  sysctlPath,
  type TuningReader,
} from './os-tuning.knobs';
import { OsTuningService } from './os-tuning.service';
import type { OsTuningKnob } from './os-tuning.types';

/** A fake reader keyed by each knob's `key` (sysctl key / limit row / sys path). */
function fakeReader(
  platform: string,
  values: Record<string, string | null>,
): TuningReader {
  return {
    platform,
    read: (knob) => (knob.key in values ? values[knob.key] : null),
  };
}

/** A fully-tuned Linux host: every knob at or above its recommendation. */
const GOOD: Record<string, string | null> = {
  'net.core.rmem_max': String(UDP_BUFFER_MIN),
  'net.core.wmem_max': String(UDP_BUFFER_MIN),
  'net.core.somaxconn': '4096',
  'net.ipv4.udp_mem': '65536 131072 262144',
  'net.ipv4.ip_local_port_range': '1024 65535',
  'fs.file-max': '1048576',
  'Max open files': '200000',
  'vm.swappiness': '10',
  '/sys/kernel/mm/transparent_hugepage/enabled': 'always [madvise] never',
};

function knob(knobs: OsTuningKnob[], id: string): OsTuningKnob {
  const k = knobs.find((x) => x.id === id);
  if (!k) throw new Error(`knob ${id} missing from report`);
  return k;
}

describe('system/os-tuning — buildReport verdicts', () => {
  it('marks every knob applied on a fully-tuned Linux host', () => {
    const r = buildReport(fakeReader('linux', GOOD));
    expect(r.supported).toBe(true);
    expect(r.platform).toBe('linux');
    expect(r.knobs).toHaveLength(KNOBS.length);
    for (const k of r.knobs) {
      expect(k.status).toBe('applied');
      expect(k.current).not.toBeNull();
    }
    expect(r.summary).toEqual({
      applied: KNOBS.length,
      notApplied: 0,
      unknown: 0,
    });
  });

  it('flags the default (untuned) UDP buffers as not-applied', () => {
    const r = buildReport(
      fakeReader('linux', {
        ...GOOD,
        'net.core.rmem_max': '212992', // kernel default ~208 KiB
        'net.core.wmem_max': '212992',
      }),
    );
    expect(knob(r.knobs, 'net.core.rmem_max').status).toBe('not-applied');
    expect(knob(r.knobs, 'net.core.wmem_max').status).toBe('not-applied');
    expect(r.summary.notApplied).toBe(2);
  });

  it('applies gte at the exact threshold and fails just below it', () => {
    const at = buildReport(
      fakeReader('linux', { ...GOOD, 'net.core.rmem_max': String(UDP_BUFFER_MIN) }),
    );
    const below = buildReport(
      fakeReader('linux', {
        ...GOOD,
        'net.core.rmem_max': String(UDP_BUFFER_MIN - 1),
      }),
    );
    expect(knob(at.knobs, 'net.core.rmem_max').status).toBe('applied');
    expect(knob(below.knobs, 'net.core.rmem_max').status).toBe('not-applied');
  });

  it('checks vm.swappiness with a lte verdict', () => {
    expect(
      knob(buildReport(fakeReader('linux', { ...GOOD, 'vm.swappiness': '10' })).knobs, 'vm.swappiness')
        .status,
    ).toBe('applied');
    expect(
      knob(buildReport(fakeReader('linux', { ...GOOD, 'vm.swappiness': '60' })).knobs, 'vm.swappiness')
        .status,
    ).toBe('not-applied');
  });

  it('flags a low listen backlog and a low system fd cap', () => {
    const r = buildReport(
      fakeReader('linux', {
        ...GOOD,
        'net.core.somaxconn': '128',
        'fs.file-max': '65536',
      }),
    );
    expect(knob(r.knobs, 'net.core.somaxconn').status).toBe('not-applied');
    expect(knob(r.knobs, 'fs.file-max').status).toBe('not-applied');
  });

  it('reads the MAX column of udp_mem (3rd field)', () => {
    expect(
      knob(
        buildReport(fakeReader('linux', { ...GOOD, 'net.ipv4.udp_mem': '65536 131072 131072' })).knobs,
        'net.ipv4.udp_mem',
      ).status,
    ).toBe('not-applied');
    expect(
      knob(
        buildReport(fakeReader('linux', { ...GOOD, 'net.ipv4.udp_mem': '65536 131072 524288' })).knobs,
        'net.ipv4.udp_mem',
      ).status,
    ).toBe('applied');
    // Malformed (fewer than 3 fields) → unknown.
    expect(
      knob(
        buildReport(fakeReader('linux', { ...GOOD, 'net.ipv4.udp_mem': '65536 131072' })).knobs,
        'net.ipv4.udp_mem',
      ).status,
    ).toBe('unknown');
  });

  it('judges the ephemeral port range by width and ceiling', () => {
    // Wide range reaching 65535 → applied.
    expect(
      knob(
        buildReport(fakeReader('linux', { ...GOOD, 'net.ipv4.ip_local_port_range': '1024 65535' })).knobs,
        'net.ipv4.ip_local_port_range',
      ).status,
    ).toBe('applied');
    // Too narrow → not-applied.
    expect(
      knob(
        buildReport(fakeReader('linux', { ...GOOD, 'net.ipv4.ip_local_port_range': '50000 65535' })).knobs,
        'net.ipv4.ip_local_port_range',
      ).status,
    ).toBe('not-applied');
    // Single field → unknown.
    expect(
      knob(
        buildReport(fakeReader('linux', { ...GOOD, 'net.ipv4.ip_local_port_range': '1024' })).knobs,
        'net.ipv4.ip_local_port_range',
      ).status,
    ).toBe('unknown');
  });

  it('reads the process open-files SOFT limit (unlimited counts as applied)', () => {
    expect(
      knob(buildReport(fakeReader('linux', { ...GOOD, 'Max open files': '1024' })).knobs, 'nofile').status,
    ).toBe('not-applied');
    expect(
      knob(buildReport(fakeReader('linux', { ...GOOD, 'Max open files': '65535' })).knobs, 'nofile').status,
    ).toBe('applied');
    expect(
      knob(buildReport(fakeReader('linux', { ...GOOD, 'Max open files': 'unlimited' })).knobs, 'nofile')
        .status,
    ).toBe('applied');
  });

  it('flags transparent hugepages only when the active mode is "always"', () => {
    expect(
      knob(
        buildReport(
          fakeReader('linux', {
            ...GOOD,
            '/sys/kernel/mm/transparent_hugepage/enabled': '[always] madvise never',
          }),
        ).knobs,
        'transparent_hugepage',
      ).status,
    ).toBe('not-applied');
    expect(
      knob(
        buildReport(
          fakeReader('linux', {
            ...GOOD,
            '/sys/kernel/mm/transparent_hugepage/enabled': 'always madvise [never]',
          }),
        ).knobs,
        'transparent_hugepage',
      ).status,
    ).toBe('applied');
    // The hugepages knob is optional (non-essential).
    expect(knob(buildReport(fakeReader('linux', GOOD)).knobs, 'transparent_hugepage').optional).toBe(true);
  });

  it('reports unknown for a missing (null) or unparseable value', () => {
    const missing = buildReport(fakeReader('linux', { ...GOOD, 'net.core.rmem_max': null }));
    const garbage = buildReport(fakeReader('linux', { ...GOOD, 'net.core.rmem_max': 'not-a-number' }));
    const empty = buildReport(fakeReader('linux', { ...GOOD, 'net.core.rmem_max': '   ' }));
    expect(knob(missing.knobs, 'net.core.rmem_max').status).toBe('unknown');
    expect(knob(missing.knobs, 'net.core.rmem_max').current).toBeNull();
    expect(knob(garbage.knobs, 'net.core.rmem_max').status).toBe('unknown');
    expect(knob(empty.knobs, 'net.core.rmem_max').status).toBe('unknown');
    expect(knob(empty.knobs, 'net.core.rmem_max').current).toBeNull();
  });

  it('carries recommended value, remedy and rationale for every knob', () => {
    const r = buildReport(fakeReader('linux', GOOD));
    for (const k of r.knobs) {
      expect(k.recommended.length).toBeGreaterThan(0);
      expect(k.remedy.length).toBeGreaterThan(0);
      expect(k.why.length).toBeGreaterThan(0);
      expect(k.label.length).toBeGreaterThan(0);
    }
  });
});

describe('system/os-tuning — non-Linux degradation', () => {
  it('reports every knob unknown and supported:false on a non-Linux host', () => {
    const r = buildReport(fakeReader('darwin', GOOD));
    expect(r.supported).toBe(false);
    expect(r.platform).toBe('darwin');
    expect(r.knobs).toHaveLength(KNOBS.length);
    for (const k of r.knobs) {
      expect(k.status).toBe('unknown');
      expect(k.current).toBeNull();
    }
    expect(r.summary).toEqual({ applied: 0, notApplied: 0, unknown: KNOBS.length });
    expect(r.note).toMatch(/non-linux/i);
  });
});

describe('system/os-tuning — sysctlPath', () => {
  it('maps a dotted sysctl key to its /proc/sys path', () => {
    expect(sysctlPath('net.core.rmem_max')).toBe('/proc/sys/net/core/rmem_max');
    expect(sysctlPath('vm.swappiness')).toBe('/proc/sys/vm/swappiness');
  });
});

describe('system/OsTuningService (live host)', () => {
  it('never throws and mirrors the real platform (macOS ⇒ unsupported)', () => {
    const report = new OsTuningService().report();
    expect(report.platform).toBe(process.platform);
    expect(report.supported).toBe(process.platform === 'linux');
    expect(report.knobs).toHaveLength(KNOBS.length);
    const sum = report.summary.applied + report.summary.notApplied + report.summary.unknown;
    expect(sum).toBe(report.knobs.length);
    expect(() => new Date(report.checkedAt).toISOString()).not.toThrow();
    if (process.platform !== 'linux') {
      for (const k of report.knobs) expect(k.status).toBe('unknown');
    }
  });
});
