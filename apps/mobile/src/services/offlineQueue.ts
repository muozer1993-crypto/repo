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
  /**
   * A proof photo taken with no connection: the image picker's own cache file.
   * It goes up right before the entry, its server path lands in `body.proofUrl`
   * and this is never sent anywhere. The OS may clear that cache whenever it
   * likes, so a photo that will not go up is dropped rather than retried forever.
   */
  proofLocalUri?: string;
  /**
   * The account that wrote it (the stored profile's id when it was parked). A
   * flush under another account on the same phone leaves it for its owner:
   * it would go up as that account's entry, with that account's photo upload.
   * Items parked before this field existed go with whoever is logged in.
   */
  ownerId?: string;
  queuedAt: string;
  attempts: number;
  /** set once the server refused it for good, so we stop retrying */
  failedReason?: string;
}

const MAX_QUEUE = 50;
const MAX_ATTEMPTS = 8;

/** Who is logged in on this phone, from storage: the background task has no store. */
async function currentOwnerId(): Promise<string | null> {
  const me = await getJson<{ id?: unknown }>(StorageKeys.me);
  return me && typeof me.id === 'string' ? me.id : null;
}

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
  id: string,
  proofLocalUri?: string
): Promise<PendingEntry> {
  const [queue, ownerId] = await Promise.all([readQueue(), currentOwnerId()]);
  // two accounts on one phone in the same çelınc build the same id for a day
  const key = ownerId ? `${ownerId}/${id}` : id;
  const item: PendingEntry = {
    id: key,
    challengeId,
    body,
    ...(proofLocalUri ? { proofLocalUri } : {}),
    ...(ownerId ? { ownerId } : {}),
    queuedAt: new Date().toISOString(),
    attempts: 0,
  };
  // A repeated write with the same id replaces the older one. The caller builds
  // the id: for upsert metrics it names the challenge, day and source (so a
  // corrected value supersedes the first), for append metrics (manual_count) it
  // also carries the client time, because two glasses of water on one day are
  // two entries, not a correction.
  const deduped = queue.filter((existing) => existing.id !== key);
  await writeQueue([...deduped, item]);
  return item;
}

export async function removeFromQueue(id: string): Promise<void> {
  const queue = await readQueue();
  await writeQueue(queue.filter((item) => item.id !== id));
}

/** Stores what a flush learned about one item (its uploaded photo) before going on. */
async function replaceInQueue(next: PendingEntry): Promise<void> {
  const queue = await readQueue();
  await writeQueue(queue.map((item) => (item.id === next.id ? next : item)));
}

/**
 * POST /uploads for a photo still on this phone. The name only tells the server
 * jpeg from png; the picker's cache files end in their real extension.
 */
export function uploadLocalPhoto(client: ApiClient, uri: string): Promise<{ url: string }> {
  const last = uri.split(/[/?#]/).filter(Boolean).pop() ?? '';
  return client.uploadPhoto(uri, /\.[a-z0-9]{3,4}$/i.test(last) ? last : 'kanit.jpg');
}

const PHOTO_GONE = 'Kanıt fotoğrafı telefonda bulunamadı.';

type PhotoOutcome =
  | { kind: 'sent'; url: string }
  /** no connection: stop the flush, keep everything */
  | { kind: 'offline' }
  /** the server is struggling or rate-limiting: count an attempt */
  | { kind: 'later' }
  /** it will never go up; `reason` is told to the user if the entry is refused without it */
  | { kind: 'lost'; reason: string }
  /** the server turned the request down, not the file (a session it no longer knows): final for the entry */
  | { kind: 'refused'; reason: string };

async function sendQueuedPhoto(client: ApiClient, uri: string): Promise<PhotoOutcome> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return { kind: 'sent', url: (await uploadLocalPhoto(client, uri)).url };
    } catch (error) {
      if (!(error instanceof ApiError)) return { kind: 'later' };
      // 429 upload_limit says "in N minutes", not "never"
      if (error.status === 429 || error.status >= 500) return { kind: 'later' };
      // the file's own problems: too big, not an image, empty
      if (error.status === 400 || error.status === 413) return { kind: 'lost', reason: error.message };
      if (error.status >= 400) return { kind: 'refused', reason: error.message };
      if (error.code === 'timeout') return { kind: 'offline' };
      // React Native fails a form whose file it cannot read exactly like a
      // request with no signal (status 0). If the server answers a small
      // question, the connection is fine and the file is what is missing: the
      // OS cleared the picker's cache. One more try first, so a connection that
      // dropped mid-upload and came straight back is not taken for that.
      try {
        await client.health();
      } catch {
        return { kind: 'offline' };
      }
      if (attempt >= 1) return { kind: 'lost', reason: PHOTO_GONE };
    }
  }
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
 *
 * An entry parked with a photo still on the phone uploads it first. A photo
 * that can never go up (the file is gone, the server refused it) is dropped
 * from the entry, which then goes on its own: an optional photo costs nothing
 * more, and a çelınc that requires one refuses the entry, whose reason then
 * says what happened to the photo.
 *
 * The flush is fired and forgotten from three places (every successful entry
 * write, mount, and every foreground), so it has to be re-entrant-safe:
 * concurrent callers share one run, and an item is removed from storage the
 * moment its POST lands rather than in one rewrite at the end — otherwise an
 * overlapping pass would send the same entry twice and double the score.
 */
let inFlight: Promise<FlushResult> | null = null;

export function flushQueue(client: ApiClient): Promise<FlushResult> {
  if (inFlight) return inFlight;
  const run = runFlush(client).finally(() => {
    if (inFlight === run) inFlight = null;
  });
  inFlight = run;
  return run;
}

async function runFlush(client: ApiClient): Promise<FlushResult> {
  const [all, ownerNow] = await Promise.all([readQueue(), currentOwnerId()]);
  // the client carries the account logged in now: another account's entries wait for it
  const mine = (item: PendingEntry) => !item.ownerId || item.ownerId === ownerNow;
  const queue = all.filter(mine);
  if (queue.length === 0) return { sent: 0, dropped: 0, remaining: 0 };

  let sent = 0;
  let dropped = 0;
  let offline = false;
  const delivered = new Set<string>();
  const touched = new Map<string, PendingEntry>();

  const retryLater = (item: PendingEntry) => {
    const attempts = item.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      dropped += 1;
      touched.set(item.id, { ...item, attempts, failedReason: 'Gönderilemedi, çok denedim.' });
    } else {
      touched.set(item.id, { ...item, attempts });
    }
  };

  for (const queued of queue) {
    if (offline || queued.failedReason) continue;
    let item = queued;
    let photoLost: string | null = null;

    if (item.proofLocalUri && !item.body.proofUrl) {
      const photo = await sendQueuedPhoto(client, item.proofLocalUri);
      if (photo.kind === 'offline') {
        offline = true;
        touched.set(item.id, { ...item, attempts: item.attempts + 1 });
        continue;
      }
      if (photo.kind === 'later') {
        retryLater(item);
        continue;
      }
      if (photo.kind === 'refused') {
        dropped += 1;
        touched.set(item.id, { ...item, attempts: item.attempts + 1, failedReason: photo.reason });
        continue;
      }
      item =
        photo.kind === 'sent'
          ? { ...item, body: { ...item.body, proofUrl: photo.url }, proofLocalUri: undefined }
          : { ...item, proofLocalUri: undefined };
      if (photo.kind === 'lost') photoLost = photo.reason;
      // persisted before the entry goes: a crash or a failed POST must not
      // upload the same photo again, or chase a file that is gone
      await replaceInQueue(item);
    }

    try {
      await client.addEntry(item.challengeId, item.body);
      sent += 1;
      delivered.add(item.id);
      // persisted immediately: a crash or a second pass must not re-send it
      await removeFromQueue(item.id);
      // The photo is left where the picker put it: its cache is the OS's to clear.
    } catch (error) {
      if (error instanceof ApiError && error.isNetwork) {
        offline = true;
        touched.set(item.id, { ...item, attempts: item.attempts + 1 });
        continue;
      }
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        // the server will never accept this one
        dropped += 1;
        const failedReason = photoLost ? `${photoLost} ${error.message}` : error.message;
        touched.set(item.id, { ...item, attempts: item.attempts + 1, failedReason });
        continue;
      }
      retryLater(item);
    }
  }

  // re-read so anything queued while we were sending survives, then write back
  // the attempt counters and failure reasons this pass produced
  const current = await readQueue();
  const keep = current
    .filter((item) => !delivered.has(item.id))
    .map((item) => touched.get(item.id) ?? item);
  await writeQueue(keep);
  return { sent, dropped, remaining: keep.filter((item) => mine(item) && !item.failedReason).length };
}

/** Clears the entries the user has already been told about. */
export async function clearFailed(): Promise<void> {
  const queue = await readQueue();
  await writeQueue(queue.filter((item) => !item.failedReason));
}

export const OfflineQueueKeys = { queue: QUEUE_KEY, storage: StorageKeys };
