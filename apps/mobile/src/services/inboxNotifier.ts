import { LIMITS, type Notification } from '@koydum/shared';

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
 * A phone that registered a push token gets every row from the server's push
 * (and its in-app toast from the received listener), so it only keeps the
 * badge in step here: the server marks a row pushed up to one scheduler tick
 * after writing it, and anything shown locally in that gap would ring twice.
 *
 * Only rows newer than the last one this install saw count, and delivered ids
 * are remembered, so the poll, the background task and a second run racing
 * either of them never show the same item twice.
 */
export type Surface = 'system' | 'in-app';

export interface Delivery {
  /** where the items went — decided after the fetch, when it is still true */
  surface: Surface;
  /** newest first; for 'in-app' every fresh item, the caller decides how to show them */
  items: Notification[];
}

/** At most this many phone notifications per check; a pile-up is summarised. */
const MAX_PER_CHECK = 3;
/** Covers one full inbox page, so a remembered id never falls off while it is still listed. */
const DELIVERED_KEPT = LIMITS.INBOX_PAGE_MAX;
/**
 * Stored as the last seen id after a first check that found an empty inbox: the
 * first check is done, so the very first row that ever arrives is news. Never a
 * real id (ids are UUIDs).
 */
const EMPTY_INBOX = '-';

let queue: Promise<unknown> = Promise.resolve();

export function deliverNewInbox(client: ApiClient, surface: Surface | (() => Surface)): Promise<Delivery> {
  // one check at a time in this JS context: two overlapping checks would read
  // the same "delivered" list and both show the item
  const run = queue.then(() => check(client, surface));
  queue = run.catch(() => undefined);
  return run;
}

async function check(client: ApiClient, surfaceOf: Surface | (() => Surface)): Promise<Delivery> {
  const unread = await client.unreadCount();
  await setBadgeCount(unread.count);
  const lastSeen = await getItem(StorageKeys.lastInboxId);
  const resolve = (): Surface => (typeof surfaceOf === 'function' ? surfaceOf() : surfaceOf);
  const nothing = (): Delivery => ({ surface: resolve(), items: [] });

  if (!unread.latestId) {
    if (lastSeen === null) await setItem(StorageKeys.lastInboxId, EMPTY_INBOX);
    return nothing();
  }
  if (unread.latestId === lastSeen) return nothing();
  // push delivers these; see the note at the top
  if (await getItem(StorageKeys.pushToken)) {
    await setItem(StorageKeys.lastInboxId, unread.latestId);
    return nothing();
  }

  const items = await client.inbox({ limit: LIMITS.INBOX_PAGE_MAX });
  await setItem(StorageKeys.lastInboxId, unread.latestId);

  const stored = await getJson<string[]>(StorageKeys.deliveredInboxIds);
  const delivered = new Set(Array.isArray(stored) ? stored : []);

  // first check on this install: whatever is there is history, not news
  if (lastSeen === null) {
    await remember(delivered, items.map((item) => item.id));
    return nothing();
  }

  // newest first, as the server sends them: everything above the last row
  // this install saw is new (all of the page when that row scrolled off it)
  const seenAt = items.findIndex((item) => item.id === lastSeen);
  const newer = seenAt >= 0 ? items.slice(0, seenAt) : items;
  const fresh = newer.filter((item) => !item.readAt && item.pushed !== true && !delivered.has(item.id));
  if (fresh.length === 0) return nothing();
  await remember(delivered, fresh.map((item) => item.id));

  const surface = resolve();
  if (surface === 'in-app') return { surface, items: fresh };

  const shown = fresh.slice(0, fresh.length > MAX_PER_CHECK ? MAX_PER_CHECK - 1 : MAX_PER_CHECK);
  // oldest of the batch first, so the newest ends up on top of the shade
  for (const item of [...shown].reverse()) {
    await fireLocal(item.title, item.body, { ...item.data, type: item.type, notificationId: item.id });
  }
  const rest = fresh.length - shown.length;
  if (rest > 0) {
    await fireLocal('KOYDUM', `${rest} bildirim daha var, gelen kutuna bak.`, { type: 'inbox' });
  }
  return { surface, items: shown };
}

async function remember(delivered: Set<string>, ids: string[]): Promise<void> {
  const next = [...ids, ...[...delivered].filter((id) => !ids.includes(id))].slice(0, DELIVERED_KEPT);
  await setJson(StorageKeys.deliveredInboxIds, next);
}
