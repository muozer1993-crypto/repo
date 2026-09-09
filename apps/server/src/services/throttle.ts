/**
 * A tiny in-process attempt limiter for the unauthenticated endpoints.
 *
 * `POST /auth/login` and `POST /auth/register` each burn one scrypt derivation
 * (~70 ms on the shared libuv pool) before they can answer, so without a cap a
 * stranger can keep every worker busy — and grind through passwords — for free.
 * No dependency is needed for this: a sliding window of timestamps per key is
 * enough, and the whole thing lives in the process (one server, one SQLite file).
 *
 * Keys are caller-chosen (`<ip>`, `<ip>|<username>`); nothing here is persisted, so
 * a restart forgives everybody — deliberately, since the cost of a false positive
 * (a locked-out friend) is higher than that of a slow attacker.
 */

/** Never track more keys than this; the oldest window is dropped first. */
const MAX_KEYS = 5_000;

export class AttemptLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    /** Attempts allowed inside the window. */
    readonly max: number,
    /** Window length in milliseconds. */
    readonly windowMs: number,
  ) {}

  /** Milliseconds to wait before `key` may try again; 0 when it is under budget. */
  retryAfterMs(key: string, now: Date): number {
    const at = now.getTime();
    const list = this.live(key, at);
    if (list.length < this.max) return 0;
    return Math.max(1, this.windowMs - (at - (list[0] ?? at)));
  }

  /** Records one attempt against `key`. */
  record(key: string, now: Date): void {
    const at = now.getTime();
    const list = this.live(key, at);
    list.push(at);
    this.hits.set(key, list);
    if (this.hits.size > MAX_KEYS) this.evict(at);
  }

  /** Forgets `key` — a successful login clears the failures that led to it. */
  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Timestamps still inside the window (also prunes the stored list). */
  private live(key: string, at: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((t) => at - t < this.windowMs && t <= at);
    if (list.length === 0) this.hits.delete(key);
    else this.hits.set(key, list);
    return list;
  }

  private evict(at: number): void {
    for (const [key, list] of this.hits) {
      if (list.length === 0 || at - (list[list.length - 1] ?? 0) >= this.windowMs) this.hits.delete(key);
    }
    // Still full: drop insertion-order oldest keys until there is room again.
    for (const key of this.hits.keys()) {
      if (this.hits.size <= MAX_KEYS) break;
      this.hits.delete(key);
    }
  }
}

/** Turkish wait text for a 429 (`tooMany`), rounded up to whole seconds. */
export function retryAfterText(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} saniye sonra tekrar dene.`;
  return `${Math.ceil(seconds / 60)} dakika sonra tekrar dene.`;
}
