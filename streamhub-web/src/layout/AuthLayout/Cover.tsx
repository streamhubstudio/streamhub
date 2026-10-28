/**
 * Auth "Cover" layout — ported from Elstar (AuthLayout/Cover.tsx) and re-skinned
 * to the StreamHub brand.
 *
 * Two columns on >=lg: a brand panel on the left, the auth form on the right.
 * The brand panel is a layered stage — the console's rack-steel canvas with a
 * deep brand-blue floor and one cyan glow, an animated wired-network backdrop (<WiredCables>: nodes joined
 * by cables with light pulses streaming along them), and a legibility veil under
 * the foreground (big logo + marketing copy). Below lg it collapses to the form
 * only. Fully standalone — no redux / config provider — so the auth agent can
 * drop it around any form:
 *
 *   <Cover content={<Header/>} panelTitle="…" panelText="…">
 *     <SignInForm />
 *   </Cover>
 */
import type { ReactNode } from 'react'
import { WiredCables } from './WiredCables'
import { Logo } from '@/components/Logo'

export interface CoverProps {
  children?: ReactNode
  /** Rendered above the form (e.g. the SignIn heading). */
  content?: ReactNode
  /** Headline on the brand panel. */
  panelTitle?: ReactNode
  /** Body copy on the brand panel. */
  panelText?: ReactNode
  className?: string
}

export default function Cover({
  children,
  content,
  panelTitle = 'Streaming, on your terms.',
  panelText = 'StreamHub is your management layer over LiveKit — apps, tokens, recording and live players, all in one panel.',
  className,
}: CoverProps) {
  return (
    <div className={['grid h-full lg:grid-cols-3', className].filter(Boolean).join(' ')}>
      {/* Brand panel (>=lg) — layered stage. */}
      <div
        className="relative col-span-2 hidden flex-col justify-between overflow-hidden px-16 py-10 lg:flex"
        style={{
          background:
            'linear-gradient(165deg, #080b11 0%, #0c1424 52%, #0f2a63 100%)',
        }}
      >
        {/* Corner glows for depth. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(900px 720px at 8% 0%, rgba(34,182,240,0.16), transparent 55%),' +
              'radial-gradient(1000px 820px at 96% 104%, rgba(36,104,242,0.35), transparent 55%)',
          }}
        />
        {/* Animated wired-network signal backdrop. */}
        <WiredCables className="pointer-events-none absolute inset-0 h-full w-full opacity-80" />
        {/* Veil so the copy stays legible over the animation. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'linear-gradient(180deg, rgba(6,15,45,0.18) 0%, transparent 34%, rgba(6,15,45,0.4) 100%)',
          }}
        />

        <Logo className="relative z-10 h-14" />
        <div className="relative z-10">
          <h3 className="mb-4 max-w-[18ch] text-5xl font-semibold leading-[1.05] tracking-tight text-white">
            {panelTitle}
          </h3>
          <p className="max-w-[52ch] text-lg text-slate-300">{panelText}</p>
        </div>
        <span className="relative z-10 text-sm text-fg-subtle">
          &copy; {new Date().getFullYear()}{' '}
          <span className="font-semibold">StreamHub</span>
        </span>
      </div>

      {/* Form panel */}
      <div className="flex flex-col items-center justify-center border-l border-border bg-bg px-6 py-12">
        <div className="w-full max-w-[380px] xl:max-w-[420px]">
          {content && <div className="mb-8">{content}</div>}
          {children}
        </div>
      </div>
    </div>
  )
}
