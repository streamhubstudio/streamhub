/**
 * No-op `ioredis` mock (harness). The core passes CONNECTION OPTIONS (not an
 * instance) to BullMQ, and BullMQ itself is mocked, so nothing should construct
 * this. It exists only as a safety net: if any code path does `new Redis(...)`
 * under test it gets an inert client instead of a live socket.
 */
class RedisMock {
  status = 'ready';
  constructor(..._args: unknown[]) {}
  on(): this {
    return this;
  }
  async connect(): Promise<void> {}
  async quit(): Promise<'OK'> {
    return 'OK';
  }
  async disconnect(): Promise<void> {}
  async ping(): Promise<'PONG'> {
    return 'PONG';
  }
  async get(): Promise<null> {
    return null;
  }
  async set(): Promise<'OK'> {
    return 'OK';
  }
}

export default RedisMock;
export { RedisMock as Redis };
