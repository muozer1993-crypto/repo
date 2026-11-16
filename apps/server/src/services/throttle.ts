/**
 * A tiny in-process attempt limiter for the unauthenticated endpoints.
 *
 * `POST /auth/login` and `POST /auth/register` each burn one scrypt derivation
 * (~70 ms on the shared libuv pool) before they can answer, so without a cap a
 * stranger can keep every worker busy — and grind through passwords — for free.
 * No dependency is needed for this: a sliding window of timestamps per key is
 * enough, and the whole thing lives in the process (one server, one SQLite file).
 *
 * Keys are caller-chosen (`clientKey(ip)`, `<client>|<username>`, an account);
 * nothing here is persisted, so a restart forgives everybody — deliberately, since
 * the cost of a false positive (a locked-out friend) is higher than that of a slow
 * attacker.
 *
 * The table is capped, and what it drops when full is what decides whether the cap
 * is a hole: it used to drop the key it had seen first, so 5,000 throwaway keys
 * (half a minute of logins) unlocked any account. Now it forgives the key with the
 * fewest hits, the least recently hit of those first: a flood of fresh keys pushes
 * out other fresh keys, never one somebody has been guessing at.
 */
import { isIP } from 'node:net';

/** Never track more keys than this; see the header for which one goes first. */
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
    // A Map iterates in insertion order: re-inserting keeps it ordered from least
    // to most recently hit, which evict() uses to break ties.
    this.hits.delete(key);
    this.hits.set(key, list);
    if (this.hits.size > MAX_KEYS) this.evict(at, key);
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

  private evict(at: number, keep: string): void {
    for (const [key, list] of this.hits) {
      if (list.length === 0 || at - (list[list.length - 1] ?? 0) >= this.windowMs) this.hits.delete(key);
    }
    // Still full: forgive the key with the fewest hits; the strict `<` over the
    // recency order picks the least recently hit of those. Wiping an attacked key
    // now takes 5,000 keys with as many hits as it has, not 5,000 single guesses.
    // Stored lists can still hold expired hits; that only keeps a key a little
    // longer, never forgives one early.
    while (this.hits.size > MAX_KEYS) {
      let victim: string | undefined;
      let fewest = Number.POSITIVE_INFINITY;
      for (const [key, list] of this.hits) {
        if (key !== keep && list.length < fewest) {
          victim = key;
          fewest = list.length;
        }
      }
      if (victim === undefined) break;
      this.hits.delete(victim);
    }
  }
}

/**
 * The bucket an address is throttled in. Behind cloudflared every request comes
 * from 127.0.0.1 and `request.ip` is the client from X-Forwarded-For, and one IPv6
 * customer is handed a whole /64 (2^64 addresses), so a per-address budget let a
 * single phone rotate through fresh addresses for as long as it liked. An IPv6
 * address therefore counts as its /64 (`2001:db8:0:0::/64`), and an IPv4 one
 * written as IPv6 (`::ffff:203.0.113.7`) as the plain IPv4 it is. Anything else,
 * IPv4 included, is its own key.
 *
 * `request.ip` is undefined, whatever its type says, once the client has reset the
 * connection: the socket has no peer left to name. Those share one key (their
 * answer goes nowhere); throwing here made every such login a 500 and two lines in
 * the owner's window, for anybody who cared to send them.
 */
export function clientKey(ip: string | undefined): string {
  if (ip === undefined) return '';
  // a link-local address carries its interface: `fe80::1%eth0`
  const bare = ip.split('%')[0] ?? ip;
  if (isIP(bare) !== 6) return ip;
  const groups = hextets(bare);
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff].join('.');
  }
  // parsed and printed again, so `0DB8` and `db8` share a bucket
  return `${[g0, g1, g2, g3].map((g) => g.toString(16)).join(':')}::/64`;
}

/** The eight 16-bit groups of an address `isIP` already called IPv6. */
function hextets(ip: string): number[] {
  const parse = (part: string): number[] =>
    part === ''
      ? []
      : part.split(':').flatMap((group) => {
          // an IPv4 tail (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`) fills the last two
          if (!group.includes('.')) return [parseInt(group, 16)];
          const [a = 0, b = 0, c = 0, d = 0] = group.split('.').map(Number);
          return [(a << 8) | b, (c << 8) | d];
        });
  const [head = '', tail] = ip.split('::');
  const front = parse(head);
  const back = tail === undefined ? [] : parse(tail);
  return [...front, ...new Array<number>(Math.max(0, 8 - front.length - back.length)).fill(0), ...back];
}

/**
 * Turkish wait text for a 429 (`tooMany`), rounded up to whole seconds. Past an
 * hour and a half it is hours: the server's day of photos (routes/uploads.ts)
 * waits up to 24 of them, and "1440 dakika" is nobody's way of saying a day.
 */
export function retryAfterText(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} saniye sonra tekrar dene.`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes <= 90) return `${minutes} dakika sonra tekrar dene.`;
  return `${Math.ceil(minutes / 60)} saat sonra tekrar dene.`;
}
