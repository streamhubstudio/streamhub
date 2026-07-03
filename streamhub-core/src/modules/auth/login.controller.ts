import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../shared/auth';
import { AuthContext, getAuthCtx } from '../../shared/auth-context';
import { AuthService } from './auth.service';
import { sessionContextFromRequest } from './session.service';
import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login-response.dto';
import { SignupDto } from './dto/signup.dto';

/**
 * Built-in auth (SPEC §5 auth). Public endpoints: signup (user + team) and login
 * (built-in user OR break-glass admin). Both return a short-lived JWT the SPA
 * stores and sends back as `Authorization: Bearer <jwt>`.
 */
@ApiTags('auth')
@Controller('auth')
export class LoginController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Get('config')
  @ApiOperation({
    summary: 'Public auth capabilities (public, no auth)',
    description:
      'Tells the SPA which auth flows this deployment offers. Currently: ' +
      '`allowSignup` (STREAMHUB_ALLOW_SIGNUP env flag — public self-signup vs ' +
      'invite-only). Safe to expose: it reveals no accounts or secrets.',
  })
  @ApiOkResponse({
    description: '{ data: { allowSignup: boolean } }',
  })
  config(): { data: { allowSignup: boolean } } {
    return { data: { allowSignup: this.auth.allowSignup } };
  }

  @Public()
  @Post('signup')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Sign up: create a user + team (public, no auth)',
    description:
      'Creates a built-in user (scrypt-hashed password), a new team (tenant) ' +
      'on the free plan and an owner membership, then returns a JWT ' +
      '(sub=user id, ~12h) signed with STREAMHUB_JWT_SECRET. Gated by ' +
      'STREAMHUB_ALLOW_SIGNUP: when OFF only an invited PENDING user may ' +
      'complete signup — a brand-new email gets 403 `signup_disabled`.',
  })
  @ApiOkResponse({ type: LoginResponseDto })
  async signup(
    @Body() dto: SignupDto,
    @Req() req: Request,
  ): Promise<LoginResponseDto> {
    const { token } = await this.auth.signup(
      {
        email: dto.email,
        password: dto.password,
        teamName: dto.teamName,
      },
      sessionContextFromRequest(req),
    );
    return { data: { token } };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Log in with user/password (public, no auth)',
    description:
      'Accepts a built-in user (email + password) OR the break-glass admin ' +
      '(ADMIN_USER/ADMIN_PASS superadmin) and returns a JWT (~12h) signed ' +
      'with STREAMHUB_JWT_SECRET. Accounts with 2FA enabled must also send ' +
      'a TOTP `code` (401 `totp_required` otherwise).',
  })
  @ApiOkResponse({ type: LoginResponseDto })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
  ): Promise<LoginResponseDto> {
    const { token } = await this.auth.login(
      dto.user,
      dto.password,
      dto.code,
      sessionContextFromRequest(req),
    );
    return { data: { token } };
  }

  /**
   * Return the resolved multi-tenant AuthContext for the current credential
   * (Wave-5 §auth). Authenticated (the global guard must have populated
   * `req.authCtx`). Lets the SPA / other services introspect who they are and
   * which tenant/role/scope they act under — works for api_token, admin_jwt and
   * user_jwt alike.
   */
  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Resolved AuthContext for the current credential (Wave-5 §auth).',
  })
  @ApiOkResponse({
    description: '{ data: AuthContext } — userId, tenantId, role, scope, via, …',
  })
  me(@Req() req: Request): { data: AuthContext | null } {
    return { data: getAuthCtx(req) ?? null };
  }
}
