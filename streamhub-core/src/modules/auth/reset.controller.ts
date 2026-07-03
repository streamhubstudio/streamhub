import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../shared/auth';
import { ResetService } from './reset.service';
import { ResetRequestDto } from './dto/reset-request.dto';
import { ResetDto } from './dto/reset.dto';
import { MagicLinkResponseDto } from './dto/magic-response.dto';
import { LoginResponseDto } from './dto/login-response.dto';

/** Generic, non-revealing acknowledgement for POST /auth/reset-request. */
const GENERIC_RESET_ACK =
  'If that email has an account, we just sent a password-reset link.';

/**
 * Password-reset by email (mirrors the magic-link controller). Both endpoints
 * are PUBLIC — a locked-out user has no Bearer token to present.
 *
 *   POST /api/v1/auth/reset-request { email }            → generic 200 (anti-enum)
 *   POST /api/v1/auth/reset         { token, password }  → { data: { token } } JWT
 *
 * The reset JWT is the SAME session token password login mints, so the SPA can
 * drop the user straight into an authenticated session after they reset.
 */
@ApiTags('auth')
@Controller('auth')
export class ResetController {
  constructor(private readonly reset: ResetService) {}

  @Public()
  @Post('reset-request')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Request a password-reset link (public, no auth)',
    description:
      'Generates a single-use token (30-min TTL, stored hashed) and emails a ' +
      'link to https://app.streamhub.studio/auth/reset?token=<token>. ALWAYS ' +
      'returns a generic 200 — it never reveals whether the email exists. ' +
      'Rate-limited per email and per IP. The break-glass admin and superadmin ' +
      'accounts are never resettable through this flow.',
  })
  @ApiOkResponse({ type: MagicLinkResponseDto })
  async request(
    @Body() dto: ResetRequestDto,
    @Req() req: Request,
  ): Promise<MagicLinkResponseDto> {
    // Await so failures are logged, but the response is identical regardless of
    // the outcome (anti-enumeration).
    await this.reset.requestReset(dto.email, this.clientIp(req));
    return { data: { message: GENERIC_RESET_ACK } };
  }

  @Public()
  @Post('reset')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Set a new password from a reset token → session JWT (public)',
    description:
      'Validates the one-time token (exists, unexpired, unused), marks it used, ' +
      'sets the new scrypt password on the user and returns a session JWT (~12h) ' +
      '— the same token password login mints — so the user is logged in directly.',
  })
  @ApiOkResponse({ type: LoginResponseDto })
  async submit(@Body() dto: ResetDto): Promise<LoginResponseDto> {
    const { token } = await this.reset.reset(dto.token, dto.password);
    return { data: { token } };
  }

  /** Real client IP, honouring nginx's X-Forwarded-For. */
  private clientIp(req: Request): string | null {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length > 0) {
      return this.normalizeIp(fwd.split(',')[0].trim());
    }
    if (Array.isArray(fwd) && fwd.length > 0) {
      return this.normalizeIp(fwd[0].trim());
    }
    const ip = req.ip || req.socket?.remoteAddress || '';
    return ip ? this.normalizeIp(ip) : null;
  }

  private normalizeIp(ip: string): string {
    return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  }
}
