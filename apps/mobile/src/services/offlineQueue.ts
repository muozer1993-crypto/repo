import { StorageKeys, getJson, setJson } from '@/lib/storage';
import type { ApiClient } from '@/lib/api';
import { ApiError } from '@/lib/api';

/**
 * A phone loses its connection in a stairwell, on the metro, in the gym
 * basement — exactly where people log a challenge entry. Rather than throwing
 * the entry away, we park it and replay it when the server is reachable again.
 *
 * Only entry writes are queued: they are idempotent enough to retry (the server
 * upserts per day, and focus sessions carry a sessionId), and they are the ones
 * that cost the user a day of the challenge if they vanish.
 */

const QUEUE_KEY = 'koydum.pendingEntries';

export interface PendingEntry {
  /** local id so the UI can show it as "gönderilmeyi bekliyor" */
  id: string;
  challengeId: string;
  body: {
    dayKey: string;
    value: number;
    source: string;
    note?: string;
    proofUrl?: string;
    clientTime: string;
    sessionId?: string;
  };
  queuedAt: string;
  attempts: number;
  /** set once the server refused it for good, so we stop retrying */
  failedReason?: string;
}

const MAX_QUEUE = 50;
const MAX_ATTEMPTS = 8;

export async function readQueue(): Promise<PendingEntry[]> {
  const stored = await getJson<PendingEntry[]>(QUEUE_KEY);
  return Array.isArray(stored) ? stored : [];
}

async function writeQueue(items: PendingEntry[]): Promise<void> {
  await setJson(QUEUE_KEY, items.slice(-MAX_QUEUE));
}

export async function enqueueEntry(
  challengeId: string,
  body: PendingEntry['body'],
  id: string
): Promise<PendingEntry> {
  const queue = await readQueue();
  const item: PendingEntry = { id, challengeId, body, queuedAt: new Date().toISOString(), attempts: 0 };
  // a repeated write for the same day and challenge replaces the older one
  const deduped = queue.filter(
    (existing) =>
      !(
        existing.challengeId === challengeId &&
        existing.body.dayKey === body.dayKey &&
        existing.body.source === body.source &&
        existing.body.sessionId === body.sessionId
      )
  );
  await writeQueue([...deduped, item]);
  return item;
}

export async function removeFromQueue(id: string): Promise<void> {
  const queue = await readQueue();
  await writeQueue(queue.filter((item) => item.id !== id));
}

export async function pendingForChallenge(challengeId: string): Promise<PendingEntry[]> {
  const queue = await readQueue();
  return queue.filter((item) => item.challengeId === challengeId && !item.failedReason);
}

export interface FlushResult {
  sent: number;
  dropped: number;
  remaining: number;
}

/**
 * Replays the queue oldest first. A validation error from the server is final
 * (the day has passed, the cap was hit): the item is dropped with its reason so
 * the user can be told. A network error stops the flush and leaves the rest.
 */
export async function flushQueue(client: ApiClient): Promise<FlushResult> {
  const queue = await readQueue();
  if (queue.length === 0) return { sent: 0, dropped: 0, remaining: 0 };

  let sent = 0;
  let dropped = 0;
  const keep: PendingEntry[] = [];
  let offline = false;

  for (const item of queue) {
    if (offline || item.failedReason) {
      keep.push(item);
      continue;
    }
    try {
      await client.addEntry(item.challengeId, item.body);
      sent += 1;
    } catch (error) {
      if (error instanceof ApiError && error.isNetwork) {
        offline = true;
        keep.push({ ...item, attempts: item.attempts + 1 });
        continue;
      }
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        // the server will never accept this one
        dropped += 1;
        keep.push({ ...item, attempts: item.attempts + 1, failedReason: error.message });
        continue;
      }
      const attempts = item.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        dropped += 1;
        keep.push({ ...item, attempts, failedReason: 'Gönderilemedi, çok denedim.' });
      } else {
        keep.push({ ...item, attempts });
      }
    }
  }

  await writeQueue(keep);
  return { sent, dropped, remaining: keep.filter((item) => !item.failedReason).length };
}

/** Clears the entries the user has already been told about. */
export async function clearFailed(): Promise<void> {
  const queue = await readQueue();
  await writeQueue(queue.filter((item) => !item.failedReason));
}

export const OfflineQueueKeys = { queue: QUEUE_KEY, storage: StorageKeys };
