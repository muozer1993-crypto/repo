import type { Notification } from '@koydum/shared';

import type { ApiClient } from '@/lib/api';
import { StorageKeys, getItem, getJson, setItem, setJson } from '@/lib/storage';
import { fireLocal, setBadgeCount } from '@/services/notifications';

/**
 * Hands out inbox items the server could not push.
 *
 * Real push on Android needs Firebase set up for the build; without it the
 * server has no way to reach a closed app, and the loser never saw "KOYDUM MU?"
 * until they opened KOYDUM themselves. So every place that runs while the
 * reader is away — the foreground poll, the background task with the app
 * alive, and the headless background task after the app was swiped away —
 * asks the inbox what is new and shows it as a notification from the phone
 * itself. When the app is on screen the items come back to the caller to show
 * as an in-app toast instead.
 *
 * Delivered ids are remembered, so the poll, the background task and a second
 * run racing either of them never show the same item twice.
 */
export type Surface = 'system' | 'in-app';

/** At most this many notifications per check; an inbox that piled up is summarised. */
const MAX_PER_CHECK = 3;
const DELIVERED_KEPT = 60;

let queue: Promise<unknown> = Promise.resolve();

export function deliverNewInbox(client: ApiClient, surface: Surface): Promise<Notification[]> {
  // one check at a time in this JS context: two overlapping checks would read
  // the same "delivered" list and both show the item
  const run = queue.then(() => check(client, surface));
  queue = run.catch(() => undefined);
  return run;
}

async function check(client: ApiClient, surface: Surface): Promise<Notification[]> {
  const unread = await client.unreadCount();
  await setBadgeCount(unread.count);
  const lastSeen = await getItem(StorageKeys.lastInboxId);
  if (!unread.latestId || unread.latestId === lastSeen) return [];

  const items = await client.inbox({ limit: 10 });
  await setItem(StorageKeys.lastInboxId, unread.latestId);

  const stored = await getJson<string[]>(StorageKeys.deliveredInboxIds);
  const delivered = new Set(Array.isArray(stored) ? stored : []);

  // first check on this install: whatever is there is history, not news
  if (lastSeen === null) {
    await remember(delivered, items.map((item) => item.id));
    return [];
  }

  // newest first, as the server sends them; only what nobody showed yet
  const fresh = items.filter((item) => !item.readAt && item.pushed !== true && !delivered.has(item.id));
  if (fresh.length === 0) return [];
  await remember(delivered, fresh.map((item) => item.id));

  if (surface === 'in-app') return fresh.slice(0, MAX_PER_CHECK);

  const shown = fresh.slice(0, fresh.length > MAX_PER_CHECK ? MAX_PER_CHECK - 1 : MAX_PER_CHECK);
  // oldest of the batch first, so the newest ends up on top of the shade
  for (const item of [...shown].reverse()) {
    await fireLocal(item.title, item.body, { ...item.data, type: item.type, notificationId: item.id });
  }
  const rest = fresh.length - shown.length;
  if (rest > 0) {
    await fireLocal('KOYDUM', `${rest} bildirim daha var, gelen kutuna bak.`, { type: 'inbox' });
  }
  return shown;
}

async function remember(delivered: Set<string>, ids: string[]): Promise<void> {
  const next = [...ids, ...[...delivered].filter((id) => !ids.includes(id))].slice(0, DELIVERED_KEPT);
  await setJson(StorageKeys.deliveredInboxIds, next);
}
