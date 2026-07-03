import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthContext, CurrentAuth } from '../../shared/auth-context';
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
  constructor(private readonly auth: AuthService) {}

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
  create(
    @Body() dto: CreateTokenDto,
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<CreatedToken> {
    this.requireGlobal(ctx);
    return this.auth.createToken({
      name: dto.name,
      scope: dto.scope,
      appId: dto.appId ?? null,
      allowedIps: dto.allowedIps,
    });
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke (soft-delete) an API token.' })
  @ApiNoContentResponse({ description: 'Token revoked.' })
  revoke(
    @Param('id', ParseIntPipe) id: number,
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<void> {
    this.requireGlobal(ctx);
    return this.auth.revokeToken(id);
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
