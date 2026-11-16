import type { Notification } from '@koydum/shared';
import { QueryClient } from '@tanstack/react-query';

import { invalidateForNotifications } from '@/hooks/queries';
import { qk } from '@/lib/query';
import { useAuth } from '@/store/auth';

/**
 * A new notification has to move the lists it is about. Without push, the
 * inbox poll is the only one that hears of it, and the tabs stay mounted with
 * nothing refetching them: the badge said 1 while Gelen and "Gelen istekler"
 * still showed the old lists.
 */

function row(type: Notification['type'], data: Record<string, unknown> = {}): Notification {
  return {
    id: `n-${type}`,
    type,
    title: 'KOYDUM',
    body: 'gövde',
    data,
    readAt: null,
    createdAt: '2026-09-27T10:00:00.000Z',
  };
}

function invalidatedKeys(items: Parameters<typeof invalidateForNotifications>[1]): unknown[] {
  const client = new QueryClient();
  const spy = jest.spyOn(client, 'invalidateQueries');
  invalidateForNotifications(client, items);
  const keys = spy.mock.calls.map(([filters]) => filters?.queryKey);
  client.clear();
  return keys;
}

describe('invalidateForNotifications', () => {
  it('moves the friends list, the inbox and the badge for a friend request', () => {
    const keys = invalidatedKeys([row('friend_request', { friendshipId: 'f1' })]);
    expect(keys).toEqual(expect.arrayContaining([qk.friends, qk.inbox, qk.unread]));
    expect(keys).not.toContainEqual(['challenges']);
  });

  it('moves the çelınc, its results and the lists for a taunt', () => {
    const keys = invalidatedKeys([row('taunt', { challengeId: 'c1', tauntId: 't1' })]);
    expect(keys).toEqual(
      expect.arrayContaining([qk.challenge('c1'), qk.results('c1'), ['challenges'], qk.inbox, qk.unread])
    );
    expect(keys).not.toContainEqual(qk.friends);
  });

  it('moves the results of the çelınc a rematch is of, so its "Rövanş" becomes a link', () => {
    const keys = invalidatedKeys([row('rematch', { challengeId: 'c2', rematchOfId: 'c1', fromUserId: 'u1' })]);
    expect(keys).toEqual(expect.arrayContaining([qk.challenge('c2'), qk.results('c1'), qk.challenge('c1')]));
  });

  it('reads a push payload the same way, with the çelınc on top of the data', () => {
    const keys = invalidatedKeys([
      { type: 'friend_accepted', data: { type: 'friend_accepted', notificationId: 'n1' } },
      { type: 'poke', data: { type: 'poke', challengeId: 'c2', notificationId: 'n2' } },
    ]);
    expect(keys).toEqual(expect.arrayContaining([qk.friends, qk.challenge('c2'), qk.results('c2')]));
  });

  it('asks for each çelınc once however many rows name it', () => {
    const keys = invalidatedKeys([
      row('taunt', { challengeId: 'c1' }),
      row('challenge_finished', { challengeId: 'c1' }),
    ]);
    expect(keys.filter((key) => JSON.stringify(key) === JSON.stringify(qk.challenge('c1')))).toHaveLength(1);
    expect(keys.filter((key) => JSON.stringify(key) === JSON.stringify(['challenges']))).toHaveLength(1);
  });

  it('still moves the inbox and the badge for a row about nothing else', () => {
    expect(invalidatedKeys([row('recap', { weekKey: '2026-09-27' })])).toEqual([qk.inbox, qk.unread]);
  });

  // The profile tab stays mounted and nothing else refetches the board: a
  // finish left Sıralama in the old order until a pull-to-refresh.
  it('moves the leaderboard for a finish, a rozet and a new kanka', () => {
    expect(invalidatedKeys([row('challenge_finished', { challengeId: 'c1' })])).toContainEqual(qk.leaderboard);
    expect(invalidatedKeys([row('badge', { badgeKey: 'ilk_kan' })])).toContainEqual(qk.leaderboard);
    expect(invalidatedKeys([row('friend_accepted', { friendshipId: 'f1' })])).toContainEqual(qk.leaderboard);
  });

  it('leaves the leaderboard alone for rows that move no wins or losses', () => {
    expect(invalidatedKeys([row('taunt', { challengeId: 'c1', tauntId: 't1' })])).not.toContainEqual(qk.leaderboard);
    // a request is not a kanka yet
    expect(invalidatedKeys([row('friend_request', { friendshipId: 'f1' })])).not.toContainEqual(qk.leaderboard);
  });
});

describe('invalidateForNotifications and the Karne', () => {
  const realRefreshMe = useAuth.getState().refreshMe;
  const refreshMe = jest.fn(async () => null);

  beforeEach(() => {
    refreshMe.mockClear();
    useAuth.setState({ refreshMe });
  });

  afterAll(() => {
    useAuth.setState({ refreshMe: realRefreshMe });
  });

  // `me` is in the auth store, so invalidating queries never reached it: a rozet
  // just earned stayed locked on a phone with no step or screen-time sync
  it('reads me again once for a finish and its rozetler', () => {
    invalidatedKeys([row('challenge_finished', { challengeId: 'c1' }), row('badge', { badgeKey: 'ilk_kan' })]);
    expect(refreshMe).toHaveBeenCalledTimes(1);
  });

  it('leaves me alone for a taunt or a new kanka', () => {
    invalidatedKeys([row('taunt', { challengeId: 'c1', tauntId: 't1' })]);
    invalidatedKeys([row('friend_accepted', { friendshipId: 'f1' })]);
    expect(refreshMe).not.toHaveBeenCalled();
  });
});
