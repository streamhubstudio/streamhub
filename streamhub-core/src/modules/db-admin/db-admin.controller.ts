import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import {
  DbHealth,
  DbMaintenanceService,
  DbOptimizeResult,
} from '../../shared/db/db-maintenance.service';
import { RecordingService } from '../recording/recording.service';
import { RequirePermission } from '../authz/permission.decorator';
import { AuthContext, CurrentAuth } from '../../shared/auth-context';
import { PurgeDbDto, PurgeScope } from './dto/purge-db.dto';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}

function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

/** Result of a purge, per-slice. */
interface PurgeResult {
  scope: PurgeScope;
  vodsDeleted: number;
  streamsDeleted: number;
  logsDeleted: number;
  s3Deleted: number;
  localDeleted: number;
}

/**
 * SQLite health / maintenance (health, optimize, purge) for the per-app DBs and
 * the global registry DB.
 *
 * App routes are gated by @RequirePermission; the /system route additionally
 * requires a GLOBAL-scope credential (an app token cannot inspect the global
 * registry). When no auth is bound (dev/skeleton), the scope check is a no-op so
 * the local flow keeps working — mirroring AdminController.
 *
 * The VOD purge reuses RecordingService.deleteVod so every removed VOD also
 * drops its S3 objects + local files (the same cascade as DELETE /vods/:id).
 */
@ApiTags('db-admin')
@ApiBearerAuth()
@Controller()
export class DbAdminController {
  /** Page size when cascading a purge over an app's VODs. */
  private static readonly PURGE_PAGE = 200;

  constructor(
    private readonly maintenance: DbMaintenanceService,
    private readonly recording: RecordingService,
  ) {}

  // ---- per-app ---------------------------------------------------------

  @Get('apps/:app/db/health')
  @RequirePermission('usage', 'read')
  @ApiParam({ name: 'app', description: 'App name (slug).', example: 'live' })
  @ApiOperation({
    summary:
      'Health of the app DB: size, WAL size, page/freelist counts, fragmentation %, per-table rows.',
  })
  @ApiOkResponse({ description: '{ data: DbHealth }' })
  appHealth(@Param('app') app: string): Envelope<DbHealth> {
    return ok(this.maintenance.appHealth(app));
  }

  @Post('apps/:app/db/optimize')
  @RequirePermission('app', 'write')
  @ApiParam({ name: 'app', description: 'App name (slug).', example: 'live' })
  @ApiOperation({
    summary:
      'Optimize the app DB: PRAGMA optimize + ANALYZE + REINDEX + VACUUM + wal_checkpoint(TRUNCATE). Returns before/after sizes.',
  })
  @ApiOkResponse({ description: '{ data: DbOptimizeResult }' })
  optimizeApp(@Param('app') app: string): Envelope<DbOptimizeResult> {
    return ok(this.maintenance.optimizeApp(app));
  }

  @Post('apps/:app/db/purge')
  @RequirePermission('app', 'delete')
  @ApiParam({ name: 'app', description: 'App name (slug).', example: 'live' })
  @ApiOperation({
    summary:
      "Purge app data by scope ('vods' | 'logs' | 'all'); requires confirm:true. " +
      'VOD purges cascade to S3 + local files. Never removes the app or its config.',
  })
  @ApiOkResponse({ description: '{ data: PurgeResult }' })
  async purge(
    @Param('app') app: string,
    @Body() body: PurgeDbDto,
  ): Promise<Envelope<PurgeResult>> {
    if (body.confirm !== true) {
      throw new BadRequestException('confirm:true is required to purge');
    }
    const scope = body.scope;
    const result: PurgeResult = {
      scope,
      vodsDeleted: 0,
      streamsDeleted: 0,
      logsDeleted: 0,
      s3Deleted: 0,
      localDeleted: 0,
    };

    if (scope === 'vods' || scope === 'all') {
      const casc = await this.purgeVods(app);
      result.vodsDeleted = casc.vodsDeleted;
      result.s3Deleted = casc.s3Deleted;
      result.localDeleted = casc.localDeleted;
    }
    if (scope === 'all') {
      result.streamsDeleted = this.maintenance.purgeAppStreams(app);
    }
    if (scope === 'logs' || scope === 'all') {
      result.logsDeleted = this.maintenance.purgeAppLogs(app);
    }

    return ok(result);
  }

  /**
   * Cascade-delete every VOD of an app, reusing the recording service's per-VOD
   * cascade (row + S3 objects + local files). Pages from the front each round —
   * deletes shrink the list, so we re-list offset 0 until it drains.
   */
  private async purgeVods(app: string): Promise<{
    vodsDeleted: number;
    s3Deleted: number;
    localDeleted: number;
  }> {
    let vodsDeleted = 0;
    let s3Deleted = 0;
    let localDeleted = 0;
    // Bound the loop defensively so a delete that fails to remove a row can't spin.
    for (let guard = 0; guard < 100000; guard++) {
      const page = this.recording.listVods(app, {
        limit: DbAdminController.PURGE_PAGE,
        offset: 0,
      }).data;
      if (page.length === 0) break;
      let progressed = false;
      for (const vod of page) {
        try {
          const res = await this.recording.deleteVod(app, vod.id);
          vodsDeleted += 1;
          s3Deleted += res.s3Deleted;
          if (res.localDeleted) localDeleted += 1;
          progressed = true;
        } catch {
          /* skip a VOD that vanished mid-purge; keep going */
        }
      }
      if (!progressed) break; // nothing deletable this round — avoid an infinite loop
    }
    return { vodsDeleted, s3Deleted, localDeleted };
  }

  // ---- global ----------------------------------------------------------

  @Get('system/db/health')
  @RequirePermission('usage', 'read')
  @ApiOperation({
    summary:
      'Health of the GLOBAL registry DB (data/streamhub.db). Requires a global-scope token.',
  })
  @ApiOkResponse({ description: '{ data: DbHealth }' })
  systemHealth(@CurrentAuth() ctx?: AuthContext): Envelope<DbHealth> {
    this.requireGlobal(ctx);
    return ok(this.maintenance.globalHealth());
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
