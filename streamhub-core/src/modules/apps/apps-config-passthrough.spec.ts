/**
 * mergeDisk unknown-block passthrough (Wave 1 finalize).
 *
 * Locks the raw-editor-parity invariant: a STRUCTURED config save must never
 * drop top-level yaml blocks the DiskConfig builder doesn't model
 * (`notifications:`, `network:`, `cluster:` — Wave 1B/1C consumers read them
 * raw). Regression: mergeDisk rebuilt the yaml field-by-field, so any
 * structured PATCH silently deleted operator-authored blocks.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';

import { AppsService } from './apps.service';

type AnyRec = Record<string, unknown>;

describe('AppsService mergeDisk — unknown top-level blocks survive structured saves', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-passthrough-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function svc(): AnyRec {
    // Only the pieces readDiskConfig/mergeDisk/writeDiskConfig touch.
    const config = { dataDir: dir } as AnyRec;
    return new (AppsService as unknown as new (...a: unknown[]) => AnyRec)(
      config,
      null,
      null,
      null,
      null,
      null,
    );
  }

  it('carries notifications/network/cluster blocks through a rebuild round-trip', () => {
    const s = svc() as AnyRec & {
      readDiskConfig(name: string): AnyRec;
      writeDiskConfig(name: string, d: AnyRec): void;
    };
    const appDir = path.join(dir, 'apps', 'demo');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, 'config.yaml'),
      yaml.dump({
        name: 'demo',
        display_name: 'Demo',
        room_prefix: 'demo',
        notifications: { enabled: true, discord: { webhook: 'https://d.example' } },
        network: { threshold_gb_day: 5 },
        cluster: { notify: true },
      }),
    );

    // read → merge(defaults, disk) → write: the structured-save path.
    const merged = s.readDiskConfig('demo');
    s.writeDiskConfig('demo', merged);
    const roundTripped = yaml.load(
      fs.readFileSync(path.join(appDir, 'config.yaml'), 'utf8'),
    ) as AnyRec;

    expect((roundTripped.notifications as AnyRec)?.enabled).toBe(true);
    expect(
      ((roundTripped.notifications as AnyRec)?.discord as AnyRec)?.webhook,
    ).toBe('https://d.example');
    expect((roundTripped.network as AnyRec)?.threshold_gb_day).toBe(5);
    expect((roundTripped.cluster as AnyRec)?.notify).toBe(true);
    // Known fields still modelled (not clobbered by the passthrough).
    expect(roundTripped.display_name).toBe('Demo');
    expect(roundTripped.recording).toBeDefined();
  });
});
