import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from './public.decorator';

/** DI token for the auth module's concrete validator. */
export const AUTH_VALIDATOR = Symbol('AUTH_VALIDATOR');

/** Outcome of validating an incoming request's credentials. */
export interface AuthContext {
  tokenId: number;
  scope: 'global' | 'app';
  appId: number | null;
}

/**
 * Implemented by the auth module. The guard stays generic; the auth module
 * provides the real Bearer-token + IP-whitelist logic by binding this contract
 * to AUTH_VALIDATOR. STABLE CONTRACT.
 */
export interface AuthValidatorContract {
  /**
   * Validate a request. Resolve with the auth context on success, reject (throw)
   * on invalid/missing/forbidden credentials.
   */
  validate(req: Request): Promise<AuthContext>;
}

/**
 * Global guard (SPEC §5 auth, §6). Skeleton: routes/handlers marked @Public()
 * bypass auth. For everything else it delegates to the AUTH_VALIDATOR provided
 * by the auth module.
 *
 * Fase-0 M6 (fail-closed): if NO validator is bound the guard used to fail OPEN
 * (allow everything) so the bare skeleton could boot. That is only safe in
 * dev/test. In production a missing validator means auth is effectively disabled,
 * so we now fail CLOSED (401) for any non-@Public route. A boot-time assert in
 * main.ts additionally refuses to start the process in that state — so this
 * runtime branch is defence-in-depth.
 */
@Injectable()
export class StreamHubAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional()
    @Inject(AUTH_VALIDATOR)
    private readonly validator?: AuthValidatorContract,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // No validator bound. In production this is a misconfiguration (auth would be
    // disabled) → fail CLOSED. In dev/test the bare skeleton must still boot, so
    // allow (the auth module binds AUTH_VALIDATOR to enforce real token checks).
    if (!this.validator) {
      if (process.env.NODE_ENV === 'production') {
        throw new UnauthorizedException(
          'auth validator not configured (refusing to serve without auth)',
        );
      }
      return true;
    }

    const req = context.switchToHttp().getRequest<Request>();
    try {
      const ctx = await this.validator.validate(req);
      (req as Request & { auth?: AuthContext }).auth = ctx;
      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Invalid or missing API token');
    }
  }
}
