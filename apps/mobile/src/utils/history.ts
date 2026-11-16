import type { ChallengeSummary } from '@koydum/shared';

/** Which chip of the history screen a past çelınc answers to. */
export type Outcome = 'won' | 'lost' | 'tie' | 'cancelled' | 'none';

function closedAt(summary: ChallengeSummary): number {
  const ms = new Date(summary.challenge.finalizedAt ?? summary.challenge.endsAt).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Finished and cancelled çelınclar, the one that closed last on top. Home shows
 * the first five of this and the history screen all of it, so the two agree.
 */
export function pastChallenges(list: readonly ChallengeSummary[]): ChallengeSummary[] {
  return list
    .filter((s) => s.challenge.status === 'finished' || s.challenge.status === 'cancelled')
    .sort((a, b) => closedAt(b) - closedAt(a));
}

/**
 * Read the way the server counts the Karne (services/stats), so a chip never
 * disagrees with "Koydum 3 / Yedim 2": a loss is somebody else's win in a
 * çelınc I actually played, or a place behind a shared first one. An invite I
 * never answered is none of these.
 */
export function outcomeOf(summary: ChallengeSummary, meId: string | null): Outcome {
  const { challenge, me } = summary;
  if (challenge.status === 'cancelled') return 'cancelled';
  if (challenge.status !== 'finished' || !me || me.status !== 'accepted') return 'none';
  // only the co-leaders drew; whoever finished behind a tie lost (services/stats too)
  if (challenge.isTie) return me.rank > 1 ? 'lost' : 'tie';
  if (!challenge.winnerId) return 'none';
  return challenge.winnerId === meId ? 'won' : 'lost';
}

/**
 * A çelınc both of us were in to the end. Somebody who said no or walked out
 * sits in the list with rank 0, which would read as them coming first.
 */
export function playedTogether(summary: ChallengeSummary, meId: string | null, otherId: string): boolean {
  const played = (id: string | null) =>
    summary.participants.some((p) => p.user.id === id && p.status === 'accepted');
  return played(meId) && played(otherId);
}

/**
 * The running çelınc a friend's profile talks about: one we are both in (one
 * already under way first), else one they have only been asked to. Anybody not
 * `accepted` sits at rank 0, so ranking me against an invitee said "geridesin"
 * about a race they never ran; one they said no to or left is none of theirs.
 */
export function liveRivalry(
  list: readonly ChallengeSummary[],
  meId: string | null,
  otherId: string
): { summary: ChallengeSummary; joined: boolean } | null {
  const open = list.filter(
    (s) =>
      (s.challenge.status === 'active' || s.challenge.status === 'pending') &&
      s.participants.some((p) => p.user.id === meId && p.status === 'accepted')
  );
  const both = (s: ChallengeSummary) => playedTogether(s, meId, otherId);
  const asked = (s: ChallengeSummary) =>
    s.participants.some((p) => p.user.id === otherId && p.status === 'invited');
  const running = (s: ChallengeSummary) => s.challenge.status === 'active';
  const pick =
    open.find((s) => running(s) && both(s)) ??
    open.find(both) ??
    open.find((s) => running(s) && asked(s)) ??
    open.find(asked);
  return pick ? { summary: pick, joined: both(pick) } : null;
}
