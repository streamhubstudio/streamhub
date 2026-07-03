import { defineConfig } from "tsup";

export default defineConfig([
  // Library build: ESM + CJS + d.ts. livekit-client stays external (peer dep).
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    external: ["livekit-client"],
  },
  // Browser/CDN build (IIFE global). Bundles livekit-client so a single
  // <script> tag is a drop-in for the AntMedia CDN bundle. Exposes
  // window.webrtc_adaptor.WebRTCAdaptor (same shape AntMedia uses).
  {
    entry: { "streamhub-adaptor": "src/global.ts" },
    format: ["iife"],
    globalName: "webrtc_adaptor",
    sourcemap: true,
    minify: true,
    clean: false,
    treeshake: true,
    // livekit-client is bundled here (NOT external) on purpose.
  },
]);
