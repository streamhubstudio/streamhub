/**
 * Unit spec — dangerous execution primitives (Streamflow). The node:vm sandbox
 * is the security-critical one and is tested for real (no infra): it computes,
 * but blocks require/process and the Function('…') escape, enforces the timeout,
 * caps output size, and rejects non-serialisable output. runShellCommand is
 * exercised via the node binary (argv array — no shell). ssh/db real drivers are
 * covered at the executor layer with fakes (they need live servers).
 */
import { runCodeSandbox, runShellCommand } from './danger-exec';

const CODE_OPTS = { timeoutMs: 2000, maxOutputBytes: 64 * 1024 };

describe('runCodeSandbox', () => {
  it('runs a snippet and returns JSON output', async () => {
    const r = await runCodeSandbox({ source: 'output = input.a + input.b', input: { a: 2, b: 3 }, ...CODE_OPTS });
    expect(r.ok).toBe(true);
    expect(r.output).toBe(5);
  });

  it('has no require / process in the sandbox', async () => {
    const r1 = await runCodeSandbox({ source: 'output = require("fs")', input: {}, ...CODE_OPTS });
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/require/);
    const r2 = await runCodeSandbox({ source: 'output = process.env', input: {}, ...CODE_OPTS });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/process/);
  });

  it('blocks the Function/eval constructor-walk escape', async () => {
    const r = await runCodeSandbox({
      source: 'output = this.constructor.constructor("return process")()',
      input: {},
      ...CODE_OPTS,
    });
    expect(r.ok).toBe(false);
  });

  it('enforces the hard timeout', async () => {
    const r = await runCodeSandbox({ source: 'while (true) {}', input: {}, timeoutMs: 50, maxOutputBytes: 1024 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out|timeout/i);
  });

  it('caps output size', async () => {
    const r = await runCodeSandbox({ source: 'output = "x".repeat(1000)', input: {}, timeoutMs: 2000, maxOutputBytes: 100 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/too large/);
  });

  it('rejects non-serialisable (circular) output', async () => {
    const r = await runCodeSandbox({ source: 'output = {}; output.self = output', input: {}, ...CODE_OPTS });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/serialis|serializ/i);
  });

  it('cannot mutate the frozen input', async () => {
    const r = await runCodeSandbox({ source: 'try { input.a = 9 } catch (e) {} output = input.a', input: { a: 1 }, ...CODE_OPTS });
    expect(r.output).toBe(1);
  });
});

describe('runShellCommand', () => {
  it('runs via execFile with an argv array (no shell)', async () => {
    const r = await runShellCommand({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("hi")'],
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('hi');
  });

  it('reports failure for an unknown command', async () => {
    const r = await runShellCommand({
      command: 'definitely-not-a-real-command-xyz',
      args: [],
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    });
    expect(r.ok).toBe(false);
  });
});
