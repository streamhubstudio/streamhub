import { StreamHubAdaptor } from "./StreamHubAdaptor.js";

export { StreamHubAdaptor } from "./StreamHubAdaptor.js";

/**
 * Drop-in alias. AntMedia apps do `new WebRTCAdaptor({...})` — keep that name
 * working so migrating is just a changed import path.
 */
export { StreamHubAdaptor as WebRTCAdaptor } from "./StreamHubAdaptor.js";

export type {
  StreamHubAdaptorConfig,
  StreamHubMediaConstraints,
  StreamHubTokenResponse,
  AntMediaCallback,
  AntMediaErrorCallback,
} from "./types.js";

/**
 * Safari/iOS browser-compat helpers (see WEBRTC-BROWSER-COMPAT.md) — exported
 * so integrating apps can reuse them (e.g. hide a share-screen button when
 * `supportsScreenShare()` is false, or force `playsinline` on their own
 * video elements).
 */
export {
  isIOS,
  isSafari,
  isWebKit,
  supportsScreenShare,
  applyInlinePlaybackAttributes,
  classifyGetUserMediaError,
  installAutoplayUnlock,
  withTurnHint,
} from "./browserCompat.js";

export default StreamHubAdaptor;
