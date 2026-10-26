/**
 * Public types for StreamHubAdaptor.
 *
 * The goal is byte-for-byte API compatibility with AntMedia's
 * `@antmedia/webrtc_adaptor` `WebRTCAdaptor`, so the field/callback names
 * intentionally use AntMedia's snake_case / string conventions.
 */

/** AntMedia-style info callback. `info` is a string event name, `obj` payload. */
export type AntMediaCallback = (info: string, obj?: any) => void;

/** AntMedia-style error callback. */
export type AntMediaErrorCallback = (error: string, message?: any) => void;

export interface StreamHubMediaConstraints {
  video?: boolean | MediaTrackConstraints;
  audio?: boolean | MediaTrackConstraints;
}

export interface StreamHubAdaptorConfig {
  // ---- AntMedia-compatible fields ----
  /**
   * AntMedia WebSocket signalling URL, e.g.
   * `wss://host/<app>/websocket`. StreamHubAdaptor parses the `<app>` segment
   * from it to know which StreamHub app to mint tokens against. If it is a bare
   * LiveKit URL (`wss://media.host`) it is used directly as the LiveKit wsUrl.
   */
  websocket_url?: string;

  /** Local <video> element (preview). AntMedia name. */
  localVideoElement?: HTMLVideoElement | null;
  /** Local <video> element id. AntMedia name. */
  localVideoId?: string | null;
  /** Remote <video> element (single-peer play). */
  remoteVideoElement?: HTMLVideoElement | null;
  remoteVideoId?: string | null;

  mediaConstraints?: StreamHubMediaConstraints;
  /** Target video bandwidth in kbps (maps to LiveKit maxBitrate). */
  bandwidth?: number;
  /** Enable the data channel (chat/notifications). Default true. */
  dataChannelEnabled?: boolean;
  /**
   * LiveKit adaptive streaming: automatically drops simulcast layers the
   * viewer's element can't display (bandwidth/CPU saver for many-viewer
   * rooms). Default TRUE — pass false only to debug layer selection.
   */
  adaptiveStream?: boolean;
  /**
   * LiveKit dynacast: pauses publishing simulcast layers no subscriber is
   * consuming. Default TRUE.
   */
  dynacast?: boolean;
  /**
   * Video codec published to the room. Default **'h264'** (AntMedia parity +
   * Safari interop): H.264 is hardware-encoded/decoded on every Apple device
   * (VP8 there is software-only → battery drain) and is what the HLS/MP4
   * egress pipeline wants. Pass 'vp8'/'vp9'/'av1' to override.
   */
  videoCodec?: "h264" | "vp8" | "vp9" | "av1";
  /** Subscribe-only mode (no camera/mic publish). */
  isPlayMode?: boolean;
  /** Alias for isPlayMode used by some apps. */
  playOnly?: boolean;
  /** Enable verbose console logging. */
  debug?: boolean;

  callback?: AntMediaCallback;
  /** AntMedia uses both spellings depending on version. */
  callbackError?: AntMediaErrorCallback;
  callback_error?: AntMediaErrorCallback;

  // ---- AntMedia fields accepted but NOT used (no-op / handled by LiveKit) ----
  peerconnection_config?: any;
  sdp_constraints?: any;
  /** AntMedia plugin hooks. Kept as a static no-op for source compat. */
  pluginInitMethods?: any[];

  // ---- StreamHub-specific fields ----
  /**
   * Full URL of the StreamHub mint-token endpoint:
   * `POST {streamhubTokenUrl}` -> `{ data: { token, wsUrl, ... } }`.
   * e.g. `https://streamhub.host/api/v1/apps/live/tokens`.
   */
  streamhubTokenUrl?: string;
  /** StreamHub API base, e.g. `https://streamhub.host/api/v1`. Combined with appName. */
  streamhubApiUrl?: string;
  /** StreamHub app name, e.g. `live`. Used with streamhubApiUrl to build the token URL. */
  appName?: string;
  /** Bearer token for the StreamHub management API (only needed if minting client-side). */
  streamhubApiToken?: string;
  /**
   * A pre-minted LiveKit join token. If provided, StreamHubAdaptor does NOT call
   * the StreamHub API and connects directly with this token + wsUrl.
   */
  token?: string;
  /** LiveKit public WSS URL. Required when passing a pre-minted `token`. */
  wsUrl?: string;
  /** Extra body fields forwarded to POST /apps/:app/tokens (canPublish, ttl, identity...). */
  tokenRequest?: Record<string, any>;
}

/** Shape returned by StreamHub `POST /apps/:app/tokens`. */
export interface StreamHubTokenResponse {
  token: string;
  app?: string;
  room?: string;
  identity?: string;
  wsUrl: string;
  playUrl?: string;
  embedUrl?: string;
  iframe?: string;
}
