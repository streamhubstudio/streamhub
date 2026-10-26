/**
 * DANGEROUS execution implementations (Streamflow) -- the code/shell/ssh/db
 * primitives the runner adapts into the BoxDeps seam. Extracted here so the
 * security-critical node:vm sandbox is unit-testable directly, without DI.
 *
 * SECURITY (owner review):
 *  - `runCodeSandbox` uses node:vm -- a GUARDRAIL, NOT a hard security boundary.
 *    A determined attacker may still find an escape. Mitigations: a frozen,
 *    no-builtins context with code generation from strings DISABLED (blocks
 *    Function('...')/eval → the classic constructor-walk escape), a JSON deep-clone
 *    of the input (no host object/prototype references leak in), a hard timeout,
 *    and an output size cap. Follow-up: isolated-vm / subprocess for true
 *    isolation. Gated OFF by default (streamflow.dangerousNodes).
 *  - `runShellCommand` uses child_process.execFile -- argv array, NO shell string
 *    interpolation; scrubbed env; timeout + output truncation.
 *  - `runSshCommand` uses ssh2; the private key is passed in already resolved
 *    from a secret ref (never inline in the graph); readyTimeout + truncation.
 *  - `runDbQuery` uses pg / mysql2 with PARAMETERIZED queries ONLY -- the SQL text
 *    is passed verbatim to the driver and params bound separately; row-limited.
 */
import { execFile } from 'node:child_process';
import * as vm from 'node:vm';

import type { ExecResult } from './context';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...[truncated]` : s;
}

const SERIALIZE_ERR = ' SF_UNSERIALISABLE';

export async function runCodeSandbox(input: {
  source: string;
  input: unknown;
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<ExecResult> {
  try {
    // CRITICAL: we pass NOTHING from the host realm into the context. Handing the
    // sandbox a host object (input/JSON/Math/console) leaks the host realm through
    // its prototype chain (`x.constructor.constructor === host Function`) -- the
    // classic node:vm escape. Instead: create an EMPTY context (its own
    // intrinsics), then reconstruct `input` INSIDE it via context-native
    // JSON.parse, and read `output` back as a serialized string primitive. With
    // code generation from strings disabled, the context's own Function/eval also
    // throw, blocking the constructor-walk escape.
    const inJson = (() => {
      try {
        return JSON.stringify(input.input ?? {});
      } catch {
        return '{}';
      }
    })();
    // A NULL-prototype global so `this.constructor` (the global's own proto
    // chain) can't reach the host Function -- the last escape vector after the
    // input/intrinsics are context-native.
    const context = vm.createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false },
    });
    // Bootstrap runs BEFORE code generation is exercised by user code; it embeds
    // the input as a JS string literal parsed by the CONTEXT's JSON (no host ref).
    const bootstrap =
      `Object.defineProperty(globalThis,'input',{value:Object.freeze(JSON.parse(${JSON.stringify(
        inJson,
      )})),writable:false,configurable:false});` +
      `var output;var console={log:function(){},error:function(){},warn:function(){}};`;
    new vm.Script(bootstrap, { filename: 'streamflow-bootstrap.js' }).runInContext(context);
    new vm.Script(String(input.source), { filename: 'streamflow-code.js' }).runInContext(
      context,
      { timeout: input.timeoutMs, breakOnSigint: true },
    );
    // Serialize INSIDE the context → a host string primitive (no object ref out).
    const serialized = new vm.Script(
      `(function(){try{return JSON.stringify(typeof output==='undefined'?null:output)}catch(e){return ${JSON.stringify(
        SERIALIZE_ERR,
      )}}})()`,
      { filename: 'streamflow-out.js' },
    ).runInContext(context, { timeout: 1000 });
    if (typeof serialized !== 'string' || serialized === SERIALIZE_ERR || serialized === undefined) {
      return { ok: false, error: 'output is not JSON-serialisable' };
    }
    if (serialized.length > input.maxOutputBytes) {
      return { ok: false, error: 'output too large' };
    }
    return { ok: true, output: JSON.parse(serialized) };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

export async function runShellCommand(input: {
  command: string;
  args: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    // execFile → NO shell string interpolation; argv array only. Scrubbed env.
    execFile(
      input.command,
      input.args,
      {
        timeout: input.timeoutMs,
        maxBuffer: input.maxOutputBytes,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          LANG: process.env.LANG ?? 'C',
        },
      },
      (err, stdout, stderr) => {
        const out = truncate(String(stdout ?? ''), input.maxOutputBytes);
        const errOut = truncate(String(stderr ?? ''), input.maxOutputBytes);
        if (err) {
          const code = (err as NodeJS.ErrnoException & { code?: number }).code;
          resolve({
            ok: false,
            code: typeof code === 'number' ? code : null,
            stdout: out,
            stderr: errOut,
            error: err.message,
          });
          return;
        }
        resolve({ ok: true, code: 0, stdout: out, stderr: errOut });
      },
    );
  });
}

export async function runSshCommand(input: {
  host: string;
  port: number;
  user: string;
  privateKey: string;
  passphrase?: string;
  command: string;
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<ExecResult> {
  let Client: typeof import('ssh2').Client;
  try {
    ({ Client } = await import('ssh2'));
  } catch {
    return { ok: false, error: 'ssh2 is not installed' };
  }
  return new Promise<ExecResult>((resolve) => {
    const conn = new Client();
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: ExecResult) => {
      if (settled) return;
      settled = true;
      try {
        conn.end();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, error: 'ssh timeout' }), input.timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    conn
      .on('ready', () => {
        conn.exec(input.command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            return done({ ok: false, error: err.message });
          }
          stream
            .on('close', (code: number) => {
              clearTimeout(timer);
              done({
                ok: code === 0,
                code,
                stdout: truncate(stdout, input.maxOutputBytes),
                stderr: truncate(stderr, input.maxOutputBytes),
              });
            })
            .on('data', (d: Buffer) => {
              stdout += d.toString();
            })
            .stderr.on('data', (d: Buffer) => {
              stderr += d.toString();
            });
        });
      })
      .on('error', (err: Error) => {
        clearTimeout(timer);
        done({ ok: false, error: err.message });
      })
      .connect({
        host: input.host,
        port: input.port,
        username: input.user,
        privateKey: input.privateKey,
        passphrase: input.passphrase,
        readyTimeout: input.timeoutMs,
      });
  });
}

export async function runDbQuery(input: {
  engine: 'postgres' | 'mysql';
  dsn: string;
  query: string;
  params: unknown[];
  rowLimit: number;
  timeoutMs: number;
}): Promise<ExecResult> {
  try {
    if (input.engine === 'postgres') {
      const pg = await import('pg');
      const client = new pg.Client({
        connectionString: input.dsn,
        statement_timeout: input.timeoutMs,
        query_timeout: input.timeoutMs,
      });
      await client.connect();
      try {
        // Parameterized ONLY: params are bound ($1..$n), never interpolated.
        const res = await client.query(input.query, input.params);
        const rows = Array.isArray(res.rows) ? res.rows.slice(0, input.rowLimit) : [];
        return { ok: true, output: rows, rowCount: res.rowCount ?? rows.length };
      } finally {
        await client.end().catch(() => undefined);
      }
    }
    const mysql = await import('mysql2/promise');
    const conn = await mysql.createConnection(input.dsn);
    try {
      // Parameterized ONLY: `?` placeholders bound to params (driver-typed as a
      // loose value array at this boundary).
      const [rows] = await conn.execute(input.query, input.params as never[]);
      const list = Array.isArray(rows) ? rows.slice(0, input.rowLimit) : [];
      return { ok: true, output: list, rowCount: list.length };
    } finally {
      await conn.end().catch(() => undefined);
    }
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}
