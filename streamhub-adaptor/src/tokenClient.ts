import type {
  StreamHubAdaptorConfig,
  StreamHubTokenResponse,
} from "./types.js";

/**
 * Resolve a LiveKit join token + wsUrl from the adaptor config.
 *
 * Resolution order:
 *  1. Pre-minted `token` + `wsUrl` in config -> used as-is (no network call).
 *  2. Mint via StreamHub `POST /apps/:app/tokens`, using:
 *     - `streamhubTokenUrl`, or
 *     - `streamhubApiUrl` + `appName`, or
 *     - parsing the AntMedia `websocket_url` (`wss://host/<app>/websocket`)
 *       to derive a default `{origin}/api/v1/apps/<app>/tokens`.
 *
 * @param overrides per-call body (room/identity/canPublish...) merged over config.tokenRequest
 */
export async function resolveToken(
  config: StreamHubAdaptorConfig,
  overrides: Record<string, any> = {},
): Promise<StreamHubTokenResponse> {
  // 1. Pre-minted token shortcut.
  if (config.token) {
    const wsUrl = config.wsUrl || deriveLiveKitWsUrl(config.websocket_url);
    if (!wsUrl) {
      throw new Error(
        "StreamHubAdaptor: a pre-minted `token` was provided but no `wsUrl`.",
      );
    }
    return {
      token: config.token,
      wsUrl,
      room: overrides.room,
      identity: overrides.identity,
    };
  }

  const url = resolveTokenUrl(config);
  if (!url) {
    throw new Error(
      "StreamHubAdaptor: cannot resolve a StreamHub token endpoint. Provide " +
        "`streamhubTokenUrl`, or `streamhubApiUrl`+`appName`, or a pre-minted " +
        "`token`+`wsUrl`, or an AntMedia-style `websocket_url`.",
    );
  }

  const body = { ...(config.tokenRequest || {}), ...overrides };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.streamhubApiToken) {
    headers["Authorization"] = `Bearer ${config.streamhubApiToken}`;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `StreamHubAdaptor: token mint failed (${res.status}) at ${url}: ${text}`,
    );
  }

  const json: any = await res.json();
  // StreamHub wraps responses as { data, error }.
  const data: StreamHubTokenResponse = json?.data ?? json;
  if (!data?.token || !data?.wsUrl) {
    throw new Error(
      "StreamHubAdaptor: token response missing `token` or `wsUrl`.",
    );
  }
  return data;
}

/** Build the `POST /apps/:app/tokens` URL from the various config shapes. */
export function resolveTokenUrl(config: StreamHubAdaptorConfig): string | null {
  if (config.streamhubTokenUrl) return config.streamhubTokenUrl;

  const app = config.appName || parseAppFromWsUrl(config.websocket_url);

  if (config.streamhubApiUrl && app) {
    return `${stripTrailingSlash(config.streamhubApiUrl)}/apps/${app}/tokens`;
  }

  // Last resort: derive from an AntMedia websocket_url origin.
  if (config.websocket_url && app) {
    try {
      const u = new URL(toHttp(config.websocket_url));
      return `${u.origin}/api/v1/apps/${app}/tokens`;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** AntMedia URL: `wss://host/<app>/websocket` -> `<app>`. */
export function parseAppFromWsUrl(wsUrl?: string): string | null {
  if (!wsUrl) return null;
  try {
    const u = new URL(toHttp(wsUrl));
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && parts[parts.length - 1] === "websocket") {
      return parts[parts.length - 2];
    }
    if (parts.length >= 1 && parts[0] !== "websocket") return parts[0];
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * If the AntMedia websocket_url is actually a bare LiveKit endpoint
 * (`wss://media.host` with no `/<app>/websocket` path), reuse it as the
 * LiveKit wsUrl. Otherwise return undefined (token mint provides wsUrl).
 */
export function deriveLiveKitWsUrl(wsUrl?: string): string | undefined {
  if (!wsUrl) return undefined;
  try {
    const u = new URL(toHttp(wsUrl));
    const parts = u.pathname.split("/").filter(Boolean);
    const isAntMediaPath = parts[parts.length - 1] === "websocket";
    if (!isAntMediaPath) {
      // Bare LiveKit URL: normalize back to ws(s).
      return wsUrl;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function toHttp(ws: string): string {
  return ws.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
