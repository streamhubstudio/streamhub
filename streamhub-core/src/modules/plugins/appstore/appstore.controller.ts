/**
 * APPSTORE controller — the SUPERADMIN version store surface (base `plugins` →
 * `/api/v1/plugins/*`, distinct from the app-scoped `apps/:app/plugins`).
 *
 *   GET    /plugins/:id/versions            list the version catalog
 *   POST   /plugins/:id/versions            upload a new immutable version (multipart)
 *   GET    /plugins/:id/versions/:v/bundle  download a bundle (sk_ OR X-Cluster-Token)
 *   DELETE /plugins/:id/versions/:v         delete a version (refused if pinned/builtin)
 *
 * Auth: every route is @Public() to the global Bearer guard and gated MANUALLY,
 * so the bundle download can accept EITHER a superadmin sk_ OR the shared
 * `X-Cluster-Token` (nodes fetch pinned bundles over that same NAT-friendly gate
 * they already use for join/heartbeat/grid). The mutating routes require a
 * superadmin credential.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Optional,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { ConfigService } from '../../../shared/config/config.service';
import {
  AUTH_VALIDATOR,
  AuthValidatorContract,
  Public,
} from '../../../shared/auth';
import { getAuthCtx } from '../../../shared/auth-context';
import { assertClusterToken } from '../../cluster/cluster-token.util';
import { UploadVersionDto } from '../dto/upload-version.dto';
import { AppstoreService } from './appstore.service';
import { PluginVersionService } from './plugin-version.service';
import { BundleManifest, VersionCatalog } from './appstore.types';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}
function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

/** Max accepted bundle upload (source-only bundles are small; headroom only). */
const MAX_BUNDLE_BYTES = 200 * 1024 * 1024;

@ApiTags('appstore')
@Controller('plugins')
export class AppstoreController {
  constructor(
    private readonly config: ConfigService,
    private readonly appstore: AppstoreService,
    private readonly versions: PluginVersionService,
    // Reused to authenticate the sk_ path of the dual-auth bundle download under
    // @Public (AuthModule is @Global + exports AUTH_VALIDATOR). @Optional so bare
    // unit specs construct the controller without the auth graph.
    @Optional()
    @Inject(AUTH_VALIDATOR)
    private readonly validator?: AuthValidatorContract,
  ) {}

  @Public()
  @Get(':id/versions')
  @ApiOperation({
    summary: 'List the appstore version catalog for a plugin (superadmin).',
    description:
      'Every stored version with its source (builtin|uploaded), sha256, size ' +
      'and the builtin/latest flags. Requires a superadmin credential.',
  })
  @ApiParam({ name: 'id', description: 'Plugin id.' })
  @ApiOkResponse({ description: '{ data: VersionCatalog }' })
  async list(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<Envelope<VersionCatalog>> {
    await this.requireSuperadmin(req);
    return ok(this.appstore.listVersions(id));
  }

  @Public()
  @Post(':id/versions')
  @UseInterceptors(
    FileInterceptor('bundle', { limits: { fileSize: MAX_BUNDLE_BYTES } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a new immutable version bundle (superadmin, multipart).',
    description:
      'multipart/form-data: `bundle` (the gzip tarball, streamhub-app export ' +
      'layout), `version` (semver), optional `notes`. Validates the shape + ' +
      'semver, computes the sha256 server-side, and rejects a duplicate version ' +
      'with 409 (immutable store — bump the semver).',
  })
  @ApiParam({ name: 'id', description: 'Plugin id.' })
  @ApiOkResponse({ description: '{ data: BundleManifest }' })
  async upload(
    @Param('id') id: string,
    @UploadedFile() file: { buffer?: Buffer } | undefined,
    @Body() dto: UploadVersionDto,
    @Req() req: Request,
  ): Promise<Envelope<BundleManifest>> {
    await this.requireSuperadmin(req);
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException("missing 'bundle' file part");
    }
    return ok(this.appstore.saveUploaded(id, dto.version, file.buffer, dto.notes));
  }

  @Public()
  @Get(':id/versions/:v/bundle')
  @ApiOperation({
    summary: 'Download a version bundle (superadmin sk_ OR X-Cluster-Token).',
    description:
      'Serves the gzip tarball for a stored version. Accepts a superadmin ' +
      'Bearer token OR the shared X-Cluster-Token (so edge/common nodes can ' +
      'fetch a pinned bundle over the same gate they use for join/heartbeat). ' +
      '404 when the version does not exist.',
  })
  @ApiParam({ name: 'id', description: 'Plugin id.' })
  @ApiParam({ name: 'v', description: 'Version id (semver or builtin-<core>).' })
  async downloadBundle(
    @Param('id') id: string,
    @Param('v') v: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    await this.assertBundleAuth(req);
    const { body, sha256, filename } = this.appstore.readBundle(id, v);
    // Let a node verify the bytes it fetched match what the assign frame named.
    res.setHeader('x-bundle-sha256', sha256);
    return new StreamableFile(body, {
      type: 'application/gzip',
      disposition: `attachment; filename="${filename}"`,
      length: body.length,
    });
  }

  @Public()
  @Delete(':id/versions/:v')
  @ApiOperation({
    summary: 'Delete a version (superadmin). Refused if pinned or built-in.',
    description:
      'Removes a stored version. 409 when any app install pins it (unpin ' +
      'first); 400 for a built-in (undeletable); 404 when unknown.',
  })
  @ApiParam({ name: 'id', description: 'Plugin id.' })
  @ApiParam({ name: 'v', description: 'Version id.' })
  @ApiOkResponse({ description: '{ data: { deleted: true } }' })
  async remove(
    @Param('id') id: string,
    @Param('v') v: string,
    @Req() req: Request,
  ): Promise<Envelope<{ deleted: true }>> {
    await this.requireSuperadmin(req);
    await this.versions.deleteVersion(id, v);
    return ok({ deleted: true as const });
  }

  // ---------------------------------------------------------------------------

  /**
   * Authenticate a request that reaches a @Public route as a SUPERADMIN. Runs
   * the normal Bearer validator manually (it also populates req.authCtx) and
   * requires a superadmin/global principal. Fails closed (401) on a bad token,
   * 403 for a non-superadmin. In a bare dev/test harness with no validator bound
   * it allows through, matching the global guard's dev behaviour.
   */
  private async requireSuperadmin(req: Request): Promise<void> {
    if (!this.validator) return; // no auth graph (bare skeleton) → allow
    await this.validator.validate(req); // throws 401 on invalid/missing creds
    const ctx = getAuthCtx(req);
    if (ctx && !ctx.isSuperadmin && ctx.scope !== 'global') {
      throw new ForbiddenException('this endpoint requires a superadmin credential');
    }
  }

  /**
   * Bundle-download auth: a valid `X-Cluster-Token` (node fetch) OR a superadmin
   * Bearer. Checked in that order so a node never needs an sk_.
   */
  private async assertBundleAuth(req: Request): Promise<void> {
    if (req.header('x-cluster-token')) {
      assertClusterToken(
        req,
        this.config.clusterToken,
        'bundle download disabled (STREAMHUB_CLUSTER_TOKEN unset)',
      );
      return;
    }
    await this.requireSuperadmin(req);
  }
}
