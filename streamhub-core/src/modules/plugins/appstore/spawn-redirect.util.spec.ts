/**
 * Unit specs for the pure spawn-redirect helper: a resolved spawn spec's builtin
 * worker dir is swapped for the pinned extracted dir across cwd/args/env, and
 * unrelated values are left untouched.
 */
import * as path from 'path';
import { redirectWorkerDir } from './spawn-redirect.util';
import type { PluginWorkerSpec } from '../plugin.contract';

const FROM = path.join(path.sep, 'repo', 'lpr-worker');
const TO = path.join(path.sep, 'data', 'appstore', 'lpr', '2.9.0', 'extracted', 'lpr', 'worker');

describe('redirectWorkerDir', () => {
  it('swaps the fromDir prefix in cwd + PYTHONPATH + args', () => {
    const spec: PluginWorkerSpec = {
      command: 'python3',
      args: ['-m', 'lpr_worker', '--src', FROM],
      cwd: FROM,
      env: { PYTHONPATH: FROM, LPR_APP: 'live', OTHER: '/unrelated/path' },
    };
    const out = redirectWorkerDir(spec, FROM, TO);
    expect(out.cwd).toBe(TO);
    expect(out.env.PYTHONPATH).toBe(TO);
    expect(out.args).toEqual(['-m', 'lpr_worker', '--src', TO]);
    // Non-matching values are preserved verbatim.
    expect(out.env.LPR_APP).toBe('live');
    expect(out.env.OTHER).toBe('/unrelated/path');
    expect(out.command).toBe('python3');
  });

  it('rewrites subpaths of the fromDir', () => {
    const sub = path.join(FROM, 'models', 'weights');
    const out = redirectWorkerDir(
      { command: 'x', env: { W: sub }, cwd: FROM },
      FROM,
      TO,
    );
    expect(out.env.W).toBe(path.join(TO, 'models', 'weights'));
  });

  it('anchors cwd on the pinned dir even when the spec set no cwd', () => {
    const out = redirectWorkerDir({ command: 'x', env: {} }, FROM, TO);
    expect(out.cwd).toBe(TO);
  });

  it('does not partially match a sibling dir with the same prefix', () => {
    const sibling = `${FROM}-extra`;
    const out = redirectWorkerDir(
      { command: 'x', env: { S: sibling }, cwd: sibling },
      FROM,
      TO,
    );
    // `${FROM}-extra` is NOT under `${FROM}/` → left alone.
    expect(out.env.S).toBe(sibling);
    expect(out.cwd).toBe(sibling);
  });
});
