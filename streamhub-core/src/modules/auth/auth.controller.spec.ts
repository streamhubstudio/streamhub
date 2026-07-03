import { ForbiddenException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthContext } from '../../shared/auth-context';
import type { AuthService } from './auth.service';

/**
 * Fase-0 M2 guard on /tokens: minting/listing/revoking API tokens is a
 * global-only operation. Without it, an app-scoped principal could mint itself
 * a `scope:'global'` token (privilege escalation) or revoke another tenant's
 * tokens. These specs pin that behaviour and confirm global/superadmin keep
 * full access.
 */
const globalCtx: AuthContext = {
  userId: 'token:1',
  tenantId: 'platform',
  role: 'service',
  isSuperadmin: true,
  scope: 'global',
  via: 'api_token',
};

const adminCtx: AuthContext = {
  userId: 'admin',
  tenantId: 'platform',
  role: 'superadmin',
  isSuperadmin: true,
  scope: 'global',
  via: 'admin_jwt',
};

const appCtx: AuthContext = {
  userId: 'token:2',
  tenantId: 't_acme',
  role: 'owner',
  isSuperadmin: false,
  scope: 'app',
  via: 'api_token',
};

describe('AuthController — /tokens global-scope guard (M2)', () => {
  let controller: AuthController;
  let auth: jest.Mocked<Pick<AuthService, 'listTokens' | 'createToken' | 'revokeToken'>>;

  beforeEach(() => {
    auth = {
      listTokens: jest.fn().mockResolvedValue([]),
      createToken: jest.fn().mockResolvedValue({ id: 9, token: 'sk_new' }),
      revokeToken: jest.fn().mockResolvedValue(undefined),
    };
    controller = new AuthController(auth as unknown as AuthService);
  });

  const createDto = { name: 't', scope: 'global' as const, appId: null };

  describe('global / superadmin credentials pass', () => {
    it('global sk_ can list, create and revoke', async () => {
      await expect(controller.list(globalCtx)).resolves.toEqual([]);
      await expect(controller.create(createDto, globalCtx)).resolves.toEqual({
        id: 9,
        token: 'sk_new',
      });
      await expect(controller.revoke(5, globalCtx)).resolves.toBeUndefined();
      expect(auth.listTokens).toHaveBeenCalled();
      expect(auth.createToken).toHaveBeenCalled();
      expect(auth.revokeToken).toHaveBeenCalledWith(5);
    });

    it('break-glass admin can manage tokens', async () => {
      await expect(controller.list(adminCtx)).resolves.toEqual([]);
      await expect(controller.create(createDto, adminCtx)).resolves.toBeDefined();
    });

    it('dev fallback: no auth context is allowed (mirrors cluster/db-admin)', async () => {
      await expect(controller.list(undefined)).resolves.toEqual([]);
    });
  });

  describe('app-scoped principals are rejected (escalation closed)', () => {
    it('app token cannot list tokens', () => {
      expect(() => controller.list(appCtx)).toThrow(ForbiddenException);
      expect(auth.listTokens).not.toHaveBeenCalled();
    });

    it('app token cannot mint a global token', () => {
      expect(() => controller.create(createDto, appCtx)).toThrow(
        ForbiddenException,
      );
      expect(auth.createToken).not.toHaveBeenCalled();
    });

    it('app token cannot revoke another token', () => {
      expect(() => controller.revoke(1, appCtx)).toThrow(ForbiddenException);
      expect(auth.revokeToken).not.toHaveBeenCalled();
    });
  });
});
