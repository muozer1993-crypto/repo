import type { ChallengeDetail } from '@koydum/shared';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { StorageKeys, getItem, setJson } from '@/lib/storage';
import {
  dropSavedChallengeDetail,
  forgetSavedChallengeDetails,
  saveChallengeDetail,
  savedChallengeDetail,
  syncSavedWithList,
} from '@/services/savedDetails';
import { forgetStoredSession } from '@/services/session';

/**
 * The phone keeps the last detail of a check-in çelınc so a cold start with
 * no connection can still draw it and park the morning "Geldim". It is one
 * account's: a second account on the phone must never be shown it.
 */

const NOW = Date.parse('2026-09-09T03:30:00.000Z');

function signIn(id: string): Promise<void> {
  return setJson(StorageKeys.me, { id, username: id });
}

function detail(
  id: string,
  options: { metricType?: string; status?: string; me?: string; meStatus?: string; endsAt?: string } = {}
): ChallengeDetail {
  const player = {
    user: { id: options.me ?? 'me-1', username: 'mustafa', displayName: 'Mustafa' },
    status: options.meStatus ?? 'accepted',
    score: 0,
    days: 0,
    rank: 1,
  };
  return {
    challenge: {
      id,
      typeKey: 'erken_kus',
      metricType: options.metricType ?? 'checkin_deadline',
      status: options.status ?? 'active',
      title: `Çelınc ${id}`,
      startsAt: '2026-09-08T01:00:00.000Z',
      endsAt: options.endsAt ?? '2026-09-15T21:00:00.000Z',
    },
    participants: [player],
    me: player,
    myTimezone: 'Europe/Istanbul',
    myEntries: [],
    feed: [],
  } as unknown as ChallengeDetail;
}

beforeEach(async () => {
  await AsyncStorage.clear();
  await signIn('me-1');
});

describe('saved check-in details', () => {
  it('keeps a running check-in çelınc I play and gives it back', async () => {
    await saveChallengeDetail(detail('c-1'), NOW);
    expect((await savedChallengeDetail('c-1'))?.challenge.title).toBe('Çelınc c-1');
    expect((await savedChallengeDetail('c-1'))?.myTimezone).toBe('Europe/Istanbul');
    expect(await savedChallengeDetail('c-2')).toBeNull();
  });

  it('keeps one about to start, but nothing else', async () => {
    await saveChallengeDetail(detail('pending', { status: 'pending' }), NOW);
    await saveChallengeDetail(detail('steps', { metricType: 'auto_steps' }), NOW);
    await saveChallengeDetail(detail('invite', { meStatus: 'invited' }), NOW);
    await saveChallengeDetail(detail('over', { endsAt: '2026-09-09T03:00:00.000Z' }), NOW);

    expect(await savedChallengeDetail('pending')).not.toBeNull();
    expect(await savedChallengeDetail('steps')).toBeNull();
    expect(await savedChallengeDetail('invite')).toBeNull();
    expect(await savedChallengeDetail('over')).toBeNull();
  });

  it('forgets one once it is over, left or gone', async () => {
    for (const id of ['done', 'left', 'gone']) await saveChallengeDetail(detail(id), NOW);

    await saveChallengeDetail(detail('done', { status: 'finished' }), NOW);
    await saveChallengeDetail(detail('left', { meStatus: 'left' }), NOW);
    await dropSavedChallengeDetail('gone');

    for (const id of ['done', 'left', 'gone']) expect(await savedChallengeDetail(id)).toBeNull();
  });

  it('keeps at most five, the most recently seen', async () => {
    for (let i = 1; i <= 5; i++) await saveChallengeDetail(detail(`c-${i}`), NOW);
    // seen again: it moves to the front, and the next one pushes out c-2 instead
    await saveChallengeDetail(detail('c-1'), NOW);
    await saveChallengeDetail(detail('c-6'), NOW);
    await saveChallengeDetail(detail('c-7'), NOW);

    const kept = [];
    for (let i = 1; i <= 7; i++) if (await savedChallengeDetail(`c-${i}`)) kept.push(`c-${i}`);
    expect(kept).toEqual(['c-1', 'c-4', 'c-5', 'c-6', 'c-7']);
  });

  it("never gives one account's çelınc to another signed in on the same phone", async () => {
    await saveChallengeDetail(detail('c-1'), NOW);

    await signIn('me-2');
    expect(await savedChallengeDetail('c-1')).toBeNull();

    // a fetch made with the first account's token that lands after the switch
    await saveChallengeDetail(detail('c-1', { me: 'me-1' }), NOW);
    expect(await savedChallengeDetail('c-1')).toBeNull();
  });

  it('writes nothing when signed out', async () => {
    await AsyncStorage.removeItem(StorageKeys.me);
    await saveChallengeDetail(detail('c-1'), NOW);
    expect(await getItem(StorageKeys.savedDetails)).toBeNull();
  });

  it('goes with the session, after a save still running', async () => {
    await saveChallengeDetail(detail('c-1'), NOW);
    const late = saveChallengeDetail(detail('c-2'), NOW);
    await forgetStoredSession();
    await late;

    expect(await getItem(StorageKeys.savedDetails)).toBeNull();
  });

  it('follows the çelınc list the reminders are set from, and names the ones it has no copy of', async () => {
    // saved the evening it was made: Ali had not said yes yet
    const created = detail('c-1', { status: 'pending' });
    const ali = { ...created.me!, user: { id: 'u-2', username: 'ali', displayName: 'Ali' }, status: 'invited' };
    await saveChallengeDetail({ ...created, participants: [created.me!, ali] } as ChallengeDetail, NOW);

    // the list after his yes, and a second check-in said yes to on the home card
    const yes = { ...ali, status: 'accepted' };
    const other = detail('c-2', { status: 'pending' });
    const list = [
      { challenge: created.challenge, participants: [created.me!, yes], me: created.me, unreadTaunts: 0 },
      { challenge: other.challenge, participants: other.participants, me: other.me, unreadTaunts: 0 },
      // neither a check-in nor mine: nothing to keep
      { ...detail('steps', { metricType: 'auto_steps' }), unreadTaunts: 0 },
    ] as unknown as ChallengeDetail[];

    expect(await syncSavedWithList(list, NOW)).toEqual(['c-2']);
    const kept = await savedChallengeDetail('c-1');
    expect(kept?.participants.map((p) => p.status)).toEqual(['accepted', 'accepted']);
    // the rest of the copy stays as the screen read it
    expect(kept?.myTimezone).toBe('Europe/Istanbul');
    expect(kept?.feed).toEqual([]);

    // a row that says I left takes the copy with it
    await syncSavedWithList([{ ...list[0]!, me: { ...created.me!, status: 'left' } }], NOW);
    expect(await savedChallengeDetail('c-1')).toBeNull();
  });

  it('clears on its own too', async () => {
    await saveChallengeDetail(detail('c-1'), NOW);
    await forgetSavedChallengeDetails();
    expect(await getItem(StorageKeys.savedDetails)).toBeNull();
  });
});
