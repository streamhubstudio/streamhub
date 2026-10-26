/**
 * Loads the adaptor with `livekit-client` replaced by the deterministic fake.
 *
 * `mock.module` must run before the adaptor's static `import ... from
 * "livekit-client"` is evaluated, so the adaptor is pulled in via a dynamic
 * import *after* the mock is registered (top-level await). Every spec imports
 * from here instead of touching `../src` directly.
 *
 * Requires the runner flag `--experimental-test-module-mocks`.
 */
import { mock } from "node:test";
import * as lk from "./fake-livekit.ts";

mock.module("livekit-client", { namedExports: lk.namedExports });

const mod: any = await import("../src/index.ts");

export const StreamHubAdaptor = mod.StreamHubAdaptor;
export const WebRTCAdaptor = mod.WebRTCAdaptor;
export const AdaptorDefault = mod.default;
export { lk };

/** Access the internal FakeRoom the adaptor built in its constructor. */
export function roomOf(adaptor: any): InstanceType<typeof lk.FakeRoom> {
  return adaptor.room;
}

/** Flush pending microtasks + one macrotask (for fire-and-forget emits). */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Record every (info, obj) callback pair an adaptor emits. */
export function collector() {
  const events: Array<{ info: string; obj: any }> = [];
  const errors: Array<{ error: string; message: any }> = [];
  return {
    events,
    errors,
    callback: (info: string, obj?: any) => events.push({ info, obj }),
    callbackError: (error: string, message?: any) =>
      errors.push({ error, message }),
    /** All payloads emitted under `info`. */
    all(info: string) {
      return events.filter((e) => e.info === info).map((e) => e.obj);
    },
    /** First payload emitted under `info` (or undefined). */
    first(info: string) {
      return events.find((e) => e.info === info)?.obj;
    },
    /** Last payload emitted under `info` (or undefined). */
    last(info: string) {
      const hit = events.filter((e) => e.info === info);
      return hit.length ? hit[hit.length - 1].obj : undefined;
    },
    count(info: string) {
      return events.filter((e) => e.info === info).length;
    },
    infos() {
      return events.map((e) => e.info);
    },
  };
}

/** Pre-minted-token config so ensureConnected never hits the network. */
export function baseConfig(over: Record<string, any> = {}) {
  const c = collector();
  return {
    cfg: {
      token: "jwt-token",
      wsUrl: "wss://media.test",
      callback: c.callback,
      callbackError: c.callbackError,
      ...over,
    },
    c,
  };
}
