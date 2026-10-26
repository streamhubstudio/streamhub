import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import {
  EXAMPLE_BUNDLES,
  buildAllBundles,
  buildExampleBundle,
  getExample,
  type ExampleContext,
} from './example-bundle';
import { createZip, type ZipEntry } from './zip';
import { SamplesService } from './samples.service';

/** One example in the download catalogue (list endpoint). */
export interface ExampleListItem {
  id: string;
  file: string;
  title: string;
  description: string;
  authModel: string;
  requiredConfig: string[];
  optionalConfig: string[];
  /** Absolute URL of the per-app-configured zip (management endpoint, bearer). */
  downloadUrl: string;
}

/** A built zip ready to stream. */
export interface BuiltZip {
  filename: string;
  buffer: Buffer;
}

/** Reserved id for the combined "all examples" archive. */
const COMBINED = 'all';
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Downloadable EXAMPLE bundles for an app. Assembles each shipped sample into a
 * self-contained, statically-hostable bundle (`index.html` + `config.js` +
 * `README.md`) pre-configured for the app, and packages it as a zip in-process
 * (no zip binary / library needed). Shares its template source and config layer
 * with the server-rendered `/samples` pages via `example-bundle.ts`.
 */
@Injectable()
export class ExamplesService {
  constructor(private readonly samples: SamplesService) {}

  /** List the example catalogue with per-app download URLs + required config. */
  async list(appName: string): Promise<ExampleListItem[]> {
    const ctx = await this.samples.exampleContext(appName);
    const base = ctx.baseUrl.replace(/\/+$/, '');
    return EXAMPLE_BUNDLES.map((d) => ({
      id: d.id,
      file: d.file,
      title: d.title,
      description: d.description,
      authModel: d.authModel,
      requiredConfig: d.requiredConfig,
      optionalConfig: d.optionalConfig,
      downloadUrl: `${base}/api/v1/apps/${encodeURIComponent(appName)}/examples/${d.id}.zip`,
    }));
  }

  /** Build the zip for one example, configured for the app. */
  async zipOne(appName: string, id: string): Promise<BuiltZip> {
    if (!SAFE_ID.test(id)) {
      throw new BadRequestException(`invalid example id "${id}"`);
    }
    const ctx = await this.samples.exampleContext(appName);
    if (!getExample(id)) {
      throw new NotFoundException(`example "${id}" not found`);
    }
    const { files } = buildExampleBundle(id, ctx);
    const entries: ZipEntry[] = Object.entries(files).map(([name, data]) => ({
      name,
      data,
    }));
    return { filename: `${id}.zip`, buffer: createZip(entries) };
  }

  /** Build a combined zip with every example under its own folder. */
  async zipAll(appName: string): Promise<BuiltZip> {
    const ctx = await this.samples.exampleContext(appName);
    const all = buildAllBundles(ctx);
    const entries: ZipEntry[] = [{ name: 'README.md', data: this.rootReadme(ctx) }];
    for (const [id, files] of Object.entries(all)) {
      for (const [name, data] of Object.entries(files)) {
        entries.push({ name: `${id}/${name}`, data });
      }
    }
    return { filename: 'streamhub-examples.zip', buffer: createZip(entries) };
  }

  /** Resolve a route `:name` (e.g. `webrtc-play.zip` or `all.zip`) → zip. */
  async zipByName(appName: string, name: string): Promise<BuiltZip> {
    const id = name.replace(/\.zip$/i, '');
    if (id === COMBINED) return this.zipAll(appName);
    return this.zipOne(appName, id);
  }

  private rootReadme(ctx: ExampleContext): string {
    const list = EXAMPLE_BUNDLES.map(
      (d) => `- **${d.id}/** — ${d.title}: ${d.description}`,
    ).join('\n');
    return `# StreamHub examples

Self-contained, statically-hostable examples for your StreamHub app
\`${ctx.app}\`. Each folder is independent: edit its \`config.js\`, then host the
folder on any static host (S3, Netlify, nginx, GitHub Pages) or open
\`index.html\` locally. No build step.

## Examples

${list}

Every \`config.js\` is pre-filled with this app's public URLs
(\`${ctx.baseUrl}\`). Change \`baseUrl\`/\`wsUrl\`/\`app\`/\`room\` to retarget.
`;
  }
}
