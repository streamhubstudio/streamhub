/**
 * Browser/CDN entry. Produces an IIFE whose global name is `webrtc_adaptor`,
 * matching how AntMedia's CDN bundle is consumed:
 *
 *   <script src=".../webrtc_adaptor.js"></script>
 *   <script>window.WebRTCAdaptor = window.webrtc_adaptor?.WebRTCAdaptor;</script>
 *
 * Swap the AntMedia CDN <script src> for the StreamHub bundle and nothing else
 * changes. livekit-client is bundled in (see tsup.config.ts).
 */
import { StreamHubAdaptor } from "./StreamHubAdaptor.js";

export { StreamHubAdaptor };
export { StreamHubAdaptor as WebRTCAdaptor };
