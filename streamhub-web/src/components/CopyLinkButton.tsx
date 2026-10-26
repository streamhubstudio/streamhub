/**
 * CopyLinkButton — a small "copy this page's link" affordance.
 *
 * Copies an absolute URL to the clipboard and flips to a transient "copied"
 * confirmation. Used on the Studio App page header so the canonical deep link
 * (…/studio/:id/:section) can be shared to reproduce the exact view. Falls back
 * to a hidden textarea + execCommand when the async Clipboard API is
 * unavailable (older browsers / insecure origins), so it works under the e2e
 * core served over http too.
 */
import { useState } from 'react'
import { HiOutlineLink, HiOutlineCheck } from 'react-icons/hi'

async function copyToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    /* fall through to the legacy path */
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand('copy')
  } finally {
    document.body.removeChild(ta)
  }
}

export function CopyLinkButton({
  url,
  label,
  copiedLabel,
  className = '',
}: {
  url: string
  /** Accessible label + tooltip for the idle state. */
  label: string
  /** Accessible label shown briefly after a successful copy. */
  copiedLabel: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  async function onCopy() {
    await copyToClipboard(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      title={copied ? copiedLabel : label}
      aria-label={copied ? copiedLabel : label}
      data-testid="copy-link"
      className={[
        'inline-flex items-center gap-1 align-middle text-fg-subtle transition',
        'hover:text-primary-600 dark:hover:text-primary-400',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {copied ? (
        <HiOutlineCheck aria-hidden className="text-base text-primary-500" />
      ) : (
        <HiOutlineLink aria-hidden className="text-base" />
      )}
    </button>
  )
}
