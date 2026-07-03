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

export default StreamHubAdaptor;
