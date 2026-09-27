/**
 * Without Firebase push the phone itself has to show "KOYDUM MU?". The notifier
 * decides what is new, shows it once — never twice across the poll, the
 * background task and a racing second run — and never replays history on a
 * fresh install.
 */
jest.mock('@/services/notifications', () => ({
  fireLocal: jest.fn(async () => {}),
  setBadgeCount: jest.fn(async () => {}),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Notification } from '@koydum/shared';

import type { ApiClient } from '@/lib/api';
import { deliverNewInbox } from '@/services/inboxNotifier';
import { fireLocal, setBadgeCount } from '@/services/notifications';

const fire = fireLocal as unknown as jest.Mock;

function item(id: string, extra: Partial<Notification> = {}): Notification {
  return {
    id,
    type: 'taunt',
    title: `KOYDUM MU? ${id}`,
    body: `body ${id}`,
    data: { challengeId: 'c1' },
    readAt: null,
    createdAt: '2026-09-27T10:00:00.000Z',
    pushed: false,
    ...extra,
  } as Notification;
}

function client(items: Notification[]) {
  return {
    unreadCount: jest.fn(async () => ({ count: items.filter((i) => !i.readAt).length, latestId: items[0]?.id ?? null })),
    inbox: jest.fn(async () => items),
  } as unknown as ApiClient;
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
});

describe('deliverNewInbox', () => {
  it('shows nothing on the first check of an install: that is history, not news', async () => {
    expect(await deliverNewInbox(client([item('n2'), item('n1')]), 'system')).toEqual([]);
    expect(fire).not.toHaveBeenCalled();
    expect(setBadgeCount).toHaveBeenCalledWith(2);
  });

  it('shows a new item as a phone notification once, even when two checks race', async () => {
    await deliverNewInbox(client([item('n1')]), 'system');
    const next = client([item('n2'), item('n1')]);
    await Promise.all([deliverNewInbox(next, 'system'), deliverNewInbox(next, 'system')]);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith('KOYDUM MU? n2', 'body n2', expect.objectContaining({ type: 'taunt', notificationId: 'n2' }));
  });

  it('skips what the server already pushed and what was already read', async () => {
    await deliverNewInbox(client([item('n1')]), 'system');
    await deliverNewInbox(
      client([item('n4'), item('n3', { pushed: true }), item('n2', { readAt: '2026-09-27T10:05:00.000Z' }), item('n1')]),
      'system'
    );
    expect(fire.mock.calls.map((call) => call[0])).toEqual(['KOYDUM MU? n4']);
  });

  it('summarises a pile-up instead of ringing ten times, newest on top', async () => {
    await deliverNewInbox(client([item('n0')]), 'system');
    const pile = ['n6', 'n5', 'n4', 'n3', 'n2', 'n1'].map((id) => item(id));
    await deliverNewInbox(client([...pile, item('n0')]), 'system');
    expect(fire.mock.calls.map((call) => call[0])).toEqual(['KOYDUM MU? n5', 'KOYDUM MU? n6', 'KOYDUM']);
    expect(fire.mock.calls[2][1]).toContain('4 bildirim daha');
  });

  it('hands items back for an in-app toast when the app is on screen, and does not show them again later', async () => {
    await deliverNewInbox(client([item('n1')]), 'in-app');
    const shown = await deliverNewInbox(client([item('n2'), item('n1')]), 'in-app');
    expect(shown.map((n) => n.id)).toEqual(['n2']);
    expect(fire).not.toHaveBeenCalled();
    // the background task runs a minute later: n2 was already seen in the app
    await AsyncStorage.removeItem('koydum.lastInboxId');
    await AsyncStorage.setItem('koydum.lastInboxId', 'n1');
    await deliverNewInbox(client([item('n2'), item('n1')]), 'system');
    expect(fire).not.toHaveBeenCalled();
  });

  it('does nothing when the newest item is the one it saw last', async () => {
    const c = client([item('n1')]);
    await deliverNewInbox(c, 'system');
    await deliverNewInbox(c, 'system');
    expect((c.inbox as jest.Mock).mock.calls).toHaveLength(1);
  });
});
