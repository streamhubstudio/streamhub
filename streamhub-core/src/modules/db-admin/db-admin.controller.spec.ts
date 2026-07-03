/**
 * Unit specs for DbAdminController (module db-health-maintenance).
 *
 * The controller is thin orchestration: it delegates health/optimize/purge to
 * DbMaintenanceService and reuses RecordingService.deleteVod for the VOD purge
 * cascade. Both collaborators are mocked here so we assert wiring, the
 * confirm-gate, the per-scope fan-out, cascade accumulation, and the
 * global-scope gate on the /system route — without touching a real DB.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { DbAdminController } from './db-admin.controller';
import type { DbMaintenanceService } from '../../shared/db/db-maintenance.service';
import type { RecordingService } from '../recording/recording.service';
import type { AuthContext } from '../../shared/auth-context';

const APP = 'live';

function makeController(over: {
  maintenance?: Partial<DbMaintenanceService>;
  recording?: Partial<RecordingService>;
} = {}) {
  const maintenance = {
    appHealth: jest.fn().mockReturnValue({ path: '/x/app.db' }),
    globalHealth: jest.fn().mockReturnValue({ path: '/x/streamhub.db' }),
    optimizeApp: jest.fn().mockReturnValue({ path: '/x/app.db', reclaimedBytes: 10 }),
    purgeAppStreams: jest.fn().mockReturnValue(3),
    purgeAppLogs: jest.fn().mockReturnValue(7),
    ...over.maintenance,
  } as unknown as DbMaintenanceService;

  const recording = {
    listVods: jest.fn().mockReturnValue({ data: [] }),
    deleteVod: jest.fn(),
    ...over.recording,
  } as unknown as RecordingService;

  return {
    ctrl: new DbAdminController(maintenance, recording),
    maintenance,
    recording,
  };
}

describe('DbAdminController', () => {
  describe('health / optimize passthrough', () => {
    it('appHealth delegates to maintenance.appHealth', () => {
      const { ctrl, maintenance } = makeController();
      expect(ctrl.appHealth(APP).data).toEqual({ path: '/x/app.db' });
      expect(maintenance.appHealth).toHaveBeenCalledWith(APP);
    });

    it('optimizeApp delegates to maintenance.optimizeApp', () => {
      const { ctrl, maintenance } = makeController();
      const res = ctrl.optimizeApp(APP);
      expect(res.data).toMatchObject({ reclaimedBytes: 10 });
      expect(maintenance.optimizeApp).toHaveBeenCalledWith(APP);
    });
  });

  describe('purge()', () => {
    it('rejects without confirm:true', async () => {
      const { ctrl } = makeController();
      await expect(
        ctrl.purge(APP, { scope: 'all', confirm: false }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("scope 'logs' purges only logs (no vods/streams touched)", async () => {
      const { ctrl, maintenance, recording } = makeController();
      const res = await ctrl.purge(APP, { scope: 'logs', confirm: true });
      expect(res.data).toMatchObject({
        scope: 'logs',
        logsDeleted: 7,
        vodsDeleted: 0,
        streamsDeleted: 0,
      });
      expect(maintenance.purgeAppLogs).toHaveBeenCalledWith(APP);
      expect(maintenance.purgeAppStreams).not.toHaveBeenCalled();
      expect(recording.listVods).not.toHaveBeenCalled();
    });

    it("scope 'vods' cascades each VOD via recording.deleteVod and accumulates counters", async () => {
      const vods = [{ id: 1 }, { id: 2 }, { id: 3 }];
      const listVods = jest
        .fn()
        .mockReturnValueOnce({ data: vods }) // first page
        .mockReturnValue({ data: [] }); // drained
      const deleteVod = jest
        .fn()
        .mockResolvedValueOnce({ deleted: true, s3Deleted: 2, localDeleted: true })
        .mockResolvedValueOnce({ deleted: true, s3Deleted: 1, localDeleted: false })
        .mockResolvedValueOnce({ deleted: true, s3Deleted: 0, localDeleted: true });
      const { ctrl, maintenance } = makeController({
        recording: { listVods, deleteVod } as Partial<RecordingService>,
      });

      const res = await ctrl.purge(APP, { scope: 'vods', confirm: true });
      expect(res.data).toMatchObject({
        scope: 'vods',
        vodsDeleted: 3,
        s3Deleted: 3, // 2 + 1 + 0
        localDeleted: 2, // true + false + true
        streamsDeleted: 0,
        logsDeleted: 0,
      });
      expect(deleteVod).toHaveBeenCalledTimes(3);
      expect(maintenance.purgeAppStreams).not.toHaveBeenCalled();
      expect(maintenance.purgeAppLogs).not.toHaveBeenCalled();
    });

    it("scope 'all' cascades vods + purges streams + logs", async () => {
      const listVods = jest
        .fn()
        .mockReturnValueOnce({ data: [{ id: 9 }] })
        .mockReturnValue({ data: [] });
      const deleteVod = jest
        .fn()
        .mockResolvedValue({ deleted: true, s3Deleted: 1, localDeleted: true });
      const { ctrl, maintenance } = makeController({
        recording: { listVods, deleteVod } as Partial<RecordingService>,
      });

      const res = await ctrl.purge(APP, { scope: 'all', confirm: true });
      expect(res.data).toEqual({
        scope: 'all',
        vodsDeleted: 1,
        streamsDeleted: 3,
        logsDeleted: 7,
        s3Deleted: 1,
        localDeleted: 1,
      });
      expect(maintenance.purgeAppStreams).toHaveBeenCalledWith(APP);
      expect(maintenance.purgeAppLogs).toHaveBeenCalledWith(APP);
    });

    it('keeps draining pages until listVods returns empty', async () => {
      const listVods = jest
        .fn()
        .mockReturnValueOnce({ data: [{ id: 1 }, { id: 2 }] })
        .mockReturnValueOnce({ data: [{ id: 3 }] })
        .mockReturnValue({ data: [] });
      const deleteVod = jest
        .fn()
        .mockResolvedValue({ deleted: true, s3Deleted: 0, localDeleted: false });
      const { ctrl } = makeController({
        recording: { listVods, deleteVod } as Partial<RecordingService>,
      });
      const res = await ctrl.purge(APP, { scope: 'vods', confirm: true });
      expect(res.data.vodsDeleted).toBe(3);
      expect(deleteVod).toHaveBeenCalledTimes(3);
    });
  });

  describe('systemHealth() global-scope gate', () => {
    it('allows a global-scope credential', () => {
      const { ctrl } = makeController();
      const ctx = { scope: 'global', isSuperadmin: false } as AuthContext;
      expect(ctrl.systemHealth(ctx).data).toEqual({ path: '/x/streamhub.db' });
    });

    it('allows a superadmin regardless of scope', () => {
      const { ctrl } = makeController();
      const ctx = { scope: 'app', isSuperadmin: true } as AuthContext;
      expect(() => ctrl.systemHealth(ctx)).not.toThrow();
    });

    it('rejects an app-scoped credential', () => {
      const { ctrl } = makeController();
      const ctx = { scope: 'app', isSuperadmin: false } as AuthContext;
      expect(() => ctrl.systemHealth(ctx)).toThrow(ForbiddenException);
    });

    it('allows when no auth is bound (dev/skeleton)', () => {
      const { ctrl } = makeController();
      expect(() => ctrl.systemHealth(undefined)).not.toThrow();
    });
  });
});
