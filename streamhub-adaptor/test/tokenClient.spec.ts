/**
 * tokenClient — credential resolution: pre-minted shortcut, the three ways to
 * derive the mint endpoint, AntMedia websocket_url parsing, and the actual
 * POST /apps/:app/tokens mint (fetch stubbed). No livekit-client involved.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveToken,
  resolveTokenUrl,
  parseAppFromWsUrl,
  deriveLiveKitWsUrl,
} from "../src/tokenClient.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(impl: (url: string, init: any) => any) {
  const calls: Array<{ url: string; init: any }> = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return impl(String(url), init);
  }) as any;
  return calls;
}

function jsonResponse(body: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// ---- parseAppFromWsUrl -----------------------------------------------------

test("parseAppFromWsUrl: AntMedia wss://host/<app>/websocket -> <app>", () => {
  assert.equal(parseAppFromWsUrl("wss://media.example.com/Conference/websocket"), "Conference");
  assert.equal(parseAppFromWsUrl("ws://host/live/websocket"), "live");
});

test("parseAppFromWsUrl: first path segment when not a /websocket URL", () => {
  assert.equal(parseAppFromWsUrl("wss://host/live"), "live");
});

test("parseAppFromWsUrl: null for bare host / undefined / garbage", () => {
  assert.equal(parseAppFromWsUrl("wss://media.example.com"), null);
  assert.equal(parseAppFromWsUrl(undefined), null);
  assert.equal(parseAppFromWsUrl("not a url"), null);
});

// ---- deriveLiveKitWsUrl ----------------------------------------------------

test("deriveLiveKitWsUrl: bare LiveKit URL reused; AntMedia /websocket URL rejected", () => {
  assert.equal(deriveLiveKitWsUrl("wss://media.host"), "wss://media.host");
  assert.equal(deriveLiveKitWsUrl("wss://host/live/websocket"), undefined);
  assert.equal(deriveLiveKitWsUrl(undefined), undefined);
});

// ---- resolveTokenUrl -------------------------------------------------------

test("resolveTokenUrl: explicit streamhubTokenUrl wins", () => {
  assert.equal(
    resolveTokenUrl({ streamhubTokenUrl: "https://sh/api/v1/apps/live/tokens" }),
    "https://sh/api/v1/apps/live/tokens",
  );
});

test("resolveTokenUrl: streamhubApiUrl + appName (trailing slash trimmed)", () => {
  assert.equal(
    resolveTokenUrl({ streamhubApiUrl: "https://sh/api/v1/", appName: "live" }),
    "https://sh/api/v1/apps/live/tokens",
  );
});

test("resolveTokenUrl: streamhubApiUrl + app parsed from websocket_url", () => {
  assert.equal(
    resolveTokenUrl({
      streamhubApiUrl: "https://sh/api/v1",
      websocket_url: "wss://sh/Conference/websocket",
    }),
    "https://sh/api/v1/apps/Conference/tokens",
  );
});

test("resolveTokenUrl: last-resort derive from websocket_url origin", () => {
  assert.equal(
    resolveTokenUrl({ websocket_url: "wss://media.example.com/live/websocket" }),
    "https://media.example.com/api/v1/apps/live/tokens",
  );
});

test("resolveTokenUrl: null when nothing is resolvable", () => {
  assert.equal(resolveTokenUrl({}), null);
  assert.equal(resolveTokenUrl({ websocket_url: "wss://media.host" }), null);
});

// ---- resolveToken: pre-minted shortcut -------------------------------------

test("resolveToken: pre-minted token + wsUrl short-circuits (no fetch)", async () => {
  const calls = stubFetch(() => {
    throw new Error("must not fetch");
  });
  const out = await resolveToken(
    { token: "jwt", wsUrl: "wss://media.host" },
    { room: "r1", identity: "u1" },
  );
  assert.deepEqual(out, { token: "jwt", wsUrl: "wss://media.host", room: "r1", identity: "u1" });
  assert.equal(calls.length, 0);
});

test("resolveToken: pre-minted token derives wsUrl from a bare websocket_url", async () => {
  const out = await resolveToken({ token: "jwt", websocket_url: "wss://media.host" });
  assert.equal(out.wsUrl, "wss://media.host");
});

test("resolveToken: pre-minted token with an AntMedia websocket_url + no wsUrl throws", async () => {
  await assert.rejects(
    resolveToken({ token: "jwt", websocket_url: "wss://host/live/websocket" }),
    /no `wsUrl`/,
  );
});

// ---- resolveToken: mint via fetch ------------------------------------------

test("resolveToken: mints via POST, unwraps { data }, sends Bearer + merged body", async () => {
  const calls = stubFetch(() =>
    jsonResponse({ data: { token: "minted", wsUrl: "wss://lk.host", room: "r1" } }),
  );
  const out = await resolveToken(
    {
      streamhubTokenUrl: "https://sh/api/v1/apps/live/tokens",
      streamhubApiToken: "sk_mgmt",
      tokenRequest: { ttl: 3600, hidden: true },
    },
    { room: "r1", identity: "u1", canPublish: true },
  );
  assert.equal(out.token, "minted");
  assert.equal(out.wsUrl, "wss://lk.host");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://sh/api/v1/apps/live/tokens");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Authorization"], "Bearer sk_mgmt");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  // overrides merge over tokenRequest.
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    ttl: 3600,
    hidden: true,
    room: "r1",
    identity: "u1",
    canPublish: true,
  });
});

test("resolveToken: accepts an unwrapped {token,wsUrl} response body too", async () => {
  stubFetch(() => jsonResponse({ token: "bare", wsUrl: "wss://lk.host" }));
  const out = await resolveToken({ streamhubTokenUrl: "https://sh/t" });
  assert.equal(out.token, "bare");
});

test("resolveToken: omits Authorization header when no streamhubApiToken", async () => {
  const calls = stubFetch(() => jsonResponse({ data: { token: "t", wsUrl: "w" } }));
  await resolveToken({ streamhubTokenUrl: "https://sh/t" });
  assert.equal(calls[0].init.headers["Authorization"], undefined);
});

test("resolveToken: non-2xx mint throws with status + endpoint", async () => {
  stubFetch(() => jsonResponse({ error: "forbidden" }, 403));
  await assert.rejects(
    resolveToken({ streamhubTokenUrl: "https://sh/t" }),
    /token mint failed \(403\)/,
  );
});

test("resolveToken: response missing token/wsUrl throws", async () => {
  stubFetch(() => jsonResponse({ data: { token: "t" } })); // no wsUrl
  await assert.rejects(
    resolveToken({ streamhubTokenUrl: "https://sh/t" }),
    /missing `token` or `wsUrl`/,
  );
});

test("resolveToken: no resolvable endpoint throws a helpful error", async () => {
  await assert.rejects(resolveToken({}), /cannot resolve a StreamHub token endpoint/);
});
