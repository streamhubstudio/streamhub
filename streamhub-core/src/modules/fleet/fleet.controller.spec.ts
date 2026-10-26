/**
 * Unit spec — FleetController. Verifies the envelope + the error mapping the
 * routes rely on: a bad command → 400 (FleetCommandError), an inactive fleet →
 * 409 (FleetInactiveError), a missing agentId → 400. The FleetService is a
 * jest fake so no broker/db is touched. (RBAC on the routes is exercised by the
 * global authz guard e2e; here we lock the controller's own contract.)
 */
import { BadRequestException, ConflictException } from '@nestjs/common';

import { FleetController } from './fleet.controller';
import { FleetCommandError } from './fleet.protocol';
import { FleetInactiveError } from './fleet.service';

function makeController(svc: Partial<Record<string, jest.Mock>>) {
  return new FleetController(svc as never);
}

describe('FleetController', () => {
  it('wraps agent data in the standard envelope', async () => {
    const getData = jest.fn(async () => ({ agents: [], generatedAt: 'now' }));
    const ctrl = makeController({ getData });
    await expect(ctrl.agents('live')).resolves.toEqual({
      data: { agents: [], generatedAt: 'now' },
      error: null,
    });
    expect(getData).toHaveBeenCalledWith('live');
  });

  it('passes the command through and envelopes the record', async () => {
    const sendCommand = jest.fn(async () => ({ id: 'c1', status: 'pending' }));
    const ctrl = makeController({ sendCommand });
    const res = await ctrl.command('live', {
      agentId: 'a1',
      command: 'ping',
      args: {},
    });
    expect(res).toEqual({ data: { id: 'c1', status: 'pending' }, error: null });
    expect(sendCommand).toHaveBeenCalledWith('live', 'a1', 'ping', {});
  });

  it('400s when agentId is missing', async () => {
    const ctrl = makeController({ sendCommand: jest.fn() });
    await expect(
      ctrl.command('live', { command: 'ping' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps FleetCommandError → 400', async () => {
    const sendCommand = jest.fn(async () => {
      throw new FleetCommandError('bad ota');
    });
    const ctrl = makeController({ sendCommand });
    await expect(
      ctrl.command('live', { agentId: 'a1', command: 'ota' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps FleetInactiveError → 409', async () => {
    const sendCommand = jest.fn(async () => {
      throw new FleetInactiveError('no broker');
    });
    const ctrl = makeController({ sendCommand });
    await expect(
      ctrl.command('live', { agentId: 'a1', command: 'ping' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
