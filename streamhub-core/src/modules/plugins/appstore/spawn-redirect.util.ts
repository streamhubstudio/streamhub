/**
 * SPAWN REDIRECT — rewrite a resolved worker spawn spec so it runs from a PINNED
 * bundle's extracted dir instead of the shipped built-in worker source.
 *
 * Every exportable worker meta resolves its source dir once (`const dir =
 * workerDir()`) and threads it through `cwd` + `env.PYTHONPATH` (and any derived
 * path). We therefore anchor on that `fromDir` and swap its prefix everywhere it
 * appears in `cwd`, `args` and `env` — a generic rewrite that needs no per-plugin
 * knowledge and no change to any plugin.meta.ts. The extracted bundle's
 * `<id>/worker/` is a drop-in equivalent of `fromDir` (the exporter copies
 * srcDir → `<id>/worker/`), so `python -m <module>` resolves identically.
 *
 * Pure + dependency-light (only `path`) so it is unit-tested in isolation.
 */
import * as path from 'path';
import type { PluginWorkerSpec } from '../plugin.contract';

/** Swap a `fromDir` prefix for `toDir` in a single string (exact or subpath). */
function swap(value: string, fromDir: string, toDir: string): string {
  if (value === fromDir) return toDir;
  if (value.startsWith(fromDir + path.sep)) {
    return toDir + value.slice(fromDir.length);
  }
  return value;
}

/**
 * Return a COPY of `spec` with every `fromDir` occurrence in `cwd`/`args`/`env`
 * replaced by `toDir`, and `cwd` forced to `toDir` (so even a spec that did not
 * set `cwd` runs from the pinned dir). `fromDir`/`toDir` are absolute paths.
 */
export function redirectWorkerDir(
  spec: PluginWorkerSpec,
  fromDir: string,
  toDir: string,
): PluginWorkerSpec {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    env[k] = swap(v, fromDir, toDir);
  }
  return {
    command: spec.command,
    args: (spec.args ?? []).map((a) => swap(a, fromDir, toDir)),
    env,
    // Anchor cwd on the pinned dir regardless of what the meta set.
    cwd: spec.cwd ? swap(spec.cwd, fromDir, toDir) : toDir,
  };
}
