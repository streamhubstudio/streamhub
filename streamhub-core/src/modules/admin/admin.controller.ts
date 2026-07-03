import {
  Controller,
  ForbiddenException,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { exec } from 'child_process';
import type { Request } from 'express';

import { ConfigService } from '../../shared/config/config.service';
import type { AuthContext } from '../../shared/auth/auth.guard';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}

/**
 * Admin / process control (wave-4 §1).
 *
 * `POST /admin/restart` restarts the streamhub-core process via systemd
 * (best-effort) — used as the heavy fallback when a hot-reload is not enough.
 * Requires a GLOBAL-scope token (an app-scoped token cannot restart the server).
 * The unit name is configurable via `SYSTEMD_UNIT` (default `streamhub-core`).
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(private readonly config: ConfigService) {}

  @Post('restart')
  @ApiOperation({
    summary:
      'Restart the streamhub-core process via systemd (best-effort). Requires a global-scope token (wave-4 §1).',
  })
  @ApiOkResponse({
    description: '{ data: { scheduled, unit } } — restart was dispatched.',
  })
  restart(
    @Req() req: Request & { auth?: AuthContext },
  ): Envelope<{ scheduled: boolean; unit: string }> {
    // Gate on global scope. When no validator is bound (skeleton/dev), req.auth
    // is undefined and we allow it so the dev flow keeps working.
    if (req.auth && req.auth.scope !== 'global') {
      throw new ForbiddenException('restart requires a global-scope token');
    }

    const unit = this.config.env('SYSTEMD_UNIT') || 'streamhub-core';
    // Dispatch asynchronously AFTER responding, so the HTTP reply is flushed
    // before the process goes down. `systemctl restart` (or sudo fallback).
    const cmd = `systemctl restart ${unit} || sudo -n systemctl restart ${unit}`;
    setTimeout(() => {
      exec(cmd, (err, _stdout, stderr) => {
        if (err) {
          this.logger.error(
            `admin restart of "${unit}" failed: ${stderr || err.message}`,
          );
        }
      });
    }, 250);

    this.logger.warn(`admin restart of "${unit}" scheduled`);
    return { data: { scheduled: true, unit }, error: null };
  }
}
