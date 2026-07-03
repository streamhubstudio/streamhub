import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

import { ConfigService } from '../../shared/config/config.service';
import {
  SampleFileInfo,
  SamplesServiceContract,
} from '../../shared/contracts';
import { AppsService } from '../apps/apps.service';
import { SAMPLE_FILES, TEMPLATES } from './sample-templates';

/**
 * Per-app sample pages (wave-4 §3).
 *
 * Generates self-contained HTML demos under apps/<app>/samples/, each wired to
 * its app (placeholders resolved at generation time). Files are also served
 * publicly + auth-less at `/samples/<app>/<file>` (static mount in main.ts) so
 * they can be embedded as iframes. Editing one app's samples never touches
 * another app's files.
 */
@Injectable()
export class SamplesService implements SamplesServiceContract, OnModuleInit {
  private readonly logger = new Logger(SamplesService.name);

  /** Filenames are restricted to a safe slug + .html (no path traversal). */
  private static readonly SAFE_NAME = /^[a-zA-Z0-9._-]+\.html$/;

  constructor(
    private readonly config: ConfigService,
    private readonly apps: AppsService,
  ) {}

  /**
   * Backfill the wave-4 sample set for apps that already existed before this
   * release (wave-4 §3). Idempotent + non-destructive: only generates when a
   * template file is MISSING, so user edits are never clobbered. Best-effort.
   */
  async onModuleInit(): Promise<void> {
    try {
      const apps = await this.apps.list();
      for (const app of apps) {
        try {
          const dir = path.join(this.apps.appDir(app.name), 'samples');
          const missing = SAMPLE_FILES.some(
            (f) => !fs.existsSync(path.join(dir, f)),
          );
          if (missing) await this.generate(app.name);
        } catch (err) {
          this.logger.warn(
            `sample backfill for "${app.name}" failed: ${(err as Error).message}`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(`sample backfill skipped: ${(err as Error).message}`);
    }
  }

  /** (Re)generate the standard sample set for an app from the templates. */
  async generate(appName: string): Promise<string[]> {
    const dir = await this.samplesDir(appName);
    fs.mkdirSync(dir, { recursive: true });
    const ctx = await this.context(appName);
    const written: string[] = [];
    for (const file of SAMPLE_FILES) {
      const html = this.render(TEMPLATES[file], ctx);
      fs.writeFileSync(path.join(dir, file), html, { encoding: 'utf8', mode: 0o644 });
      written.push(file);
    }
    this.logger.log(`generated ${written.length} samples for app "${appName}"`);
    return written;
  }

  async list(appName: string): Promise<SampleFileInfo[]> {
    const dir = await this.samplesDir(appName);
    const base = this.publicBaseUrl();
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.html'));
    } catch {
      names = [];
    }
    names.sort();
    return names.map((name) => {
      let sizeBytes = 0;
      try {
        sizeBytes = fs.statSync(path.join(dir, name)).size;
      } catch {
        /* ignore */
      }
      return {
        name,
        sizeBytes,
        embedUrl: `${base}/samples/${encodeURIComponent(appName)}/${encodeURIComponent(name)}`,
        generated: (SAMPLE_FILES as string[]).includes(name),
      };
    });
  }

  async read(appName: string, file: string): Promise<string> {
    const full = await this.resolveFile(appName, file);
    try {
      return fs.readFileSync(full, 'utf8');
    } catch {
      throw new NotFoundException(`sample "${file}" not found for app "${appName}"`);
    }
  }

  async write(appName: string, file: string, content: string): Promise<void> {
    const full = await this.resolveFile(appName, file, { forWrite: true });
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, { encoding: 'utf8', mode: 0o644 });
    this.logger.log(`updated sample "${file}" for app "${appName}"`);
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  /** apps/<app>/samples absolute path; throws 404 if the app doesn't exist. */
  private async samplesDir(appName: string): Promise<string> {
    if (!(await this.apps.get(appName))) {
      throw new NotFoundException(`app "${appName}" not found`);
    }
    return path.join(this.apps.appDir(appName), 'samples');
  }

  /** Validate the filename + confine to the app's samples dir. */
  private async resolveFile(
    appName: string,
    file: string,
    opts?: { forWrite?: boolean },
  ): Promise<string> {
    const name = path.basename(file || '');
    if (!SamplesService.SAFE_NAME.test(name) || name !== file) {
      throw new BadRequestException(
        'invalid sample filename (expected a safe *.html name)',
      );
    }
    const dir = await this.samplesDir(appName);
    const full = path.join(dir, name);
    // Defense-in-depth: the resolved path must stay inside the samples dir.
    if (path.relative(dir, full).startsWith('..')) {
      throw new BadRequestException('invalid sample path');
    }
    if (!opts?.forWrite && !fs.existsSync(full)) {
      throw new NotFoundException(`sample "${name}" not found for app "${appName}"`);
    }
    return full;
  }

  /** Placeholder context for an app. */
  private async context(appName: string): Promise<Record<string, string>> {
    const base = this.publicBaseUrl();
    let roomPrefix = appName;
    try {
      const cfg = await this.apps.getConfig(appName);
      roomPrefix = cfg.roomPrefix || appName;
    } catch {
      /* fall back to the app name */
    }
    return {
      APP: appName,
      ROOM: roomPrefix,
      WS_URL: this.config.publicWsUrl || 'wss://media.example.com',
      API_URL: `${base}/api/v1`,
      ADAPTOR_URL: `${base}/sdk/streamhub-adaptor.global.js`,
      HLS_URL: `${base}/hls/${appName}`,
    };
  }

  /** Resolve all `{{KEY}}` placeholders. Unknown keys are left as-is. */
  private render(template: string, ctx: Record<string, string>): string {
    return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key: string) =>
      Object.prototype.hasOwnProperty.call(ctx, key) ? ctx[key] : m,
    );
  }

  /** Public base URL of the deployment (env override, sane default). */
  private publicBaseUrl(): string {
    const fromEnv =
      this.config.publicBaseUrl ||
      this.config.env('PUBLIC_BASE_URL') ||
      this.config.env('STREAMHUB_PUBLIC_URL');
    return (fromEnv || 'https://streamhub.example.com').replace(/\/+$/, '');
  }
}
