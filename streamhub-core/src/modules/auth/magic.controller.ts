import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../shared/auth';
import { MagicLinkService } from './magic-link.service';
import { sessionContextFromRequest } from './session.service';
import { MagicLinkRequestDto } from './dto/magic-link-request.dto';
import { MagicLinkResponseDto } from './dto/magic-response.dto';
import { MagicVerifyDto } from './dto/magic-verify.dto';
import { LoginResponseDto } from './dto/login-response.dto';

/** Generic, non-revealing acknowledgement for POST /auth/magic-link. */
const GENERIC_MAGIC_ACK =
  'If that email is valid, we just sent a sign-in link.';

/**
 * Passwordless magic-link auth (Wave-7 §auth). Both endpoints are PUBLIC (no
 * Bearer needed) — they are how a user obtains a session in the first place.
 *
 *   POST /api/v1/auth/magic-link   { email }  → generic 200 (anti-enumeration)
 *   POST /api/v1/auth/magic/verify { token }  → { data: { token: <session JWT> } }
 *
 * The verify JWT is the SAME session token the password login mints, so the
 * rest of the API treats magic-link sessions identically.
 */
@ApiTags('auth')
@Controller('auth')
export class MagicController {
  constructor(private readonly magic: MagicLinkService) {}

  @Public()
  @Post('magic-link')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Request a passwordless sign-in link (public, no auth)',
    description:
      'Generates a single-use token (15-min TTL, stored hashed) and emails a ' +
      'link to https://app.streamhub.studio/auth/magic?token=<token>. ALWAYS ' +
      'returns a generic 200 — it never reveals whether the email exists. ' +
      'Rate-limited per email and per IP to prevent email-bombing.',
  })
  @ApiOkResponse({ type: MagicLinkResponseDto })
  async request(
    @Body() dto: MagicLinkRequestDto,
    @Req() req: Request,
  ): Promise<MagicLinkResponseDto> {
    // Fire-and-forget semantics from the client's POV: we await so failures are
    // logged, but the response is identical regardless of the outcome — EXCEPT
    // the resend cooldown (<60s for the same email), which is surfaced as a 429
    // with the remaining seconds so the SPA can show a countdown. That branch
    // reveals nothing about account existence, only request recency.
    const result = await this.magic.requestMagicLink(
      dto.email,
      this.clientIp(req),
    );
    if (result.reason === 'cooldown') {
      const retryAfterSeconds = result.retryAfterSeconds ?? 60;
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Please wait ${retryAfterSeconds}s before requesting another link.`,
          error: 'Too Many Requests',
          retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return { data: { message: GENERIC_MAGIC_ACK } };
  }

  @Public()
  @Post('magic/verify')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Verify a magic-link token → session JWT (public, no auth)',
    description:
      'Validates the one-time token (exists, unexpired, unused), marks it used, ' +
      'resolves or creates the user (a new email gets an owner team; the ' +
      'configured superadmin email becomes superadmin) and returns a session ' +
      'JWT (~12h) — the same token password login mints.',
  })
  @ApiOkResponse({ type: LoginResponseDto })
  async verify(
    @Body() dto: MagicVerifyDto,
    @Req() req: Request,
  ): Promise<LoginResponseDto> {
    const { token } = await this.magic.verify(
      dto.token,
      dto.code,
      sessionContextFromRequest(req),
    );
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
