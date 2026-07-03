/**
 * In-memory `bullmq` mock (harness). Mapped in via jest `moduleNameMapper` so
 * that importing RecordingService — which builds a Queue + Worker on
 * onModuleInit — never opens a Redis connection during tests.
 *
 * Jobs added while a Worker is registered are executed inline (async) so a suite
 * can assert on the processor's side effects without a broker. No retries, no
 * scheduling, no persistence — just enough surface for the code under test.
 */

export type ConnectionOptions = Record<string, unknown>;

type Listener = (...args: unknown[]) => void;

class Emitter {
  private readonly listeners = new Map<string, Listener[]>();
  on(event: string, cb: Listener): this {
    const arr = this.listeners.get(event) ?? [];
    arr.push(cb);
    this.listeners.set(event, arr);
    return this;
  }
  protected emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
}

export interface Job<T = unknown> {
  id: string;
  name: string;
  data: T;
}

let jobSeq = 0;

// A Worker registers its processor here so a same-named Queue can run jobs inline.
const processors = new Map<
  string,
  (job: Job<unknown>) => Promise<unknown> | unknown
>();

export class Worker<T = unknown> extends Emitter {
  constructor(
    public readonly name: string,
    processor: (job: Job<T>) => Promise<unknown> | unknown,
    _opts?: { connection?: ConnectionOptions; concurrency?: number },
  ) {
    super();
    processors.set(name, processor as (job: Job<unknown>) => unknown);
  }
  async close(): Promise<void> {
    processors.delete(this.name);
  }
}

export class Queue<T = unknown> extends Emitter {
  constructor(
    public readonly name: string,
    _opts?: { connection?: ConnectionOptions; defaultJobOptions?: unknown },
  ) {
    super();
  }

  async add(name: string, data: T): Promise<Job<T>> {
    const job: Job<T> = { id: String(++jobSeq), name, data };
    const processor = processors.get(this.name);
    if (processor) {
      // Run out-of-band so `add` resolves immediately, mirroring BullMQ.
      Promise.resolve()
        .then(() => processor(job as unknown as Job<unknown>))
        .catch(() => {
          /* swallowed — the real worker surfaces via 'failed' */
        });
    }
    return job;
  }

  async getJobCounts(): Promise<Record<string, number>> {
    return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
  }

  async close(): Promise<void> {
    /* no-op */
  }
}

export class QueueEvents extends Emitter {
  constructor(public readonly name: string, _opts?: unknown) {
    super();
  }
  async close(): Promise<void> {
    /* no-op */
  }
}
