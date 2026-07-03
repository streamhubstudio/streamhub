/**
 * Slide-in chat panel for the meeting. Messages flow over the `chat` data
 * channel (see MeetingRoom). Includes a small emoji bar so messages can carry
 * reactions inline. Purely presentational — sending/receiving is owned by the
 * parent so the same data channel can also feed the unread badge.
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

export default function ChatPanel({
  open,
  messages,
  onSend,
  onClose,
}: ChatPanelProps) {
  const { t } = useTranslation('meeting')
  const [draft, setDraft] = useState('')
  const [showEmojis, setShowEmojis] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to the newest message when it arrives or the panel opens.
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
        'flex bg-gray-900/90 ring-1 ring-white/10 backdrop-blur w-full flex-col border-l border-gray-800 transition-transform duration-200 sm:w-80',
        open ? 'translate-x-0' : 'pointer-events-none translate-x-full',
      ].join(' ')}
    >
      <header className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
        <h2 className="text-sm font-semibold text-fg">{t('chat.title')}</h2>
        <button
          onClick={onClose}
          aria-label={t('chat.close')}
          className="rounded-md p-1 text-gray-400 transition hover:bg-gray-800 hover:text-fg"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <p className="mt-6 text-center text-xs text-gray-500">
            {t('chat.empty')}
          </p>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={['flex flex-col', m.self ? 'items-end' : 'items-start'].join(
                ' ',
              )}
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
                    : 'bg-gray-800 text-gray-200',
                ].join(' ')}
              >
                {m.body}
              </div>
            </div>
          ))
        )}
      </div>

      {showEmojis && (
        <div className="flex flex-wrap gap-1 border-t border-gray-800 px-3 py-2">
          {EMOJIS.map((e) => (
            <button
              key={e}
              onClick={() => setDraft((d) => d + e)}
              className="rounded-md px-1.5 py-0.5 text-lg transition hover:bg-gray-800"
            >
              {e}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 border-t border-gray-800 px-3 py-3">
        <button
          onClick={() => setShowEmojis((v) => !v)}
          aria-label={t('chat.emojis')}
          className={[
            'shrink-0 rounded-lg px-2 py-2 text-lg transition',
            showEmojis ? 'bg-gray-800 text-fg' : 'text-gray-400 hover:text-fg',
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
          className="max-h-24 min-h-9 flex-1 resize-none rounded-lg border border-gray-800 bg-gray-800 px-3 py-2 text-sm text-fg placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500/60"
        />
        <button
          onClick={submit}
          disabled={!draft.trim()}
          className="bg-primary-500 text-white hover:bg-primary-600 shrink-0 rounded-lg px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('chat.send')}
        </button>
      </div>
    </aside>
  )
}
