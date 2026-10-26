import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { AuthContext, CurrentAuth } from '../../shared/auth-context';
import {
  BackupRunResult,
  BackupsOverview,
  BackupsService,
  RestoreResult,
} from './backups.service';
import { RestoreBackupDto } from './dto/restore-backup.dto';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}

function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

/**
 * SQLite backup surface (/system/backups). GLOBAL scope only — every endpoint
 * rejects app-scoped principals via the same requireGlobal gate the other
 * superadmin surfaces (/cluster, /system, /security) use: restoring a DB is
 * as destructive as it gets.
 */
@ApiTags('backups')
@ApiBearerAuth()
@Controller('system/backups')
export class BackupsController {
  constructor(private readonly backups: BackupsService) {}

  @Get()
  @ApiOperation({
    summary:
      'List available snapshots per database (global registry + every app.db) ' +
      'with size + timestamp, plus the effective backup settings. ' +
      'Global-scope (superadmin) surface.',
  })
  @ApiOkResponse({ description: '{ data: BackupsOverview }' })
  list(@CurrentAuth() ctx?: AuthContext): Envelope<BackupsOverview> {
    this.requireGlobal(ctx);
    return ok(this.backups.overview());
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Trigger an on-demand backup NOW: VACUUM INTO + gzip snapshot of every ' +
      'SQLite DB, then prune expired snapshots. Returns the run summary.',
  })
  @ApiOkResponse({ description: '{ data: BackupRunResult }' })
  async run(@CurrentAuth() ctx?: AuthContext): Promise<Envelope<BackupRunResult>> {
    this.requireGlobal(ctx);
    return ok(await this.backups.runBackup('manual', ctx?.userId));
  }

  @Post('restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Restore a snapshot over the LIVE database (destructive; requires ' +
      'confirm:true). Validates snapshot integrity first, auto-creates a ' +
      '.pre-restore safety snapshot, swaps atomically and audit-logs. ' +
      'Restoring the global registry recommends a core restart ' +
      '(restartRecommended:true) so cached in-memory state is rebuilt.',
  })
  @ApiOkResponse({ description: '{ data: RestoreResult }' })
  @ApiBadRequestResponse({
    description: 'Missing confirm:true, bad snapshot name or failed integrity.',
  })
  @ApiNotFoundResponse({ description: 'Unknown database or snapshot.' })
  async restore(
    @Body() body: RestoreBackupDto,
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<Envelope<RestoreResult>> {
    this.requireGlobal(ctx);
    if (body.confirm !== true) {
      throw new BadRequestException(
        'confirm:true is required to restore a backup (it overwrites the live DB)',
      );
    }
    return ok(await this.backups.restore(body.db, body.snapshot, ctx?.userId));
  }

  /** Reject app-scoped principals from the global surface (no-op in dev). */
  private requireGlobal(ctx?: AuthContext): void {
    if (ctx && !ctx.isSuperadmin && ctx.scope !== 'global') {
      throw new ForbiddenException(
        'this endpoint requires a global-scope credential',
      );
    }
  }
}
