import { Controller, Get, Param, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';

import { RequirePermission } from '../authz/permission.decorator';
import { ExamplesService, ExampleListItem } from './examples.service';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}

function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

/**
 * Downloadable example bundles (per app). Each shipped sample can be pulled as a
 * self-contained zip (`index.html` + `config.js` + `README.md`) that a user
 * drops on ANY static host and points at their own StreamHub by editing
 * `config.js`. The zip's `config.js` is pre-filled with THIS app's public URLs.
 *
 * All routes are management (Bearer, `sample:read`). The zip carries no secrets
 * (public baseUrl/wsUrl + non-sensitive app/room slugs; credential fields are
 * left empty for the user to fill).
 */
@ApiTags('examples')
@ApiBearerAuth()
@ApiParam({ name: 'app', description: 'App name (slug).', example: 'live' })
@Controller('apps/:app/examples')
export class ExamplesController {
  constructor(private readonly examples: ExamplesService) {}

  @Get()
  @RequirePermission('sample', 'read')
  @ApiOperation({
    summary: 'List the downloadable example bundles (+ per-app download URLs).',
  })
  @ApiOkResponse({ description: 'Array of example catalogue entries.' })
  async list(
    @Param('app') app: string,
  ): Promise<Envelope<ExampleListItem[]>> {
    return ok(await this.examples.list(app));
  }

  @Get(':name')
  @RequirePermission('sample', 'read')
  @ApiProduces('application/zip')
  @ApiOperation({
    summary:
      'Download one example bundle as a zip (or `all.zip` for the combined ' +
      'archive), pre-configured for this app.',
  })
  @ApiParam({ name: 'name', example: 'webrtc-play.zip' })
  @ApiOkResponse({ description: 'application/zip attachment.' })
  async download(
    @Param('app') app: string,
    @Param('name') name: string,
    @Res() res: Response,
  ): Promise<void> {
    const { filename, buffer } = await this.examples.zipByName(app, name);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'no-store');
    res.end(buffer);
  }
}
