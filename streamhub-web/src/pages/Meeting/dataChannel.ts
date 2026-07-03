/**
 * Helpers for the Meeting page's LiveKit data-channel messages.
 *
 * Two topics are used (matching the streamhub-core convention):
 *  - `chat`     → { kind:'chat', ... }     reliable text messages (+ emojis)
 *  - `reaction` → { kind:'reaction', ... } lossy floating reactions
 *
 * Payloads are JSON encoded as UTF-8 bytes (LiveKit data packets are binary).
 */

export const CHAT_TOPIC = 'chat'
export const REACTION_TOPIC = 'reaction'

export interface ChatMessage {
  /** Stable id for React keys / de-dupe. */
  id: string
  /** Display name of the sender (falls back to identity). */
  sender: string
  /** Message body (may contain emojis). */
  body: string
  /** Epoch millis. */
  ts: number
  /** True when this client sent it (rendered on the right, accent colour). */
  self?: boolean
}

export interface ReactionMessage {
  id: string
  emoji: string
  sender: string
  ts: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encode(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value))
}

export function decode<T>(payload: Uint8Array): T | null {
  try {
    return JSON.parse(decoder.decode(payload)) as T
  } catch {
    return null
  }
}

/** Reasonably unique id without pulling in a uuid dependency. */
export function randomId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }
}

/** Emojis offered in the chat composer + reaction picker. */
export const EMOJIS = ['👍', '❤️', '😂', '🎉', '😮', '👏', '🔥', '🙌'] as const
