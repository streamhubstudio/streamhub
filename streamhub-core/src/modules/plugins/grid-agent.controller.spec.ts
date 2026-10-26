/**
 * Unit — plugins/GridAgentController + GridAgentService (StreamHub Grid agent,
 * the NODE side of GRID-1/2). Locks down:
 *   - the MANUAL X-Cluster-Token gate (503 unset / 401 wrong / 401 absent) —
 *     shared with cluster join/heartbeat via cluster-token.util;
 *   - a valid token spawns the resolved spec through the SAME PluginWorkerManager
 *     lifecycle (child_process mocked) and returns { id, status };
 *   - status/stop are proxied by the opaque worker id; an unknown id 404s;
 *   - the ingest token is mirrored into the child env so the origin accepts the
 *     worker's result pushes.
 */
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import {
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { makeUnitContext, mockLogsService, type UnitContext } from '../../../test/helpers';
import { PluginWorkerManager } from './plugin-worker.manager';
import { GridAgentService } from './grid-agent.service';
import { GridAgentController } from './grid-agent.controller';
import { GridWorkerDto } from './dto/grid-worker.dto';

jest.mock('child_process', () => ({ spawn: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeChild(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cp: any = new EventEmitter();
  cp.pid = 4242;
  cp.stdout = new EventEmitter();
  cp.stderr = new EventEmitter();
  cp.kill = jest.fn(() => {
    cp.emit('exit', 0, 'SIGTERM');
    return true;
  });
  return cp;
}

const TOKEN = 'cluster-secret';

function reqWithToken(token?: string): Request {
  return {
    header: (name: string) =>
      name.toLowerCase() === 'x-cluster-token' ? token : undefined,
  } as unknown as Request;
}

function dto(over: Partial<GridWorkerDto> = {}): GridWorkerDto {
  return {
    pluginId: over.pluginId ?? 'yolo',
    appName: over.appName ?? 'live',
    command: over.command ?? 'python3',
    args: over.args ?? ['-m', 'yolo_worker'],
    env: over.env ?? { YOLO_APP: 'live' },
    ingestToken: over.ingestToken ?? 'tok-abc',
  };
}

function make(token: string): {
  ctx: UnitContext;
  controller: GridAgentController;
  manager: PluginWorkerManager;
} {
  const ctx = makeUnitContext({ STREAMHUB_CLUSTER_TOKEN: token });
  const manager = new PluginWorkerManager(ctx.config, mockLogsService());
  const service = new GridAgentService(manager);
  const controller = new GridAgentController(ctx.config, service);
  return { ctx, controller, manager };
}

describe('plugins/GridAgentController', () => {
  let ctx: UnitContext;
  let controller: GridAgentController;
  let manager: PluginWorkerManager;
  let child: ReturnType<typeof fakeChild>;

  beforeEach(() => {
    child = fakeChild();
    (spawn as jest.Mock).mockReturnValue(child);
  });
  afterEach(() => {
    manager?.onModuleDestroy();
    ctx?.cleanup();
    (spawn as jest.Mock).mockReset();
  });

  describe('X-Cluster-Token gate', () => {
    it('503 when STREAMHUB_CLUSTER_TOKEN is unset', () => {
      ({ ctx, controller, manager } = make(''));
      expect(() => controller.createWorker(dto(), reqWithToken(TOKEN))).toThrow(
        ServiceUnavailableException,
      );
      expect(spawn).not.toHaveBeenCalled();
    });

    it('401 when the token is wrong', () => {
      ({ ctx, controller, manager } = make(TOKEN));
      expect(() =>
        controller.createWorker(dto(), reqWithToken('nope')),
      ).toThrow(UnauthorizedException);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('401 when the token header is absent', () => {
      ({ ctx, controller, manager } = make(TOKEN));
      expect(() =>
        controller.createWorker(dto(), reqWithToken(undefined)),
      ).toThrow(UnauthorizedException);
    });

    it('gates status + stop the same way', () => {
      ({ ctx, controller, manager } = make(TOKEN));
      expect(() => controller.status('x', reqWithToken('bad'))).toThrow(
        UnauthorizedException,
      );
      expect(() => controller.stop('x', reqWithToken('bad'))).toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('worker lifecycle (valid token)', () => {
    it('spawns the resolved spec and returns { id, status }', () => {
      ({ ctx, controller, manager } = make(TOKEN));
      const out = controller.createWorker(dto(), reqWithToken(TOKEN));
      expect(out.error).toBeNull();
      expect(out.data.id).toBeTruthy();
      expect(out.data.status).toBe('running');
      expect(out.data.pluginId).toBe('yolo');
      expect(spawn).toHaveBeenCalledWith(
        'python3',
        ['-m', 'yolo_worker'],
        expect.objectContaining({
          env: expect.objectContaining({
            YOLO_APP: 'live',
            // the ingest token is mirrored into the child env:
            STREAMHUB_INGEST_TOKEN: 'tok-abc',
          }),
        }),
      );
    });

    it('status by id reflects the running worker; unknown id 404s', () => {
      ({ ctx, controller, manager } = make(TOKEN));
      const id = controller.createWorker(dto(), reqWithToken(TOKEN)).data.id;
      const st = controller.status(id, reqWithToken(TOKEN));
      expect(st.data.status).toBe('running');
      expect(() => controller.status('nope', reqWithToken(TOKEN))).toThrow(
        NotFoundException,
      );
    });

    it('stop by id terminates the worker', () => {
      ({ ctx, controller, manager } = make(TOKEN));
      const id = controller.createWorker(dto(), reqWithToken(TOKEN)).data.id;
      const st = controller.stop(id, reqWithToken(TOKEN));
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(st.data.status).toBe('stopped');
      expect(() => controller.stop('nope', reqWithToken(TOKEN))).toThrow(
        NotFoundException,
      );
    });
  });
});
