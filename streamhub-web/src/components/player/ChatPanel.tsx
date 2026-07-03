/**
 * Slide-in chat panel. Messages flow over the `chat` data channel (owned by
 * useAddonChannels). Includes a small emoji bar so messages can carry emojis
 * inline. Purely presentational — sending/receiving is owned by the parent so
 * the same channel can also feed the unread badge.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EMOJIS, type ChatMessage } from './dataChannel'

interface ChatPanelProps {
  open: boolean
  messages: ChatMessage[]
  onSend: (body: string) => void
  onClose: () => void
}

function timeLabel(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

export function ChatPanel({ open, messages, onSend, onClose }: ChatPanelProps) {
  const { t } = useTranslation('playerComponents')
  const [draft, setDraft] = useState('')
  const [showEmojis, setShowEmojis] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, open])

  function submit() {
    const body = draft.trim()
    if (!body) return
    onSend(body)
    setDraft('')
    setShowEmojis(false)
  }

  return (
    <aside
      className={[
        // Mobile: bottom-sheet (slides up, rounded top, capped height).
        'absolute inset-x-0 bottom-0 z-30 flex max-h-[80%] flex-col rounded-t-2xl border-t border-white/10 bg-black/80 backdrop-blur transition-transform duration-200',
        // Desktop (sm+): right-hand side panel, full height.
        'sm:inset-y-0 sm:inset-x-auto sm:right-0 sm:max-h-none sm:w-80 sm:rounded-none sm:border-l sm:border-t-0 sm:border-white/10',
        open
          ? 'translate-y-0 sm:translate-x-0'
          : 'pointer-events-none translate-y-full sm:translate-y-0 sm:translate-x-full',
      ].join(' ')}
    >
      {/* Grab handle (mobile bottom-sheet affordance). */}
      <div className="flex justify-center pt-2 sm:hidden">
        <span className="h-1 w-10 rounded-full bg-white/20" />
      </div>
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <h2 className="text-sm font-semibold text-white">{t('chat.title')}</h2>
        <button
          onClick={onClose}
          aria-label={t('chat.close')}
          className="flex h-9 w-9 items-center justify-center rounded-md text-gray-400 transition hover:bg-white/10 hover:text-white"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <p className="mt-6 text-center text-xs text-gray-400">{t('chat.empty')}</p>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={['flex flex-col', m.self ? 'items-end' : 'items-start'].join(' ')}
            >
              <div className="mb-0.5 flex items-center gap-2 text-[10px] text-gray-500">
                <span className="font-medium text-gray-400">{m.sender}</span>
                <span>{timeLabel(m.ts)}</span>
              </div>
              <div
                className={[
                  'max-w-[85%] break-words rounded-2xl px-3 py-1.5 text-sm',
                  m.self
                    ? 'bg-primary-500/25 text-white ring-1 ring-primary-400/40'
                    : 'bg-white/10 text-gray-100',
                ].join(' ')}
              >
                {m.body}
              </div>
            </div>
          ))
        )}
      </div>

      {showEmojis && (
        <div className="flex flex-wrap gap-1 border-t border-white/10 px-3 py-2">
          {EMOJIS.map((e) => (
            <button
              key={e}
              onClick={() => setDraft((d) => d + e)}
              className="rounded-md px-1.5 py-0.5 text-lg transition hover:bg-white/10"
            >
              {e}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 border-t border-white/10 px-3 py-3">
        <button
          onClick={() => setShowEmojis((v) => !v)}
          aria-label={t('chat.emojis')}
          className={[
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-lg transition',
            showEmojis ? 'bg-white/10 text-white' : 'text-gray-400 hover:text-white',
          ].join(' ')}
        >
          😊
        </button>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          rows={1}
          placeholder={t('chat.placeholder')}
          className="max-h-24 min-h-10 flex-1 resize-none rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500/60"
        />
        <button
          onClick={submit}
          disabled={!draft.trim()}
          className="h-10 shrink-0 rounded-lg bg-primary-500 px-4 text-sm font-medium text-white transition hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('chat.send')}
        </button>
      </div>
    </aside>
  )
}
