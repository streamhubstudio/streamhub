/**
 * Floating reaction overlay. Reactions bubble up from the bottom of the stage,
 * drift sideways and fade out. Each active reaction carries a randomised
 * horizontal offset / duration so bursts look organic.
 *
 * Keyframes are injected once via a scoped <style> tag so we don't touch the
 * shared index.css (owned by the scaffold).
 */
import { useEffect } from 'react'
import type { FloatingReaction } from './useAddonChannels'

interface ReactionsOverlayProps {
  reactions: FloatingReaction[]
  /** Called when a reaction's animation has finished so it can be reaped. */
  onExpire: (id: string) => void
}

function Bubble({
  reaction,
  onExpire,
}: {
  reaction: FloatingReaction
  onExpire: (id: string) => void
}) {
  useEffect(() => {
    const t = setTimeout(() => onExpire(reaction.id), reaction.duration)
    return () => clearTimeout(t)
  }, [reaction.id, reaction.duration, onExpire])

  return (
    <div
      className="pointer-events-none absolute bottom-2 flex flex-col items-center"
      style={{
        left: `${reaction.left}%`,
        animation: `streamhub-float ${reaction.duration}ms ease-out forwards`,
        ['--drift' as string]: `${reaction.drift}px`,
      }}
    >
      <span className="text-4xl drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)]">
        {reaction.emoji}
      </span>
      <span className="mt-0.5 max-w-24 truncate rounded-full bg-black/60 px-2 py-0.5 text-[10px] text-white/80">
        {reaction.sender}
      </span>
    </div>
  )
}

export function ReactionsOverlay({ reactions, onExpire }: ReactionsOverlayProps) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      <style>{`
        @keyframes streamhub-float {
          0%   { transform: translate(0, 0) scale(0.6); opacity: 0; }
          12%  { transform: translate(0, -10%) scale(1.1); opacity: 1; }
          100% { transform: translate(var(--drift, 0px), -75vh) scale(1); opacity: 0; }
        }
      `}</style>
      {reactions.map((r) => (
        <Bubble key={r.id} reaction={r} onExpire={onExpire} />
      ))}
    </div>
  )
}
