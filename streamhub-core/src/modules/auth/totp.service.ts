import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { authenticator } from 'otplib';
import { ConfigService } from '../../shared/config/config.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { decryptSecret, encryptSecret } from './secret-cipher.util';

/** Result of starting a 2FA enrolment (POST /account/2fa/setup). */
export interface TotpSetup {
  /** Base32 shared secret — shown ONCE for manual entry. */
  secret: string;
  /** otpauth:// URI the authenticator app consumes (QR payload). */
  otpauthUri: string;
}

/**
 * TOTP two-factor auth (RFC 6238 via otplib) per built-in user.
 *
 * Enrolment is a two-step handshake so a typo can never lock the user out:
 *   1. `setup()` mints a fresh base32 secret, stores it ENCRYPTED (AES-256-GCM
 *      keyed from STREAMHUB_JWT_SECRET — see secret-cipher.util) in
 *      `users.totp_pending_secret` and returns the otpauth:// URI for the QR.
 *   2. `enable(code)` verifies a live code against the PENDING secret and only
 *      then promotes it to `totp_secret` + flips `totp_enabled`.
 *
 * Login enforcement: `assertLoginCode()` is called by AuthService (password
 * login) and MagicLinkService (magic-link verify) AFTER the primary credential
 * checks out. When 2FA is on and no/invalid code was supplied it throws 401
 * with the stable machine-readable messages `totp_required` / `totp_invalid`
 * the SPA switches on. The env break-glass admin path (ADMIN_USER/ADMIN_PASS)
 * NEVER goes through this — the platform owner cannot be locked out.
 */
@Injectable()
export class TotpService {
  private readonly logger = new Logger(TotpService.name);

  /** Accept the neighbouring 30s window on each side (clock drift). */
  private readonly totp = authenticator.clone({ window: 1 });

  constructor(
    private readonly config: ConfigService,
    private readonly tenancy: TenancyService,
  ) {}

  /** Issuer shown in the authenticator app. */
  private static readonly ISSUER = 'StreamHub';

  /** True when the user has 2FA fully enabled. */
  isEnabled(userId: string): boolean {
    const s = this.tenancy.getTotpState(userId);
    return s.enabled && !!s.secret;
  }

  /**
   * Start (or restart) enrolment: mint a secret, persist it encrypted as
   * PENDING, and return the otpauth URI. Re-running setup before enable simply
   * replaces the pending secret. Refused while 2FA is already enabled
   * (disable first — prevents silently rotating the secret without a code).
   */
  setup(userId: string, accountLabel: string): TotpSetup {
    const master = this.requireMaster();
    if (this.isEnabled(userId)) {
      throw new BadRequestException(
        '2FA is already enabled — disable it first',
      );
    }
    const secret = this.totp.generateSecret();
    this.tenancy.setTotpPending(userId, encryptSecret(secret, master));
    const otpauthUri = this.totp.keyuri(
      accountLabel || userId,
      TotpService.ISSUER,
      secret,
    );
    this.logger.log(`2FA enrolment started for user ${userId}`);
    return { secret, otpauthUri };
  }

  /** Complete enrolment: verify `code` against the pending secret, activate. */
  enable(userId: string, code: string): void {
    const master = this.requireMaster();
    const state = this.tenancy.getTotpState(userId);
    if (this.isEnabled(userId)) {
      throw new BadRequestException('2FA is already enabled');
    }
    if (!state.pendingSecret) {
      throw new BadRequestException('no 2FA enrolment in progress — run setup');
    }
    const secret = decryptSecret(state.pendingSecret, master);
    if (!secret || !this.check(code, secret)) {
      throw new BadRequestException('invalid verification code');
    }
    this.tenancy.activateTotp(userId);
    this.logger.log(`2FA enabled for user ${userId}`);
  }

  /** Disable 2FA — requires a live valid code (proves device possession). */
  disable(userId: string, code: string): void {
    const master = this.requireMaster();
    const state = this.tenancy.getTotpState(userId);
    if (!state.enabled || !state.secret) {
      throw new BadRequestException('2FA is not enabled');
    }
    const secret = decryptSecret(state.secret, master);
    if (!secret || !this.check(code, secret)) {
      throw new BadRequestException('invalid verification code');
    }
    this.tenancy.clearTotp(userId);
    this.logger.log(`2FA disabled for user ${userId}`);
  }

  /** True when `code` is currently valid for the user's ACTIVE secret. */
  verify(userId: string, code: string): boolean {
    const master = this.config.jwtSecret;
    if (!master) return false;
    const state = this.tenancy.getTotpState(userId);
    if (!state.enabled || !state.secret) return false;
    const secret = decryptSecret(state.secret, master);
    return !!secret && this.check(code, secret);
  }

  /**
   * Login gate: no-op when the user has no 2FA. When enabled, a missing code
   * throws 401 `totp_required` (the SPA shows the code step) and a wrong code
   * throws 401 `totp_invalid`.
   */
  assertLoginCode(userId: string, code?: string): void {
    if (!this.isEnabled(userId)) return;
    const trimmed = (code || '').trim();
    if (!trimmed) {
      throw new UnauthorizedException('totp_required');
    }
    if (!this.verify(userId, trimmed)) {
      throw new UnauthorizedException('totp_invalid');
    }
  }

  private check(code: string, secret: string): boolean {
    const c = (code || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(c)) return false;
    try {
      return this.totp.check(c, secret);
    } catch {
      return false;
    }
  }

  private requireMaster(): string {
    const secret = this.config.jwtSecret;
    if (!secret) {
      // Without the deployment secret we can neither encrypt nor mint sessions.
      throw new BadRequestException(
        '2FA is not available: STREAMHUB_JWT_SECRET is not configured',
      );
    }
    return secret;
  }
}
