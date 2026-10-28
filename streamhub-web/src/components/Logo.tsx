/**
 * StreamHub logo — the brand cloud mark (/favicon.svg, the exact DigitalHub
 * mark) + the "StreamHub" wordmark set as live text in the app font.
 *
 * The old /logo-*.svg drew the wordmark as an SVG <text> inside an <img>,
 * where the page's Inter isn't available: on hosts without Inter the fallback
 * face is wider than the 300-unit viewBox and the name was clipped
 * ("StreamHul"). Live text can't overflow that way.
 *
 * Size it with a Tailwind height class (`h-7`, `h-9`…): the wordmark scales
 * from that height.
 */
export function Logo({ className }: { className?: string }) {
  const cls = className ?? ''
  const m = cls.match(/(?:^|\s)h-(\d+(?:\.\d+)?)(?:\s|$)/)
  const heightPx = m ? Number(m[1]) * 4 : 36
  return (
    <span
      role="img"
      aria-label="StreamHub"
      className={`inline-flex shrink-0 items-center whitespace-nowrap ${cls}`}
      style={{ gap: heightPx * 0.22, height: heightPx }}
    >
      <img src="/favicon.svg" alt="" aria-hidden="true" className="h-full w-auto" />
      <span
        aria-hidden="true"
        className="font-extrabold leading-none text-fg"
        style={{ fontSize: heightPx * 0.56, letterSpacing: '-0.035em' }}
      >
        StreamHub
      </span>
    </span>
  )
}
