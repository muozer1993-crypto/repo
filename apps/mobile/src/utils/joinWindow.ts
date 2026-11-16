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
 * Whether a yes, or a player's "Kanka ekle", can still go through at `clock`:
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

/**
 * Whether a çelınc the phone last saw `pending` is in fact running at `clock`:
 * past its start with two yeses, and not over. The server starts it on its
 * next pass, or on the first entry that reaches it (`activateDueChallenges`);
 * a detail read before that (the owner's PC asleep, no signal) still says
 * pending. The çelınc screen, the entry form and the focus timer all take
 * entries for it then, as for a running one, so none refuses what another
 * offered. `clock` is a pure read, as for `stillJoinable`.
 */
export function runningUnseen(
  challenge: Pick<Challenge, 'status' | 'startsAt' | 'endsAt'>,
  acceptedCount: number,
  clock: number
): boolean {
  const startsAt = Date.parse(challenge.startsAt);
  const endsAt = Date.parse(challenge.endsAt);
  return (
    challenge.status === 'pending' &&
    acceptedCount >= 2 &&
    Number.isFinite(startsAt) &&
    startsAt <= clock &&
    !(Number.isFinite(endsAt) && endsAt <= clock)
  );
}
