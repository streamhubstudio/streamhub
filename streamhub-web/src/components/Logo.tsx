/** StreamHub logo — cloud (exact DigitalHub mark) + wordmark. Swaps the wordmark
 *  variant by theme: dark wordmark on light bg, light wordmark on dark bg. */
export function Logo({ className }: { className?: string }) {
  const cls = className ?? ''
  return (
    <>
      <img src="/logo-dark.svg" alt="StreamHub" className={`hidden dark:block ${cls}`} />
      <img src="/logo-light.svg" alt="StreamHub" className={`block dark:hidden ${cls}`} />
    </>
  )
}
