import type { ChallengeDetail, ChallengeSummary } from '@koydum/shared';

import { StorageKeys, getJson, removeItem, setJson } from '@/lib/storage';
import { currentOwnerId } from '@/services/offlineQueue';

/**
 * The last detail of each check-in çelınc I play, kept on the phone.
 *
 * The morning "Geldim" is pressed in the app the reminder opens, and by then
 * the phone has usually killed it overnight: react-query's memory is empty.
 * With the owner's PC asleep, or no signal, the screen had nothing to draw,
 * and "Çelınc gelmedi" left no button to park the tap with
 * (services/offlineQueue). From this copy it draws the çelınc as it last was,
 * says so, and parks the tap with its time and the çelınc's own zone.
 *
 * Only check-in çelıncs: their tap is a time of day, the one entry nobody can
 * type in later. Only running or about to start, only while I am in it, and
 * only for the account that read it: a second account on the phone must never
 * be shown the first one's çelınc. A logout takes it all (services/session).
 *
 * A copy is written when the çelınc's screen reads the detail, and kept up to
 * date from the çelınc list the reminders are set from (`syncSavedWithList`).
 */

/** A handful at once is plenty; each detail is a few tens of KB at most (60 days, 40 feed rows). */
const MAX_SAVED = 5;

interface SavedDetails {
  /** the account they were read with (the stored profile's id) */
  ownerId: string;
  /** most recently saved first */
  details: ChallengeDetail[];
}

let chain: Promise<unknown> = Promise.resolve();

/**
 * One read-modify-write at a time: two details saved together would each
 * write back the list without the other. A logout's clear also waits for a
 * save still running, which would otherwise write the list back after it.
 */
function serially<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => {});
  return run;
}

/** Worth keeping for `ownerId`: a check-in çelınc they still play, before its end. */
function keeps(detail: Pick<ChallengeSummary, 'challenge' | 'me'>, ownerId: string, now: number): boolean {
  const { challenge, me } = detail;
  return (
    challenge.metricType === 'checkin_deadline' &&
    (challenge.status === 'pending' || challenge.status === 'active') &&
    // a detail fetched with the previous account's token, landing after the switch
    me?.user.id === ownerId &&
    me.status === 'accepted' &&
    Date.parse(challenge.endsAt) > now
  );
}

async function readSaved(ownerId: string): Promise<ChallengeDetail[]> {
  const stored = await getJson<SavedDetails>(StorageKeys.savedDetails);
  if (!stored || stored.ownerId !== ownerId || !Array.isArray(stored.details)) return [];
  // written by an older build, or cut short: the screen must not throw on it
  return stored.details.filter(
    (detail) => typeof detail?.challenge?.id === 'string' && Array.isArray(detail.participants)
  );
}

/**
 * Keeps `detail` as the last one seen, or forgets it once it is nothing to
 * keep (finished, cancelled, left), along with any other whose end passed.
 */
export function saveChallengeDetail(detail: ChallengeDetail, now: number = Date.now()): Promise<void> {
  return serially(async () => {
    const ownerId = await currentOwnerId();
    // signed out meanwhile: nothing of that account may stay behind
    if (!ownerId) return;
    const saved = await readSaved(ownerId);
    const keep = keeps(detail, ownerId, now);
    const others = saved.filter((item) => item.challenge.id !== detail.challenge.id && keeps(item, ownerId, now));
    // most details are no check-in: their refetch every 45 s has nothing to change here
    if (!keep && others.length === saved.length) return;
    const next = keep ? [detail, ...others].slice(0, MAX_SAVED) : others;
    await setJson(StorageKeys.savedDetails, { ownerId, details: next } satisfies SavedDetails);
  });
}

/**
 * Brings the kept copies up to date with the çelınc list (`GET /challenges`)
 * and answers which check-in çelınclar I play have no copy yet. The list is
 * what the morning reminders are set from (services/reminders: every
 * foreground, the background task, every yes on this phone); a copy written
 * only when the screen was opened went stale. The creator who did not open
 * the çelınc again after the second yes woke to "Kabul bekleniyor 1/2" from
 * it and no Geldim, and a friend who said yes on the home card had no copy at
 * all. A row brings the çelınc, the players and me; the rest of a copy (its
 * feed, my entries) stays as the screen read it.
 */
export function syncSavedWithList(summaries: readonly ChallengeSummary[], now: number = Date.now()): Promise<string[]> {
  return serially(async () => {
    const ownerId = await currentOwnerId();
    if (!ownerId) return [];
    const saved = await readSaved(ownerId);
    const rows = new Map(summaries.map((row) => [row.challenge.id, row]));
    const next = saved
      .map((detail): ChallengeDetail => {
        const row = rows.get(detail.challenge.id);
        if (!row) return detail;
        return {
          ...detail,
          challenge: row.challenge,
          participants: row.participants,
          me: row.me,
          unreadTaunts: row.unreadTaunts,
          // an older server's list leaves these out; the detail had them
          myTimezone: row.myTimezone ?? detail.myTimezone,
          // and the days I am scored on: a screen drawn from this copy offers no
          // "Geldim" on a deadline the server refuses
          myDays: row.myDays ?? detail.myDays,
        };
      })
      .filter((detail) => keeps(detail, ownerId, now));
    if (JSON.stringify(next) !== JSON.stringify(saved)) {
      await setJson(StorageKeys.savedDetails, { ownerId, details: next } satisfies SavedDetails);
    }
    return summaries
      .filter((row) => keeps(row, ownerId, now) && !saved.some((detail) => detail.challenge.id === row.challenge.id))
      .map((row) => row.challenge.id)
      .slice(0, MAX_SAVED);
  });
}

/** The last detail of çelınc `id` this account saw, if it is kept. */
export function savedChallengeDetail(id: string): Promise<ChallengeDetail | null> {
  return serially(async () => {
    const ownerId = await currentOwnerId();
    if (!ownerId) return null;
    return (await readSaved(ownerId)).find((detail) => detail.challenge.id === id) ?? null;
  });
}

/**
 * Every copy this account still has a use for, for a home whose list did not
 * come. Opened from the launcher rather than the reminder, a cold app with
 * the PC asleep had only "Liste gelmedi" there, and the "Geldim" these copies
 * exist for was out of reach: the parked tap is judged by when it was
 * pressed, so waiting for the server cost the morning.
 */
export function savedChallengeDetails(now: number = Date.now()): Promise<ChallengeDetail[]> {
  return serially(async () => {
    const ownerId = await currentOwnerId();
    if (!ownerId) return [];
    // a copy whose end passed since it was saved has no "Geldim" left to take
    return (await readSaved(ownerId)).filter((detail) => keeps(detail, ownerId, now));
  });
}

/** The server says çelınc `id` is not mine (any more): its copy goes. */
export function dropSavedChallengeDetail(id: string): Promise<void> {
  return serially(async () => {
    const ownerId = await currentOwnerId();
    if (!ownerId) return;
    const saved = await readSaved(ownerId);
    const next = saved.filter((detail) => detail.challenge.id !== id);
    if (next.length === saved.length) return;
    await setJson(StorageKeys.savedDetails, { ownerId, details: next } satisfies SavedDetails);
  });
}

/** Every saved detail goes with the session (logout, account deletion, a 401 in the background). */
export function forgetSavedChallengeDetails(): Promise<void> {
  return serially(() => removeItem(StorageKeys.savedDetails));
}
