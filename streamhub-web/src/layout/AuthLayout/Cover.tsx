/**
 * Auth "Cover" layout — ported from Elstar (AuthLayout/Cover.tsx) and re-skinned
 * to the StreamHub brand.
 *
 * Two columns on >=lg: a brand panel on the left, the auth form on the right.
 * The brand panel is a layered stage — a deep cyan→blue gradient with soft
 * corner glows, an animated wired-network backdrop (<WiredCables>: nodes joined
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
            'linear-gradient(150deg, #081b47 0%, #103a86 46%, #2f7bff 100%)',
        }}
      >
        {/* Corner glows for depth. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(900px 720px at 10% 4%, rgba(34,182,240,0.45), transparent 55%),' +
              'radial-gradient(1000px 820px at 96% 104%, rgba(47,123,255,0.5), transparent 55%)',
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

        {/* /logo-dark.svg = the light wordmark, for dark backgrounds. */}
        <img
          src="/logo-dark.svg"
          alt="StreamHub"
          className="relative z-10 h-14 w-auto drop-shadow-[0_4px_24px_rgba(34,182,240,0.5)]"
        />
        <div className="relative z-10">
          <h3 className="mb-4 text-4xl font-bold leading-tight text-white drop-shadow-[0_2px_12px_rgba(6,15,45,0.35)]">
            {panelTitle}
          </h3>
          <p className="max-w-[560px] text-lg text-white/85">{panelText}</p>
        </div>
        <span className="relative z-10 text-sm text-white/75">
          &copy; {new Date().getFullYear()}{' '}
          <span className="font-semibold">StreamHub</span>
        </span>
      </div>

      {/* Form panel */}
      <div className="flex flex-col items-center justify-center bg-surface px-6 py-12">
        <div className="w-full max-w-[380px] xl:max-w-[420px]">
          {content && <div className="mb-8">{content}</div>}
          {children}
        </div>
      </div>
    </div>
  )
}
