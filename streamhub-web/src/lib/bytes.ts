/**
 * Human-readable byte formatting (binary units) — shared across surfaces
 * (Dashboard cards, AppDetail header). Pure, dependency-free, easy to test.
 */

/**
 * Format a byte count as a readable string using binary units (KB = 1024 B).
 * Tolerates undefined/NaN/negatives (renders the `empty` placeholder). Values
 * below 1 KB show as bytes; from KB up, one decimal until >= 100 of a unit.
 */
export function formatBytes(
  bytes: number | undefined | null,
  empty = '—',
): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return empty
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  const digits = value >= 100 || i === 0 ? 0 : 1
  return `${value.toFixed(digits)} ${units[i]}`
}
