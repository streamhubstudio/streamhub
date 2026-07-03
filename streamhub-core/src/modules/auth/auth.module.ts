import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AUTH_VALIDATOR, StreamHubAuthGuard } from '../../shared/auth';
import { EmailModule } from '../email/email.module';
import { AccountController } from './account.controller';
import { AuthController } from './auth.controller';
import { LoginController } from './login.controller';
import { MagicController } from './magic.controller';
import { SessionController } from './session.controller';
import { TeamsController } from './teams.controller';
import { TenantInvitesController } from './tenant-invites.controller';
import { AccountService } from './account.service';
import { AuthService } from './auth.service';
import { MagicLinkService } from './magic-link.service';
import { SessionService } from './session.service';
import { TotpService } from './totp.service';

/**
 * Auth module (SPEC §5 auth). Registers StreamHubAuthGuard GLOBALLY (APP_GUARD)
 * so every route is guarded, and binds AUTH_VALIDATOR → AuthService so the guard
 * enforces real Bearer-token + IP-whitelist checks. Routes marked `@Public()`
 * (e.g. /health, /auth/login, /auth/signup, /auth/magic-link, /auth/magic/verify)
 * and the public path prefixes in AuthService bypass auth.
 *
 * Identity is built-in — two credentials mint the SAME session JWT:
 *   - password (scrypt): POST /auth/login (break-glass ADMIN_USER/ADMIN_PASS,
 *     plus any account that set a password via signup),
 *   - passwordless magic-link (Wave-7): POST /auth/magic-link → /auth/magic/verify
 *     (MagicLinkService + EmailModule for SMTP delivery) — the default flow.
 * There is no password-recovery flow: a user who forgets their password just
 * signs in with a magic link. Every human JWT mints a row in SessionService
 * (active sessions, revocable from "Mi cuenta"); its id rides in the token as
 * `sid` and the validator rejects a token whose session is revoked.
 * StreamHub is the identity-of-record; OIDC/Logto was removed. TenancyService
 * (global) owns the users/teams/memberships tables this module reads and writes.
 */
@Module({
  imports: [EmailModule],
  controllers: [
    AuthController,
    LoginController,
    MagicController,
    SessionController,
    TeamsController,
    TenantInvitesController,
    AccountController,
  ],
  providers: [
    AuthService,
    MagicLinkService,
    SessionService,
    TotpService,
    AccountService,
    { provide: APP_GUARD, useClass: StreamHubAuthGuard },
    { provide: AUTH_VALIDATOR, useExisting: AuthService },
  ],
  exports: [AuthService],
})
export class AuthModule {}
