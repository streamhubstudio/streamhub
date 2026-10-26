/**
 * Unit — system/SystemController GET /system/settings global-scope gate.
 *
 * The controller is thin: it delegates to SettingsService and enforces the
 * SAME global-scope rule as cluster/db-admin (`requireGlobal`). We assert the
 * gate here (403 app-scoped, allow global/superadmin, no-op in dev) with a
 * stubbed service; the 401-anonymous case rides on the global Bearer guard and
 * is covered end-to-end in test/system-settings.e2e-spec.ts.
 */
import { ForbiddenException } from '@nestjs/common';
import { SystemController } from './system.controller';
import type { GpuService } from './gpu.service';
import type { SettingsService } from './settings.service';
import type { ServerSettings } from './settings.types';
import type { OsTuningService } from './os-tuning.service';
import type { OsTuningReport } from './os-tuning.types';
import type { AuthContext } from '../../shared/auth-context';

const SENTINEL = { core: { port: 3020 } } as unknown as ServerSettings;
const TUNING_SENTINEL = { supported: false } as unknown as OsTuningReport;

function makeController() {
  const gpu = {} as unknown as GpuService;
  const settings = {
    getSettings: jest.fn().mockReturnValue(SENTINEL),
  } as unknown as SettingsService;
  const osTuning = {
    report: jest.fn().mockReturnValue(TUNING_SENTINEL),
  } as unknown as OsTuningService;
  return { ctrl: new SystemController(gpu, settings, osTuning), settings, osTuning };
}

describe('system/SystemController — GET /system/settings', () => {
  it('returns the enveloped settings for a global-scope credential', () => {
    const { ctrl, settings } = makeController();
    const ctx = { scope: 'global', isSuperadmin: false } as AuthContext;
    const res = ctrl.getSettings(ctx);
    expect(res).toEqual({ data: SENTINEL, error: null });
    expect(settings.getSettings).toHaveBeenCalledTimes(1);
  });

  it('allows a superadmin regardless of scope', () => {
    const { ctrl } = makeController();
    const ctx = { scope: 'app', isSuperadmin: true } as AuthContext;
    expect(() => ctrl.getSettings(ctx)).not.toThrow();
  });

  it('rejects an app-scoped, non-superadmin credential (403)', () => {
    const { ctrl, settings } = makeController();
    const ctx = { scope: 'app', isSuperadmin: false } as AuthContext;
    expect(() => ctrl.getSettings(ctx)).toThrow(ForbiddenException);
    expect(settings.getSettings).not.toHaveBeenCalled();
  });

  it('allows when no auth is bound (dev/skeleton)', () => {
    const { ctrl } = makeController();
    expect(() => ctrl.getSettings(undefined)).not.toThrow();
  });
});

describe('system/SystemController — GET /system/os-tuning', () => {
  it('returns the enveloped OS-tuning report for a global-scope credential', () => {
    const { ctrl, osTuning } = makeController();
    const ctx = { scope: 'global', isSuperadmin: false } as AuthContext;
    const res = ctrl.getOsTuning(ctx);
    expect(res).toEqual({ data: TUNING_SENTINEL, error: null });
    expect(osTuning.report).toHaveBeenCalledTimes(1);
  });

  it('allows a superadmin regardless of scope', () => {
    const { ctrl } = makeController();
    const ctx = { scope: 'app', isSuperadmin: true } as AuthContext;
    expect(() => ctrl.getOsTuning(ctx)).not.toThrow();
  });

  it('rejects an app-scoped, non-superadmin credential (403)', () => {
    const { ctrl, osTuning } = makeController();
    const ctx = { scope: 'app', isSuperadmin: false } as AuthContext;
    expect(() => ctrl.getOsTuning(ctx)).toThrow(ForbiddenException);
    expect(osTuning.report).not.toHaveBeenCalled();
  });

  it('allows when no auth is bound (dev/skeleton)', () => {
    const { ctrl } = makeController();
    expect(() => ctrl.getOsTuning(undefined)).not.toThrow();
  });
});
