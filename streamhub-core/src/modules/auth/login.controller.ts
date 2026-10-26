import {
  Body,
  Controller,
  Get,
  HttpCode,
  Optional,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../shared/auth';
import { AuthContext, getAuthCtx } from '../../shared/auth-context';
import { AuditService, requestIp } from '../audit/audit.service';
import { NodeRoleService, type NodeRole } from '../cluster/node-role.service';
import { getAppVersion } from '../health/app-version';
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
  constructor(
    private readonly auth: AuthService,
    /** Security audit trail (ISO 8.15) — optional for bare-ctor unit specs. */
    @Optional() private readonly audit?: AuditService,
    /**
     * Cluster role (optional for bare-ctor unit specs) — drives the SPA's edge
     * screen. Undefined → treated as a `standalone` node (login enabled).
     */
    @Optional() private readonly nodeRole?: NodeRoleService,
  ) {}

  @Public()
  @Get('config')
  @ApiOperation({
    summary: 'Public auth capabilities (public, no auth)',
    description:
      'Tells the SPA which auth flows this deployment offers: `allowSignup` ' +
      '(STREAMHUB_PUBLIC_REGISTRATION, alias STREAMHUB_ALLOW_SIGNUP — public ' +
      'self-signup vs invite-only) and the cluster ROLE (`nodeRole`, ' +
      '`masterUrl`, `loginEnabled`) so the login page renders an "edge — ' +
      'manage at the master" screen instead of the form on a cluster edge. ' +
      'Also carries `appVersion` — the real product version (repo-root ' +
      'VERSION file) the dashboard footer displays. ' +
      'Safe to expose: reveals no accounts or secrets.',
  })
  @ApiOkResponse({
    description:
      '{ data: { allowSignup, nodeRole, masterUrl, loginEnabled, appVersion } }',
  })
  config(): {
    data: {
      allowSignup: boolean;
      nodeRole: NodeRole;
      masterUrl: string | null;
      loginEnabled: boolean;
      appVersion: string;
    };
  } {
    const nodeRole: NodeRole = this.nodeRole?.getRole() ?? 'standalone';
    const masterUrl = this.nodeRole?.getMasterUrl() ?? null;
    // Login is offered everywhere except a cluster edge (managed at the master).
    const loginEnabled = nodeRole !== 'edge';
    return {
      data: {
        allowSignup: this.auth.allowSignup,
        nodeRole,
        masterUrl,
        loginEnabled,
        appVersion: getAppVersion(),
      },
    };
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
      'STREAMHUB_PUBLIC_REGISTRATION (alias STREAMHUB_ALLOW_SIGNUP): when OFF ' +
      'only an invited PENDING user may complete signup — a brand-new email ' +
      'gets 403 `signup_disabled`.',
  })
  @ApiOkResponse({ type: LoginResponseDto })
  async signup(
    @Body() dto: SignupDto,
    @Req() req: Request,
  ): Promise<LoginResponseDto> {
    try {
      const { token } = await this.auth.signup(
        {
          email: dto.email,
          password: dto.password,
          teamName: dto.teamName,
        },
        sessionContextFromRequest(req),
      );
      this.audit?.record({
        action: 'user.signup',
        actorType: 'user',
        actorId: dto.email,
        ip: requestIp(req),
        result: 'success',
      });
      return { data: { token } };
    } catch (err) {
      // Audit the failed signup attempt (identity only — NEVER the password),
      // then rethrow so the HTTP outcome is unchanged.
      this.audit?.record({
        action: 'user.signup',
        actorType: 'user',
        actorId: dto.email,
        ip: requestIp(req),
        result: 'failure',
        meta: { error: (err as Error).message },
      });
      throw err;
    }
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
    try {
      const { token } = await this.auth.login(
        dto.user,
        dto.password,
        dto.code,
        sessionContextFromRequest(req),
      );
      this.audit?.record({
        action: 'auth.login',
        actorType: 'user',
        actorId: dto.user,
        ip: requestIp(req),
        result: 'success',
      });
      return { data: { token } };
    } catch (err) {
      // Audit the failed attempt (submitted identity only — NEVER the
      // password/TOTP code), then rethrow so the HTTP outcome is unchanged.
      this.audit?.record({
        action: 'auth.login',
        actorType: 'user',
        actorId: dto.user,
        ip: requestIp(req),
        result: 'failure',
        meta: { error: (err as Error).message },
      });
      throw err;
    }
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
