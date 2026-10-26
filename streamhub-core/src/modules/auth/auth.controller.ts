import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Optional,
  Param,
  ParseIntPipe,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContext, CurrentAuth } from '../../shared/auth-context';
import {
  actorFromCtx,
  AuditService,
  requestIp,
} from '../audit/audit.service';
import { AuthService, CreatedToken, TokenSummary } from './auth.service';
import { CreateTokenDto } from './dto/create-token.dto';
import { CreatedTokenDto, TokenSummaryDto } from './dto/token-response.dto';

/**
 * API token management (SPEC §6: /tokens). All routes require a valid Bearer
 * token AND global scope: minting/listing/revoking API tokens is a
 * superadmin/global operation. Fase-0 M2: without this, any authenticated
 * app-scoped token could mint itself a `scope:'global'` token (privilege
 * escalation) or revoke other tenants' tokens. Break-glass admin and the global
 * `sk_` token are `scope:'global'`/superadmin, so they keep full access.
 */
@ApiTags('tokens')
@ApiBearerAuth()
@Controller('tokens')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    /** Security audit trail (ISO 8.15) — optional for bare-ctor unit specs. */
    @Optional() private readonly audit?: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List API tokens (hashes never returned).' })
  @ApiOkResponse({ type: [TokenSummaryDto] })
  list(@CurrentAuth() ctx?: AuthContext): Promise<TokenSummary[]> {
    this.requireGlobal(ctx);
    return this.auth.listTokens();
  }

  @Post()
  @ApiOperation({
    summary: 'Create an API token. Plaintext is returned ONCE.',
  })
  @ApiCreatedResponse({ type: CreatedTokenDto })
  async create(
    @Body() dto: CreateTokenDto,
    @Req() req?: Request,
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<CreatedToken> {
    this.requireGlobal(ctx);
    const created = await this.auth.createToken({
      name: dto.name,
      scope: dto.scope,
      appId: dto.appId ?? null,
      allowedIps: dto.allowedIps,
    });
    // Audit the mint (ISO 8.15). Metadata only — NEVER the plaintext token.
    this.audit?.record({
      action: 'token.create',
      ...actorFromCtx(ctx),
      targetType: 'token',
      targetId: String(created.id),
      ip: requestIp(req),
      meta: { name: dto.name, scope: dto.scope, appId: dto.appId ?? null },
    });
    return created;
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke (soft-delete) an API token.' })
  @ApiNoContentResponse({ description: 'Token revoked.' })
  async revoke(
    @Param('id', ParseIntPipe) id: number,
    @Req() req?: Request,
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<void> {
    this.requireGlobal(ctx);
    await this.auth.revokeToken(id);
    this.audit?.record({
      action: 'token.revoke',
      ...actorFromCtx(ctx),
      targetType: 'token',
      targetId: String(id),
      ip: requestIp(req),
    });
  }

  /** Token management is global-only (superadmin / global sk_). No-op in dev
   * when no auth context is present (mirrors the cluster/db-admin pattern). */
  private requireGlobal(ctx?: AuthContext): void {
    if (ctx && !ctx.isSuperadmin && ctx.scope !== 'global') {
      throw new ForbiddenException(
        'token management requires a global-scope credential',
      );
    }
  }
}
