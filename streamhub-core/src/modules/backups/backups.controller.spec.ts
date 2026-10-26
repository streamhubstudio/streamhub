/**
 * Unit — backups/BackupsController (the /system/backups admin surface).
 *
 * Invariants locked down:
 *  - EVERY endpoint is GLOBAL-scope only: an app-scoped, non-superadmin
 *    principal gets 403 on list, run AND restore (same requireGlobal gate as
 *    /cluster + /system + /security); superadmin, a global token and the dev
 *    path (no ctx bound) pass,
 *  - POST /system/backups triggers a run whose snapshots then appear in GET,
 *  - restore REQUIRES confirm:true (400 otherwise — nothing touched),
 *  - restore round-trips through the service (integrity + safety copy).
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import type { AuthContext } from '../../shared/auth-context';
import { BackupsController } from './backups.controller';
import { BackupsService } from './backups.service';
import { RestoreBackupDto } from './dto/restore-backup.dto';

const superadminCtx: AuthContext = {
  userId: 'admin',
  tenantId: 'platform',
  role: 'superadmin',
  isSuperadmin: true,
  scope: 'global',
  via: 'admin_jwt',
};

const globalTokenCtx: AuthContext = {
  userId: 'token:1',
  tenantId: 'platform',
  role: 'service',
  isSuperadmin: true,
  scope: 'global',
  via: 'api_token',
};

/** An app-scoped, non-superadmin principal — must be rejected everywhere. */
const appCtx: AuthContext = {
  userId: 'token:2',
  tenantId: 't1',
  role: 'service',
  isSuperadmin: false,
  scope: 'app',
  via: 'api_token',
};

function dto(partial: Partial<RestoreBackupDto>): RestoreBackupDto {
  return Object.assign(new RestoreBackupDto(), partial);
}

describe('backups/BackupsController', () => {
  let ctx: UnitContext;
  let service: BackupsService;
  let controller: BackupsController;

  beforeEach(() => {
    ctx = makeUnitContext();
    ctx.db.global().prepare('INSERT INTO apps (name) VALUES (?)').run('live');
    ctx.db.appDb('live');
    service = ctx.newService(BackupsService, ctx.config, ctx.db, ctx.mocks.logs);
    controller = ctx.newService(BackupsController, service);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  describe('authz — global scope only (RBAC gate)', () => {
    it('rejects an app-scoped principal on EVERY endpoint (403)', async () => {
      expect(() => controller.list(appCtx)).toThrow(ForbiddenException);
      await expect(controller.run(appCtx)).rejects.toThrow(ForbiddenException);
      await expect(
        controller.restore(
          dto({ db: 'app-live', snapshot: 'x.db.gz', confirm: true }),
          appCtx,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows superadmin, a global token, and the dev path (no ctx)', async () => {
      expect(() => controller.list(superadminCtx)).not.toThrow();
      expect(() => controller.list(globalTokenCtx)).not.toThrow();
      expect(() => controller.list(undefined)).not.toThrow();
      await expect(controller.run(superadminCtx)).resolves.toBeDefined();
    });
  });

  it('POST runs a backup of every db; GET lists the snapshots with settings', async () => {
    const run = await controller.run(superadminCtx);
    expect(run.error).toBeNull();
    expect(run.data.snapshots.map((s) => s.db).sort()).toEqual([
      'app-live',
      'streamhub',
    ]);

    const list = controller.list(superadminCtx);
    expect(list.data.retentionDays).toBe(7);
    expect(list.data.enabled).toBe(true);
    const dbs = Object.fromEntries(
      list.data.databases.map((d) => [d.db, d.snapshots.length]),
    );
    expect(dbs).toEqual({ streamhub: 1, 'app-live': 1 });
  });

  describe('restore', () => {
    it('REQUIRES confirm:true — 400 and nothing touched otherwise', async () => {
      const run = await controller.run(superadminCtx);
      const snap = run.data.snapshots.find((s) => s.db === 'app-live')!;
      await expect(
        controller.restore(
          dto({ db: 'app-live', snapshot: snap.file, confirm: false }),
          superadminCtx,
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        controller.restore(
          dto({ db: 'app-live', snapshot: snap.file } as RestoreBackupDto),
          superadminCtx,
        ),
      ).rejects.toThrow(BadRequestException);
      // No pre-restore safety copy — the destructive path never started.
      expect(
        service.listSnapshots('app-live').filter((s) => s.preRestore),
      ).toHaveLength(0);
    });

    it('with confirm:true restores and reports the safety snapshot', async () => {
      const run = await controller.run(superadminCtx);
      const snap = run.data.snapshots.find((s) => s.db === 'app-live')!;
      const res = await controller.restore(
        dto({ db: 'app-live', snapshot: snap.file, confirm: true }),
        superadminCtx,
      );
      expect(res.data.restored).toBe(true);
      expect(res.data.integrity).toBe('ok');
      expect(res.data.restartRecommended).toBe(false);
      expect(
        service
          .listSnapshots('app-live')
          .some((s) => s.file === res.data.preRestoreSnapshot),
      ).toBe(true);
    });

    it('flags restartRecommended when the GLOBAL registry is restored', async () => {
      const run = await controller.run(superadminCtx);
      const snap = run.data.snapshots.find((s) => s.db === 'streamhub')!;
      const res = await controller.restore(
        dto({ db: 'streamhub', snapshot: snap.file, confirm: true }),
        superadminCtx,
      );
      expect(res.data.restartRecommended).toBe(true);
    });
  });
});
