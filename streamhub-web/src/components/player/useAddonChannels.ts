/**
 * useAddonChannels — owns the `chat` and `reaction` LiveKit data channels for
 * the player addons. Must be called inside a <LiveKitRoom> context.
 *
 * Keeping the channels in one hook (instead of per-component) means a single
 * incoming stream can drive both the rendered list and the unread badge, and
 * locally-sent messages can echo immediately (LiveKit does not loop data packets
 * back to the sender).
 */
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useDataChannel,
  useLocalParticipant,
} from '@livekit/components-react'
import {
  CHAT_TOPIC,
  REACTION_TOPIC,
  decode,
  encode,
  randomId,
  type ChatMessage,
  type ReactionMessage,
} from './dataChannel'

/** A reaction enriched with the randomised motion used by the overlay. */
export interface FloatingReaction extends ReactionMessage {
  /** 0-100, horizontal start position as a percentage of the stage width. */
  left: number
  /** Animation duration in ms. */
  duration: number
  /** Horizontal drift in px (can be negative). */
  drift: number
}

export interface AddonChannels {
  /** Display name used for outgoing chat/reactions. */
  selfName: string
  // chat
  messages: ChatMessage[]
  sendChat: (body: string) => void
  unread: number
  /** Reset the unread counter (call when the chat panel opens). */
  clearUnread: () => void
  /** Whether the chat panel is open. */
  chatOpen: boolean
  setChatOpen: (open: boolean) => void
  toggleChat: () => void
  // reactions
  reactions: FloatingReaction[]
  sendReaction: (emoji: string) => void
  expireReaction: (id: string) => void
}

const MAX_REACTIONS = 40

export interface UseAddonChannelsOptions {
  /** Override the display name (otherwise taken from the local participant). */
  identity?: string
  /** Surfaced on send failures. */
  onError?: (err: Error) => void
}

export function useAddonChannels(
  opts: UseAddonChannelsOptions = {},
): AddonChannels {
  const { t } = useTranslation('playerComponents')
  const { localParticipant } = useLocalParticipant()
  const onError = opts.onError

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [reactions, setReactions] = useState<FloatingReaction[]>([])
  const [chatOpen, setChatOpen] = useState(false)
  const [unread, setUnread] = useState(0)

  const selfName =
    opts.identity ||
    localParticipant.name ||
    localParticipant.identity ||
    t('identity.you')

  // --- chat -----------------------------------------------------------------
  const { send: sendChatRaw } = useDataChannel(CHAT_TOPIC, (msg) => {
    const parsed = decode<ChatMessage>(msg.payload)
    if (!parsed || typeof parsed.body !== 'string') return
    const incoming: ChatMessage = {
      id: parsed.id || randomId(),
      sender: parsed.sender || msg.from?.identity || t('identity.anonymous'),
      body: parsed.body,
      ts: parsed.ts || Date.now(),
      self: false,
    }
    setMessages((prev) => [...prev, incoming])
    setChatOpen((open) => {
      if (!open) setUnread((n) => n + 1)
      return open
    })
  })

  const sendChat = useCallback(
    (body: string) => {
      const trimmed = body.trim()
      if (!trimmed) return
      const msg: ChatMessage = {
        id: randomId(),
        sender: selfName,
        body: trimmed,
        ts: Date.now(),
      }
      setMessages((prev) => [...prev, { ...msg, self: true }])
      void sendChatRaw(encode(msg), { reliable: true }).catch(
        (e: Error) => onError?.(e),
      )
    },
    [selfName, sendChatRaw, onError],
  )

  // --- reactions ------------------------------------------------------------
  const spawnReaction = useCallback((r: ReactionMessage) => {
    const floating: FloatingReaction = {
      ...r,
      left: 8 + Math.random() * 84,
      duration: 2600 + Math.random() * 1200,
      drift: (Math.random() - 0.5) * 120,
    }
    setReactions((prev) => [...prev.slice(-(MAX_REACTIONS - 1)), floating])
  }, [])

  const { send: sendReactionRaw } = useDataChannel(REACTION_TOPIC, (msg) => {
    const parsed = decode<ReactionMessage>(msg.payload)
    if (!parsed || typeof parsed.emoji !== 'string') return
    spawnReaction({
      id: parsed.id || randomId(),
      emoji: parsed.emoji,
      sender: parsed.sender || msg.from?.identity || t('identity.someone'),
      ts: parsed.ts || Date.now(),
    })
  })

  const sendReaction = useCallback(
    (emoji: string) => {
      const r: ReactionMessage = {
        id: randomId(),
        emoji,
        sender: selfName,
        ts: Date.now(),
      }
      spawnReaction(r) // show our own immediately
      void sendReactionRaw(encode(r), { reliable: false }).catch(
        (e: Error) => onError?.(e),
      )
    },
    [selfName, sendReactionRaw, spawnReaction, onError],
  )

  const expireReaction = useCallback((id: string) => {
    setReactions((prev) => prev.filter((r) => r.id !== id))
  }, [])

  const clearUnread = useCallback(() => setUnread(0), [])

  const toggleChat = useCallback(() => {
    setChatOpen((open) => {
      if (!open) setUnread(0)
      return !open
    })
  }, [])

  return {
    selfName,
    messages,
    sendChat,
    unread,
    clearUnread,
    chatOpen,
    setChatOpen,
    toggleChat,
    reactions,
    sendReaction,
    expireReaction,
  }
}
