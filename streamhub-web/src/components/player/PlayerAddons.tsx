/**
 * PlayerAddons — the reusable chat / reactions / viewers layer that sits on top
 * of any video surface. Must be rendered inside a <LiveKitRoom> context and
 * inside a `relative` (positioned) container so its absolute overlay anchors
 * correctly.
 *
 * It is shared by the live <LivePlayer> (subscriber) and the <Meeting> page
 * (publisher): both just drop it over their video grid. It owns its own data
 * channels (via useAddonChannels) and renders:
 *   - floating animated reactions      (topic `reaction`)
 *   - a slide-in chat panel + composer (topic `chat`)
 *   - a live viewer badge
 *   - a control cluster (reaction picker + chat toggle with unread badge)
 *
 * Each addon is independently toggleable via `features`.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChatPanel } from './ChatPanel'
import { ReactionsOverlay } from './ReactionsOverlay'
import { ViewerBadge } from './ViewerBadge'
import { EMOJIS } from './dataChannel'
import { useAddonChannels } from './useAddonChannels'

export interface PlayerAddonFeatures {
  chat?: boolean
  reactions?: boolean
  viewers?: boolean
}

type Anchor = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

export interface PlayerAddonsProps {
  /** Which addons to render. Omitted/false ones are skipped entirely. */
  features?: PlayerAddonFeatures
  /** Display name used for outgoing chat/reactions. */
  identity?: string
  /** Surfaced on data-channel send failures. */
  onError?: (err: Error) => void
  /** Anchor for the reaction/chat trigger cluster. Default 'bottom-right'. */
  controlsAnchor?: Anchor
  /** Anchor for the viewer badge. Default 'top-right'. */
  viewersAnchor?: Anchor
}

const ANCHOR: Record<Anchor, string> = {
  'bottom-right': 'bottom-3 right-3',
  'bottom-left': 'bottom-3 left-3',
  'top-right': 'top-3 right-3',
  'top-left': 'top-3 left-3',
}

const btnBase =
  'flex min-h-10 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium backdrop-blur transition'

function Icon({ d }: { d: string }) {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  )
}

export function PlayerAddons({
  features = {},
  identity,
  onError,
  controlsAnchor = 'bottom-right',
  viewersAnchor = 'top-right',
}: PlayerAddonsProps) {
  const { t } = useTranslation('playerComponents')
  const { chat, reactions, viewers } = features
  const ch = useAddonChannels({ identity, onError })
  const [showReactions, setShowReactions] = useState(false)

  const showControls = Boolean(chat || reactions)
  // Open the emoji popover toward the anchored edge so it never overflows the
  // stage on narrow (mobile) viewports.
  const popoverAlign = controlsAnchor.endsWith('right') ? 'right-0' : 'left-0'

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      {/* Floating reactions span the whole stage. */}
      {reactions && (
        <ReactionsOverlay reactions={ch.reactions} onExpire={ch.expireReaction} />
      )}

      {/* Viewer badge. */}
      {viewers && (
        <div className={`pointer-events-auto absolute ${ANCHOR[viewersAnchor]} z-30`}>
          <ViewerBadge />
        </div>
      )}

      {/* Trigger cluster: reaction picker + chat toggle. */}
      {showControls && (
        <div
          className={`pointer-events-auto absolute ${ANCHOR[controlsAnchor]} z-30 flex items-end gap-2`}
        >
          {reactions && (
            <div className="relative">
              {showReactions && (
                <div className={`absolute bottom-full ${popoverAlign} mb-2 flex max-w-[calc(100vw-2rem)] flex-wrap justify-center gap-1 rounded-xl bg-black/70 px-2 py-1.5 shadow-xl ring-1 ring-white/10 backdrop-blur`}>
                  {EMOJIS.map((e) => (
                    <button
                      key={e}
                      onClick={() => {
                        ch.sendReaction(e)
                        setShowReactions(false)
                      }}
                      className="flex h-9 w-9 items-center justify-center rounded-md text-xl transition hover:scale-125 hover:bg-white/10"
                    >
                      {e}
                    </button>
                  ))}
                </div>
              )}
              <button
                onClick={() => setShowReactions((v) => !v)}
                aria-label={t('controls.sendReaction')}
                className={`${btnBase} bg-black/60 text-white/90 ring-1 ring-white/15 hover:bg-black/70 hover:text-white`}
              >
                <span className="text-base leading-none">🎉</span>
                <span className="hidden sm:inline">{t('controls.reaction')}</span>
              </button>
            </div>
          )}

          {chat && (
            <button
              onClick={ch.toggleChat}
              aria-label={t('chat.toggle')}
              className={[
                btnBase,
                'relative',
                ch.chatOpen
                  ? 'bg-primary-500/30 text-white ring-1 ring-primary-400/50'
                  : 'bg-black/60 text-white/90 ring-1 ring-white/15 hover:bg-black/70 hover:text-white',
              ].join(' ')}
            >
              <Icon d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
              <span className="hidden sm:inline">{t('chat.title')}</span>
              {ch.unread > 0 && !ch.chatOpen && (
                <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary-500 px-1 text-[10px] font-bold text-white">
                  {ch.unread > 9 ? '9+' : ch.unread}
                </span>
              )}
            </button>
          )}
        </div>
      )}

      {/* Chat sidebar (its own absolute positioning + pointer events). */}
      {chat && (
        <div className="pointer-events-auto">
          <ChatPanel
            open={ch.chatOpen}
            messages={ch.messages}
            onSend={ch.sendChat}
            onClose={() => ch.setChatOpen(false)}
          />
        </div>
      )}
    </div>
  )
}
