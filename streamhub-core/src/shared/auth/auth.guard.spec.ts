/**
 * Unit — shared/auth/StreamHubAuthGuard (Fase-0 M6 fail-closed).
 *
 * With NO validator bound the guard must fail OPEN in dev/test (so the bare
 * skeleton boots and the 682-test harness runs) but fail CLOSED (401) in
 * production for any non-@Public route. @Public routes stay open in every env.
 */
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';

import { AuthValidatorContract, StreamHubAuthGuard } from './auth.guard';

/** Fake Reflector that reports whether the handler is @Public(). */
function reflector(isPublic: boolean): { getAllAndOverride: () => boolean } {
  return { getAllAndOverride: () => isPublic };
}

function execCtx(req: Record<string, unknown> = { headers: {} }): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => (): void => undefined,
    getClass: () => class Dummy {},
  } as unknown as ExecutionContext;
}

function guard(
  isPublic: boolean,
  validator?: AuthValidatorContract,
): StreamHubAuthGuard {
  return new StreamHubAuthGuard(
    reflector(isPublic) as never,
    validator,
  );
}

describe('shared/auth/StreamHubAuthGuard (M6 fail-closed)', () => {
  const prev = process.env.NODE_ENV;
  afterEach(() => {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  });

  it('no validator + non-production → ALLOWS (skeleton/test boots)', async () => {
    process.env.NODE_ENV = 'test';
    await expect(guard(false).canActivate(execCtx())).resolves.toBe(true);
  });

  it('no validator + production → FAILS CLOSED (401) on a protected route', async () => {
    process.env.NODE_ENV = 'production';
    await expect(guard(false).canActivate(execCtx())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('no validator + production → @Public route still ALLOWED', async () => {
    process.env.NODE_ENV = 'production';
    await expect(guard(true).canActivate(execCtx())).resolves.toBe(true);
  });

  it('validator present + production → delegates and passes on success', async () => {
    process.env.NODE_ENV = 'production';
    const validator: AuthValidatorContract = {
      validate: async () => ({ tokenId: 1, scope: 'global', appId: null }),
    };
    const req: Record<string, unknown> = { headers: {} };
    await expect(guard(false, validator).canActivate(execCtx(req))).resolves.toBe(
      true,
    );
    expect(req.auth).toEqual({ tokenId: 1, scope: 'global', appId: null });
  });

  it('validator present + production → rejects on invalid credentials (401)', async () => {
    process.env.NODE_ENV = 'production';
    const validator: AuthValidatorContract = {
      validate: async () => {
        throw new Error('bad token');
      },
    };
    await expect(
      guard(false, validator).canActivate(execCtx()),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
