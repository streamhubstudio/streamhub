import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContext, CurrentAuth } from '../../shared/auth-context';
import {
  getRequestSessionId,
  SessionService,
  SessionSummary,
} from './session.service';

interface Envelope<T> {
  data: T;
  error: null;
}

/**
 * Active login sessions of the CALLER (Active Sessions in "Mi cuenta"). Every
 * route resolves the principal from the AuthContext — a user can only ever see
 * or revoke their OWN sessions. Human sessions only (user_jwt/admin_jwt); `sk_`
 * API tokens have no session and get 403.
 *
 *   GET    /auth/sessions       → the caller's live sessions (+ `current`)
 *   DELETE /auth/sessions/:id   → revoke one (revoking the current = logout)
 *   DELETE /auth/sessions       → revoke every OTHER session (keep this one)
 */
@ApiTags('auth')
@ApiBearerAuth()
@Controller('auth/sessions')
export class SessionController {
  constructor(private readonly sessions: SessionService) {}

  @Get()
  @ApiOperation({ summary: 'List my active sessions (ip, dates, current flag).' })
  @ApiOkResponse({ description: '{ data: SessionSummary[] }' })
  list(
    @Req() req: Request,
    @CurrentAuth() ctx?: AuthContext,
  ): Envelope<SessionSummary[]> {
    const human = this.requireHuman(ctx);
    return {
      data: this.sessions.listForUser(human.userId, getRequestSessionId(req)),
      error: null,
    };
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Revoke one of my sessions (revoking the current one signs me out).',
  })
  @ApiOkResponse({ description: '{ data: { revoked: true, current: boolean } }' })
  revoke(
    @Param('id') id: string,
    @Req() req: Request,
    @CurrentAuth() ctx?: AuthContext,
  ): Envelope<{ revoked: true; current: boolean }> {
    const human = this.requireHuman(ctx);
    const ok = this.sessions.revoke(human.userId, id);
    if (!ok) throw new NotFoundException('session not found');
    return {
      data: { revoked: true, current: id === getRequestSessionId(req) },
      error: null,
    };
  }

  @Delete()
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign out every OTHER session, keeping this one.' })
  @ApiOkResponse({ description: '{ data: { revoked: <count> } }' })
  revokeOthers(
    @Req() req: Request,
    @CurrentAuth() ctx?: AuthContext,
  ): Envelope<{ revoked: number }> {
    const human = this.requireHuman(ctx);
    return {
      data: {
        revoked: this.sessions.revokeOthers(
          human.userId,
          getRequestSessionId(req),
        ),
      },
      error: null,
    };
  }

  /** Sessions are for signed-in HUMANS; machine tokens have none → 403. */
  private requireHuman(ctx?: AuthContext): AuthContext {
    if (!ctx || ctx.via === 'api_token') {
      throw new ForbiddenException('API tokens have no sessions');
    }
    return ctx;
  }
}
