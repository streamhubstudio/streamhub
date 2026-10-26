/**
 * Test bootstrap, loaded via `node --import ./test/setup.mjs`.
 *
 * Two jobs:
 *
 * 1. Resolve `.js` import specifiers to `.ts` on disk. The adaptor source is
 *    TypeScript-ESM (imports itself as `./types.js`, `./tokenClient.js`, ...),
 *    which is the correct on-the-wire convention but Node's built-in
 *    type-stripping does NOT rewrite the extension during resolution. This
 *    synchronous resolve hook does the `.js -> .ts` fallback so the suite can
 *    import the *unmodified* source with no build step.
 *
 * 2. Provide the couple of browser globals the adaptor touches at runtime
 *    (`MediaStream`) so specs run under plain Node with no jsdom.
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      specifier.endsWith(".js")
    ) {
      try {
        const asJs = new URL(specifier, context.parentURL);
        if (!existsSync(fileURLToPath(asJs))) {
          const tsSpecifier = specifier.slice(0, -3) + ".ts";
          const asTs = new URL(tsSpecifier, context.parentURL);
          if (existsSync(fileURLToPath(asTs))) {
            return nextResolve(tsSpecifier, context);
          }
        }
      } catch {
        /* fall through to default resolution */
      }
    }
    return nextResolve(specifier, context);
  },
});

// Minimal MediaStream stand-in: the adaptor wraps each remote MediaStreamTrack
// in `new MediaStream([mst])` when announcing `newStreamAvailable`.
if (typeof globalThis.MediaStream === "undefined") {
  globalThis.MediaStream = class MediaStream {
    constructor(tracks = []) {
      this._tracks = Array.isArray(tracks) ? tracks.slice() : [];
    }
    getTracks() {
      return this._tracks.slice();
    }
    getVideoTracks() {
      return this._tracks.filter((t) => t.kind === "video");
    }
    getAudioTracks() {
      return this._tracks.filter((t) => t.kind === "audio");
    }
    addTrack(t) {
      this._tracks.push(t);
    }
  };
}
