/**
 * GRID AGENT (node side) — supervises a worker the ORIGIN offloaded to THIS
 * node (GRID-1/2). It reuses the SAME lifecycle machinery as local plugin
 * workers (`PluginWorkerManager`): `startSpec` spawns the resolved spec under
 * an opaque worker id, and status/stop/logs are proxied by that id. The agent
 * holds NO plugin catalog and NO app state — it just runs the { command, args,
 * env } the origin resolved and dispatched.
 *
 * Trust: the controller gates every call on the cluster token BEFORE reaching
 * this service. Inputs are still sanitized here (env coerced to string→string).
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PluginWorkerSpec } from './plugin.contract';
import {
  PluginWorkerManager,
  WorkerLogLine,
  WorkerState,
} from './plugin-worker.manager';
import { GridWorkerDto } from './dto/grid-worker.dto';

/** Serializable view of a grid-run worker returned to the origin. */
export interface GridWorkerView {
  id: string;
  pluginId: string;
  appName: string;
  status: string;
  pid?: number;
  startedAt?: string;
  stoppedAt?: string;
  exitCode?: number | null;
  error?: string;
}

@Injectable()
export class GridAgentService {
  constructor(private readonly workers: PluginWorkerManager) {}

  /** Spawn a dispatched worker; returns its opaque id + initial state. */
  spawn(dto: GridWorkerDto): GridWorkerView {
    const id = randomUUID();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(dto.env ?? {})) {
      if (typeof k === 'string' && typeof v === 'string') env[k] = v;
    }
    // Ensure the ingest token the origin will accept is present in the env even
    // if the origin passed it only as the top-level `ingestToken` field.
    if (dto.ingestToken && !env.STREAMHUB_INGEST_TOKEN) {
      env.STREAMHUB_INGEST_TOKEN = dto.ingestToken;
    }
    const spec: PluginWorkerSpec = {
      command: dto.command,
      args: dto.args ?? [],
      env,
    };
    const state = this.workers.startSpec(id, dto.appName, dto.pluginId, spec);
    return this.view(id, state);
  }

  /** Live status of a dispatched worker (404 if the id is unknown). */
  status(id: string): GridWorkerView {
    const state = this.workers.statusByKey(id);
    if (!state) throw new NotFoundException(`grid worker '${id}' not found`);
    return this.view(id, state);
  }

  /** Stop a dispatched worker (404 if the id is unknown). */
  stop(id: string): GridWorkerView {
    if (!this.workers.statusByKey(id)) {
      throw new NotFoundException(`grid worker '${id}' not found`);
    }
    return this.view(id, this.workers.stopByKey(id));
  }

  /** Recent buffered log lines of a dispatched worker. */
  logs(id: string, limit = 200): WorkerLogLine[] {
    if (!this.workers.statusByKey(id)) {
      throw new NotFoundException(`grid worker '${id}' not found`);
    }
    return this.workers.logsByKey(id, limit);
  }

  private view(id: string, state: WorkerState): GridWorkerView {
    return {
      id,
      pluginId: state.pluginId,
      appName: state.app,
      status: state.status,
      pid: state.pid,
      startedAt: state.startedAt,
      stoppedAt: state.stoppedAt,
      exitCode: state.exitCode,
      error: state.error,
    };
  }
}
