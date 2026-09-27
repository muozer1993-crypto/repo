import type { Notification } from '@koydum/shared';
import { QueryClient } from '@tanstack/react-query';

import { invalidateForNotifications } from '@/hooks/queries';
import { qk } from '@/lib/query';

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
    expect(invalidatedKeys([row('badge', { badgeKey: 'ilk_kan' })])).toEqual([qk.inbox, qk.unread]);
  });
});
