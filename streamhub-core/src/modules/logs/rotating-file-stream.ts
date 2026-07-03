import * as fs from 'fs';
import * as path from 'path';

/** Options for {@link RotatingFileStream}. SPEC §5 logs (rotación por tamaño/fecha). */
export interface RotationOptions {
  /** Directory that holds the active + archived log files. */
  dir: string;
  /** Base file name (without extension). Active file = `<baseName>.log`. */
  baseName?: string;
  /**
   * Extra base names whose rotated files still count for retention/cleanup even
   * though we no longer write them (e.g. archives from a previous base name after
   * a rename). Never used for the active file.
   */
  legacyBaseNames?: string[];
  /** Rotate when the active file would exceed this many bytes. */
  maxBytes?: number;
  /** Keep at most this many archived files; older ones are pruned. */
  maxFiles?: number;
  /** Delete rotated files older than this many days. `0` = disabled. */
  maxAgeDays?: number;
}

/**
 * Minimal append-only file logger with basic rotation by size AND by calendar
 * day (SPEC §5). It owns a single active file `<baseName>.log`; on rotation the
 * active file is renamed to `<baseName>-<ISO-ts>.log` and a fresh one is opened.
 *
 * Archived files are pruned by BOTH a count cap (`maxFiles`) and an age cap
 * (`maxAgeDays`). The sweep also matches `legacyBaseNames` so archives from a
 * previous base name are cleaned up after a rename.
 *
 * Robustness first: every operation is wrapped so a filesystem error can never
 * crash the process (SPEC §15 "errores nunca crashean").
 */
export class RotatingFileStream {
  private readonly dir: string;
  private readonly baseName: string;
  private readonly legacyBaseNames: string[];
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly maxAgeMs: number;

  private stream: fs.WriteStream | null = null;
  private size = 0;
  private day = '';

  constructor(opts: RotationOptions) {
    this.dir = opts.dir;
    this.baseName = opts.baseName ?? 'streamhub';
    this.legacyBaseNames = (opts.legacyBaseNames ?? []).filter(
      (b) => b && b !== this.baseName,
    );
    this.maxBytes = opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : 10 * 1024 * 1024;
    this.maxFiles = opts.maxFiles && opts.maxFiles > 0 ? opts.maxFiles : 10;
    this.maxAgeMs =
      opts.maxAgeDays && opts.maxAgeDays > 0
        ? opts.maxAgeDays * 24 * 60 * 60 * 1000
        : 0;
  }

  /** Append a single line (caller includes the trailing newline). Never throws. */
  write(line: string): void {
    try {
      if (!this.stream) this.open();
      const bytes = Buffer.byteLength(line);
      const dayChanged = this.day !== this.today();
      const tooBig = this.size > 0 && this.size + bytes > this.maxBytes;
      if (dayChanged || tooBig) this.rotate();
      this.stream?.write(line);
      this.size += bytes;
    } catch {
      /* logging must never crash the process */
    }
  }

  /**
   * Prune archived files beyond the count cap or older than `maxAgeDays`. Safe
   * to call at any time (e.g. from a periodic retention sweep) — never throws.
   */
  sweep(): void {
    this.prune();
  }

  /** Flush + close the active stream (called on module destroy). */
  close(): void {
    try {
      this.stream?.end();
    } catch {
      /* ignore */
    }
    this.stream = null;
  }

  private activePath(): string {
    return path.join(this.dir, `${this.baseName}.log`);
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private open(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.activePath();
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
    this.stream = fs.createWriteStream(file, { flags: 'a' });
    // Swallow async stream errors (e.g. disk full) so they don't bubble up.
    this.stream.on('error', () => undefined);
    this.size = size;
    this.day = this.today();
  }

  private rotate(): void {
    try {
      this.stream?.end();
    } catch {
      /* ignore */
    }
    this.stream = null;

    const active = this.activePath();
    try {
      if (fs.existsSync(active) && fs.statSync(active).size > 0) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        fs.renameSync(active, path.join(this.dir, `${this.baseName}-${ts}.log`));
      }
    } catch {
      /* if rename fails we just keep appending to the active file */
    }

    this.prune();
    this.open();
  }

  /** True for a rotated archive of ours (current or legacy base name). */
  private isArchive(f: string): boolean {
    if (!f.endsWith('.log')) return false;
    return [this.baseName, ...this.legacyBaseNames].some((b) =>
      f.startsWith(`${b}-`),
    );
  }

  private prune(): void {
    try {
      const now = Date.now();
      const archives = fs
        .readdirSync(this.dir)
        .filter((f) => this.isArchive(f))
        .map((f) => ({
          f,
          t: this.mtime(path.join(this.dir, f)),
        }))
        .sort((a, b) => b.t - a.t);

      const doomed = new Set<string>();
      // Count cap: keep the newest `maxFiles`, drop the rest.
      for (const old of archives.slice(this.maxFiles)) doomed.add(old.f);
      // Age cap: drop anything older than the retention window.
      if (this.maxAgeMs > 0) {
        for (const a of archives) {
          if (a.t > 0 && now - a.t > this.maxAgeMs) doomed.add(a.f);
        }
      }
      for (const f of doomed) {
        try {
          fs.unlinkSync(path.join(this.dir, f));
        } catch {
          /* ignore individual prune failures */
        }
      }
    } catch {
      /* ignore */
    }
  }

  private mtime(file: string): number {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  }
}
