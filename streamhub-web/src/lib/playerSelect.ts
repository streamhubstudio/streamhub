/**
 * Pure logic for the Live view's dual-player selector (node:test-able).
 *
 * When the Vidstack Player plugin is installed + active for an app, the HLS live
 * view lets the operator watch the stream in the Vidstack player OR in the
 * built-in video.js player, and copy an embed snippet for either. With no
 * provider active there is nothing to choose — video.js is the only player — so
 * the selector hides and behaves exactly as before.
 *
 * This module owns the two decisions the UI needs (which choices to offer + how
 * a choice maps to the <HlsPlayer forcePlayer> prop and to an embed snippet) so
 * they stay testable without a DOM.
 */
import { embedIframeSnippet, hlsEmbedSnippet } from './share.ts'

/** The two players a stream can be watched in. */
export type PlayerChoice = 'provider' | 'builtin'

export interface PlayerSelectorState {
  /** Show the Vidstack | video.js toggle (only when a provider is active). */
  show: boolean
  /** The choices to offer, in order. */
  choices: PlayerChoice[]
  /** The initial/default choice — the provider when one is available. */
  initial: PlayerChoice
}

/**
 * The selector state for a stream, given whether the app has an active player
 * provider (Vidstack). No provider → video.js only, selector hidden.
 */
export function playerSelector(hasProvider: boolean): PlayerSelectorState {
  return hasProvider
    ? { show: true, choices: ['provider', 'builtin'], initial: 'provider' }
    : { show: false, choices: ['builtin'], initial: 'builtin' }
}

/** Map a choice to the `<HlsPlayer forcePlayer>` value that renders it. */
export function forcePlayerFor(choice: PlayerChoice): 'provider' | 'builtin' {
  return choice
}

/**
 * The copy-embed-code snippet for a choice:
 *  - 'provider' → the `/embed` <iframe> (the FULL widget — renders whichever
 *    player the app has active, i.e. Vidstack + its UI);
 *  - 'builtin'  → a self-contained video.js embed over the public HLS playlist.
 */
export function embedSnippetFor(
  choice: PlayerChoice,
  urls: { embedUrl: string; playlistUrl: string },
): string {
  return choice === 'provider'
    ? embedIframeSnippet(urls.embedUrl)
    : hlsEmbedSnippet(urls.playlistUrl)
}
