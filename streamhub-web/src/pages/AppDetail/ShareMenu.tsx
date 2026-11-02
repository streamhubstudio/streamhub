/**
 * "Compartir" — per-stream share menu for the En vivo (Streams) tab.
 *
 * A compact popover with copy-to-clipboard actions for every PUBLIC playback
 * surface of a room:
 *   - the /play player page URL,
 *   - the /embed <iframe> snippet,
 *   - the public HLS playlist (`/hls/<app>/<room>/index.m3u8`),
 *   - a self-contained video.js embed over that playlist.
 *
 * Private-playback apps (G2): their /hls needs a `?st=` token, so the plain
 * HLS URL above only plays for public apps; "Signed HLS URL" mints it through
 * api.playTokenSign (the core returns `hlsUrl` with the token for a private
 * app, nothing for a public one — then the plain URL is copied).
 *
 * URLs derive from window.location.origin (same convention as the Player
 * SharePanel — the core returns relative URLs unless PUBLIC_BASE_URL is set,
 * and the dashboard knows its own origin). Works for passthrough rows too:
 * everything here is plain URL building, no LiveKit involved.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/api'
import {
  embedIframeSnippet,
  hlsEmbedSnippet,
  hlsPlaylistUrl,
  publicEmbedUrl,
  publicPlayerUrl,
  signedEmbedIframe,
} from '@/lib/share'
import { Button, useCopy } from './ui'

/** The core returns relative URLs unless PUBLIC_BASE_URL is set. */
function absolutize(origin: string, url: string): string {
  return /^https?:\/\//i.test(url) ? url : `${origin.replace(/\/+$/, '')}${url}`
}

export function ShareMenu({ app, room }: { app: string; room: string }) {
  const { t } = useTranslation(['streamsTab', 'common'])
  const [open, setOpen] = useState(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [signing, setSigning] = useState<'signed' | 'signedHls' | null>(null)
  const [signError, setSignError] = useState(false)
  const [copied, copy] = useCopy()
  const rootRef = useRef<HTMLDivElement>(null)

  // Close on outside click (simple inline popover — no portal).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const hlsUrl = hlsPlaylistUrl(origin, app, room)

  // Signed (expiring) embed — required to embed a PRIVATE-playback app. Mints a
  // scoped capability server-side (api.playTokenSign, stream:read) and copies a
  // tokenized <iframe>. The token is an app+room HMAC, NEVER an sk_/JWT bearer.
  async function copySigned(kind: 'signed' | 'signedHls') {
    setSignError(false)
    setSigning(kind)
    try {
      const signed = await api.playTokenSign(app, room)
      copy(
        kind === 'signed'
          ? signedEmbedIframe(origin, app, room, signed.exp, signed.sig)
          : signed.hlsUrl
            ? absolutize(origin, signed.hlsUrl)
            : hlsUrl,
      )
      setCopiedKey(kind)
    } catch {
      setSignError(true)
    } finally {
      setSigning(null)
    }
  }

  const items = [
    { key: 'player', label: t('share.playerUrl'), value: publicPlayerUrl(origin, app, room) },
    { key: 'iframe', label: t('share.iframe'), value: embedIframeSnippet(publicEmbedUrl(origin, app, room)) },
    { key: 'hls', label: t('share.hlsUrl'), value: hlsUrl },
    { key: 'videojs', label: t('share.videojs'), value: hlsEmbedSnippet(hlsUrl) },
  ] as const

  return (
    <div ref={rootRef} className="relative inline-block">
      <Button
        variant="ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {t('share.button')}
      </Button>
      {open && (
        <div
          role="menu"
          aria-label={t('share.title')}
          className="absolute right-0 z-20 mt-1 w-60 rounded-lg border p-1 text-left shadow-lg border-gray-600 bg-gray-800"
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              onClick={() => {
                copy(item.value)
                setCopiedKey(item.key)
              }}
              className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-1.5 text-xs transition text-gray-100 hover:bg-gray-700"
            >
              <span className="truncate">{item.label}</span>
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-gray-400">
                {copied && copiedKey === item.key
                  ? t('common:actions.copied')
                  : t('common:actions.copy')}
              </span>
            </button>
          ))}

          {/* Signed embed / HLS URL (expiring) — for private-playback apps. */}
          {(['signed', 'signedHls'] as const).map((kind, i) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              disabled={signing !== null}
              onClick={() => void copySigned(kind)}
              className={`${i === 0 ? 'mt-1 border-t ' : ''}flex w-full items-center justify-between gap-2 rounded-md px-3 py-1.5 text-xs transition disabled:opacity-60 border-gray-700 text-gray-100 hover:bg-gray-700`}
            >
              <span className="truncate">
                {t(kind === 'signed' ? 'share.signedEmbed' : 'share.signedHls')}
              </span>
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-gray-400">
                {signing === kind
                  ? t('share.signing')
                  : signError
                    ? t('share.signError')
                    : copied && copiedKey === kind
                      ? t('common:actions.copied')
                      : t('common:actions.copy')}
              </span>
            </button>
          ))}
          <p className="px-3 py-1 text-[10px] text-gray-500">
            {t('share.signedEmbedHelp')}
          </p>
        </div>
      )}
    </div>
  )
}
