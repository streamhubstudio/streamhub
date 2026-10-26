/**
 * Unit — metrics-history/MetricsHistoryController global-scope gate + params.
 *
 * The controller is thin: it enforces the SAME requireGlobal rule as
 * /system/settings and /system/backups, validates the `metric` param and
 * delegates to MetricsHistoryService. We assert the gate (403 app-scoped, allow
 * global/superadmin, no-op in dev) and the param plumbing with a stubbed service.
 */
import { ForbiddenException } from '@nestjs/common';
import { MetricsHistoryController } from './metrics-history.controller';
import type {
  MetricsHistoryResponse,
  MetricsHistoryService,
} from './metrics-history.service';
import type { AuthContext } from '../../shared/auth-context';

const SENTINEL = { range: '30d', series: {} } as unknown as MetricsHistoryResponse;

function makeController() {
  const history = {
    history: jest.fn().mockReturnValue(SENTINEL),
  } as unknown as MetricsHistoryService;
  return { ctrl: new MetricsHistoryController(history), history };
}

describe('metrics-history/MetricsHistoryController — GET /system/metrics/history', () => {
  it('returns the enveloped history for a global-scope credential', () => {
    const { ctrl, history } = makeController();
    const ctx = { scope: 'global', isSuperadmin: false } as AuthContext;
    const res = ctrl.get('30d', undefined, ctx);
    expect(res).toEqual({ data: SENTINEL, error: null });
    expect(history.history).toHaveBeenCalledWith('30d', undefined);
  });

  it('allows a superadmin regardless of scope', () => {
    const { ctrl } = makeController();
    const ctx = { scope: 'app', isSuperadmin: true } as AuthContext;
    expect(() => ctrl.get(undefined, undefined, ctx)).not.toThrow();
  });

  it('rejects an app-scoped, non-superadmin credential (403)', () => {
    const { ctrl, history } = makeController();
    const ctx = { scope: 'app', isSuperadmin: false } as AuthContext;
    expect(() => ctrl.get('30d', 'cpu', ctx)).toThrow(ForbiddenException);
    expect(history.history).not.toHaveBeenCalled();
  });

  it('allows when no auth is bound (dev/skeleton)', () => {
    const { ctrl } = makeController();
    expect(() => ctrl.get(undefined, undefined, undefined)).not.toThrow();
  });

  it('passes a valid metric through and defaults an unknown one to all series', () => {
    const { ctrl, history } = makeController();
    const ctx = { scope: 'global' } as AuthContext;
    ctrl.get('7d', 'net', ctx);
    expect(history.history).toHaveBeenLastCalledWith('7d', 'net');
    ctrl.get('7d', 'bogus', ctx);
    // Invalid metric collapses to undefined (every series).
    expect(history.history).toHaveBeenLastCalledWith('7d', undefined);
  });

  it('defaults a missing range to 30d', () => {
    const { ctrl, history } = makeController();
    const ctx = { scope: 'global' } as AuthContext;
    ctrl.get(undefined, undefined, ctx);
    expect(history.history).toHaveBeenLastCalledWith('30d', undefined);
  });
});
