import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import * as QRCode from 'qrcode';
import { AuthContext } from '../../shared/auth-context';
import { ConfigService } from '../../shared/config/config.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { hashPassword, verifyPassword } from './password.util';
import { TotpService } from './totp.service';

/** GET /account — the signed-in user's own profile + tenant context. */
export interface AccountInfo {
  user: {
    id: string;
    email: string | null;
    name: string | null;
    isSuperadmin: boolean;
    /** True when a password is set (magic-link-born accounts use reset to set one). */
    hasPassword: boolean;
    twoFactorEnabled: boolean;
    status: string;
    createdAt: string;
  };
  tenant: {
    id: string;
    name: string;
    plan: string;
    role: string;
  } | null;
}

/** Result of POST /account/2fa/setup (QR rendered server-side as data URI). */
export interface TwoFaSetupResult {
  secret: string;
  otpauthUri: string;
  /** PNG data URI of the otpauth QR — feed straight into an <img src>. */
  qrDataUri: string;
}

/**
 * "Mi cuenta" — self-service surface for the signed-in HUMAN principal
 * (user_jwt / admin_jwt; api_tokens are machines and get 403 at the
 * controller). Reads/writes the same users table TenancyService owns.
 *
 * Break-glass safety: the mirrored `admin` principal's email comes from
 * ADMIN_USER (env) and its password from ADMIN_PASS (env), so this service
 * refuses to change either for the admin row — the env stays authoritative and
 * the platform owner can never lock themselves out via the UI.
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  private static readonly MIN_PASSWORD_LEN = 8;

  constructor(
    private readonly config: ConfigService,
    private readonly tenancy: TenancyService,
    private readonly totp: TotpService,
  ) {}

  /** Resolve the caller's own account (user row + tenant + role). */
  getAccount(ctx: AuthContext): AccountInfo {
    const user = this.requireUser(ctx);
    const tenant = ctx.tenantId ? this.tenancy.getTenant(ctx.tenantId) : null;
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name ?? null,
        isSuperadmin: !!user.is_superadmin || ctx.isSuperadmin,
        hasPassword: !!user.password_hash,
        twoFactorEnabled: this.totp.isEnabled(user.id),
        status: user.status ?? 'active',
        createdAt: user.created_at,
      },
      tenant: tenant
        ? { id: tenant.id, name: tenant.name, plan: tenant.plan, role: ctx.role }
        : null,
    };
  }

  /** PATCH /account — update display name and/or email. */
  updateAccount(
    ctx: AuthContext,
    patch: { name?: string; email?: string },
  ): AccountInfo {
    const user = this.requireUser(ctx);

    const update: { name?: string | null; email?: string } = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      update.name = name.length > 0 ? name : null;
    }
    if (patch.email !== undefined) {
      const email = patch.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
        throw new BadRequestException('invalid email');
      }
      if (user.id === TenancyService.ADMIN_USER_ID) {
        // Mirrored from ADMIN_USER (env) on every boot — a UI change would be
        // silently reverted and could desync the break-glass login.
        throw new BadRequestException(
          'the break-glass admin email is managed via ADMIN_USER (env)',
        );
      }
      if (email !== (user.email ?? '').toLowerCase()) {
        const taken = this.tenancy.getUserByEmail(email);
        if (taken && taken.id !== user.id) {
          throw new BadRequestException('email already in use');
        }
        const adminUser = this.config.adminUser;
        if (adminUser && email === adminUser.trim().toLowerCase()) {
          throw new BadRequestException('email already in use');
        }
        update.email = email;
      }
    }

    this.tenancy.updateProfile(user.id, update);
    this.logger.log(`account updated for user ${user.id}`);
    return this.getAccount(ctx);
  }

  /**
   * POST /account/password — change the password. Requires the CURRENT
   * password (accounts born from a magic link hold a random hash nobody knows;
   * they set their first known password through the emailed reset flow).
   */
  changePassword(
    ctx: AuthContext,
    currentPassword: string,
    newPassword: string,
  ): void {
    const user = this.requireUser(ctx);
    if (user.id === TenancyService.ADMIN_USER_ID) {
      throw new BadRequestException(
        'the break-glass admin password is managed via ADMIN_PASS (env)',
      );
    }
    if (
      !newPassword ||
      newPassword.length < AccountService.MIN_PASSWORD_LEN
    ) {
      throw new BadRequestException(
        `password must be at least ${AccountService.MIN_PASSWORD_LEN} characters`,
      );
    }
    if (!user.password_hash) {
      throw new BadRequestException(
        'no password set — use the password reset flow to set one',
      );
    }
    if (!verifyPassword(currentPassword || '', user.password_hash)) {
      throw new ForbiddenException('current password is incorrect');
    }
    this.tenancy.setPassword(user.id, hashPassword(newPassword));
    this.logger.log(`password changed for user ${user.id}`);
  }

  // ---------------------------------------------------------------------------
  // 2FA (TOTP)
  // ---------------------------------------------------------------------------

  /** Start enrolment: secret + otpauth URI + server-rendered QR data URI. */
  async setupTwoFa(ctx: AuthContext): Promise<TwoFaSetupResult> {
    const user = this.requireUser(ctx);
    const label = user.email ?? user.id;
    const { secret, otpauthUri } = this.totp.setup(user.id, label);
    const qrDataUri = await QRCode.toDataURL(otpauthUri, {
      margin: 1,
      width: 220,
    });
    return { secret, otpauthUri, qrDataUri };
  }

  enableTwoFa(ctx: AuthContext, code: string): void {
    const user = this.requireUser(ctx);
    this.totp.enable(user.id, code);
  }

  disableTwoFa(ctx: AuthContext, code: string): void {
    const user = this.requireUser(ctx);
    this.totp.disable(user.id, code);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** The caller must be a human (user/admin JWT) with an existing user row. */
  private requireUser(ctx: AuthContext) {
    if (ctx.via === 'api_token') {
      throw new ForbiddenException('API tokens have no account');
    }
    const user = this.tenancy.getUser(ctx.userId);
    if (!user) {
      throw new BadRequestException('account not found');
    }
    return user;
  }
}
