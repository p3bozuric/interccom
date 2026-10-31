// Restart backoff for the hub link. No imports: tests load this file straight into Node.

export const BACKOFF_START_MS = 2000
export const BACKOFF_MAX_MS = 60_000
export const STABLE_MS = 60_000

// `current` is the wait the next restart would use; `upForMs` is how long the link
// that just died stayed up (0 if it never linked). A link that held for STABLE_MS
// starts over at BACKOFF_START_MS. Returns this restart's wait and the one after it.
export function restartBackoff(current: number, upForMs: number): { wait: number; next: number } {
  const wait = upForMs >= STABLE_MS ? BACKOFF_START_MS : current
  return { wait, next: Math.min(wait * 2, BACKOFF_MAX_MS) }
}
