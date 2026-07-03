/**
 * Meeting stage — rendered inside <LiveKitRoom> (room context is available).
 *
 * Responsibilities:
 *  - Camera/screen-share grid (GridLayout + ParticipantTile).
 *  - Live viewer counter (hidden QC participants are excluded by LiveKit).
 *  - Chat over the `chat` data channel (reliable).
 *  - Floating reactions over the `reaction` data channel (lossy).
 *
 * Data channels are owned here (not in the children) so the same stream can
 * drive both the rendered list and the unread badge, and so locally-sent
 * messages echo immediately (LiveKit does not loop data back to the sender).
 */
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Track } from 'livekit-client'
import {
  GridLayout,
  ParticipantTile,
  RoomAudioRenderer,
  useDataChannel,
  useLocalParticipant,
  useParticipants,
  useTracks,
} from '@livekit/components-react'
import ChatPanel from './ChatPanel'
import MeetingControls from './MeetingControls'
import ReactionsOverlay, { type FloatingReaction } from './ReactionsOverlay'
import {
  CHAT_TOPIC,
  REACTION_TOPIC,
  decode,
  encode,
  randomId,
  type ChatMessage,
  type ReactionMessage,
} from './dataChannel'

interface MeetingRoomProps {
  app: string
  room: string
  onError: (error: Error) => void
}

const MAX_REACTIONS = 40

export default function MeetingRoom({ app, room, onError }: MeetingRoomProps) {
  const { t } = useTranslation('meeting')
  const { localParticipant } = useLocalParticipant()
  const participants = useParticipants()

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [reactions, setReactions] = useState<FloatingReaction[]>([])
  const [chatOpen, setChatOpen] = useState(false)
  const [unread, setUnread] = useState(0)

  const selfName =
    localParticipant.name || localParticipant.identity || t('participant.self')

  // --- chat data channel ----------------------------------------------------
  const { send: sendChatRaw } = useDataChannel(CHAT_TOPIC, (msg) => {
    const parsed = decode<ChatMessage>(msg.payload)
    if (!parsed || typeof parsed.body !== 'string') return
    const incoming: ChatMessage = {
      id: parsed.id || randomId(),
      sender: parsed.sender || msg.from?.identity || t('participant.anonymous'),
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
      const msg: ChatMessage = {
        id: randomId(),
        sender: selfName,
        body,
        ts: Date.now(),
      }
      // Optimistic local echo (data packets don't loop back to the sender).
      setMessages((prev) => [...prev, { ...msg, self: true }])
      void sendChatRaw(encode(msg), { reliable: true }).catch(onError)
    },
    [selfName, sendChatRaw, onError],
  )

  // --- reaction data channel ------------------------------------------------
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
      sender: parsed.sender || msg.from?.identity || t('participant.someone'),
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
      void sendReactionRaw(encode(r), { reliable: false }).catch(onError)
    },
    [selfName, sendReactionRaw, spawnReaction, onError],
  )

  const expireReaction = useCallback((id: string) => {
    setReactions((prev) => prev.filter((r) => r.id !== id))
  }, [])

  function toggleChat() {
    setChatOpen((open) => {
      if (!open) setUnread(0)
      return !open
    })
  }

  // --- video grid -----------------------------------------------------------
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-gray-800 bg-gray-900/80 px-4 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-fg">{room}</h1>
          <p className="truncate text-xs text-gray-500">{app}</p>
        </div>
        <div className="flex items-center gap-2 rounded-full bg-gray-800 px-3 py-1 text-xs text-gray-300 ring-1 ring-gray-700">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary-400/60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary-500" />
          </span>
          {t('stage.inRoom', { count: participants.length })}
        </div>
      </header>

      {/* Stage + chat */}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 bg-gray-900/40">
          {tracks.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-gray-500">
              {t('stage.waiting')}
            </div>
          ) : (
            <GridLayout tracks={tracks} className="h-full">
              <ParticipantTile />
            </GridLayout>
          )}
          <ReactionsOverlay reactions={reactions} onExpire={expireReaction} />
        </div>

        {chatOpen && (
          <ChatPanel
            open={chatOpen}
            messages={messages}
            onSend={sendChat}
            onClose={() => setChatOpen(false)}
          />
        )}
      </div>

      <MeetingControls
        chatOpen={chatOpen}
        unread={unread}
        onToggleChat={toggleChat}
        onReact={sendReaction}
        onDeviceError={onError}
      />

      {/* Plays remote audio tracks. */}
      <RoomAudioRenderer />
    </div>
  )
}
