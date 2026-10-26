/**
 * Unit — IngressBackupService (primary + backup / failover ingress pairing).
 *
 * The service owns a per-app `ingress_backup_links` table (lazily created in
 * apps/<name>/app.db, no shared migration). Invariants pinned here:
 *   1. lazy, idempotent bootstrap (link on a fresh app just works),
 *   2. a pairing is retrievable by EITHER side (primary id or backup id),
 *   3. getRoleInfo classifies an id as primary / backup / null with the correct
 *      `pairedIngressId` (the OTHER side),
 *   4. link() is idempotent on the primary (re-link replaces the backup),
 *   5. remove() drops the pairing whichever side is passed,
 *   6. rows are per-app isolated (a link in app A is invisible to app B).
 */
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { IngressBackupService } from './ingress-backup.service';

const APP = 'live';

describe('IngressBackupService', () => {
  let ctx: UnitContext;
  let svc: IngressBackupService;

  beforeEach(() => {
    ctx = makeUnitContext();
    svc = new IngressBackupService(ctx.db);
  });

  afterEach(() => ctx.cleanup());

  it('creates the table lazily and links a primary→backup pair (same room)', () => {
    svc.link(APP, {
      primaryIngressId: 'IN_primary',
      backupIngressId: 'IN_backup',
      room: 'live-demo',
    });

    const byPrimary = svc.getByPrimary(APP, 'IN_primary');
    const byBackup = svc.getByBackup(APP, 'IN_backup');

    // Both keys of a pair resolve to the SAME room (⇒ same playback URL).
    expect(byPrimary).toMatchObject({
      primaryIngressId: 'IN_primary',
      backupIngressId: 'IN_backup',
      room: 'live-demo',
    });
    expect(byBackup?.room).toBe('live-demo');
    expect(byPrimary?.room).toBe(byBackup?.room);
  });

  it('classifies each id with getRoleInfo (+ the paired id)', () => {
    svc.link(APP, {
      primaryIngressId: 'IN_p',
      backupIngressId: 'IN_b',
      room: 'live',
    });

    expect(svc.getRoleInfo(APP, 'IN_p')).toEqual({
      role: 'primary',
      pairedIngressId: 'IN_b',
      primaryIngressId: 'IN_p',
      backupIngressId: 'IN_b',
    });
    expect(svc.getRoleInfo(APP, 'IN_b')).toEqual({
      role: 'backup',
      pairedIngressId: 'IN_p',
      primaryIngressId: 'IN_p',
      backupIngressId: 'IN_b',
    });
    // An unpaired / unknown id is role null with no paired id.
    expect(svc.getRoleInfo(APP, 'IN_solo')).toEqual({
      role: null,
      pairedIngressId: null,
    });
  });

  it('getLinkFor resolves the pairing from either side', () => {
    svc.link(APP, {
      primaryIngressId: 'IN_p',
      backupIngressId: 'IN_b',
      room: 'live',
    });
    expect(svc.getLinkFor(APP, 'IN_p')?.backupIngressId).toBe('IN_b');
    expect(svc.getLinkFor(APP, 'IN_b')?.primaryIngressId).toBe('IN_p');
    expect(svc.getLinkFor(APP, 'nope')).toBeNull();
  });

  it('link() is idempotent on the primary (re-link swaps the backup)', () => {
    svc.link(APP, {
      primaryIngressId: 'IN_p',
      backupIngressId: 'IN_b1',
      room: 'live',
    });
    svc.link(APP, {
      primaryIngressId: 'IN_p',
      backupIngressId: 'IN_b2',
      room: 'live',
    });
    expect(svc.getByPrimary(APP, 'IN_p')?.backupIngressId).toBe('IN_b2');
    // The old backup id is no longer part of any pairing.
    expect(svc.getByBackup(APP, 'IN_b1')).toBeNull();
  });

  it('remove() drops the pairing whichever side is passed', () => {
    svc.link(APP, {
      primaryIngressId: 'IN_p',
      backupIngressId: 'IN_b',
      room: 'live',
    });
    svc.remove(APP, 'IN_b'); // remove by the BACKUP id
    expect(svc.getLinkFor(APP, 'IN_p')).toBeNull();
    expect(svc.getLinkFor(APP, 'IN_b')).toBeNull();
  });

  it('isolates pairings per app', () => {
    svc.link(APP, {
      primaryIngressId: 'IN_p',
      backupIngressId: 'IN_b',
      room: 'live',
    });
    expect(svc.getRoleInfo('other', 'IN_p').role).toBeNull();
    expect(svc.getByPrimary('other', 'IN_p')).toBeNull();
  });
});
