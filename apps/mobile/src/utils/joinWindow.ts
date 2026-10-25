import type { Challenge } from '@koydum/shared';
import { acceptClosesAt } from '@koydum/shared';

type JoinFields = Pick<Challenge, 'status' | 'startsAt' | 'endsAt' | 'acceptClosesAt'>;

/**
 * When a çelınc stops taking players (epoch ms): the instant the server sent
 * with it, or, from an older server that sends none, the shared rule the server
 * runs. NaN for dates neither can read.
 */
export function joinClosesAt(challenge: Omit<JoinFields, 'status'>): number {
  const sent = challenge.acceptClosesAt ? Date.parse(challenge.acceptClosesAt) : Number.NaN;
  return Number.isFinite(sent) ? sent : acceptClosesAt(challenge.startsAt, challenge.endsAt);
}

/**
 * Whether a yes, or the creator's "Kanka ekle", can still go through at `clock`:
 * the accept and invite routes' own checks, pending or active and before
 * `joinClosesAt` (which is never past the end, so never in the settle hour).
 * Past it a "Kabul" or "Varım" only ever earned a 400 `accept_closed`.
 *
 * `clock` is a pure read, the last fetch's time, never `Date.now()` in render
 * (the React Compiler treats that as impure).
 */
export function stillJoinable(challenge: JoinFields, clock: number): boolean {
  return (challenge.status === 'pending' || challenge.status === 'active') && clock < joinClosesAt(challenge);
}
