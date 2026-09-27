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
 * çelınc I actually played. An invite I never answered is none of these.
 */
export function outcomeOf(summary: ChallengeSummary, meId: string | null): Outcome {
  const { challenge, me } = summary;
  if (challenge.status === 'cancelled') return 'cancelled';
  if (challenge.status !== 'finished' || !me || me.status !== 'accepted') return 'none';
  if (challenge.isTie) return 'tie';
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
