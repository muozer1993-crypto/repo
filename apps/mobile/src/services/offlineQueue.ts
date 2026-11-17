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
   * The account that wrote it (the signed-in profile's id when its write
   * started, even if it parked after a logout). A
   * flush under another account on the same phone leaves it for its owner:
   * it would go up as that account's entry, with that account's photo upload.
   * Items parked before this field existed go with whoever is logged in.
   */
  ownerId?: string;
  /**
   * The çelınc's title when it was parked, so a refusal can say which one it
   * was. Items parked before this field existed are named from the cache.
   */
  challengeTitle?: string;
  /**
   * Flushes whose photo upload ran out of time while the server answered a
   * small question: the connection works but is too slow for the photo. At
   * `SLOW_PHOTO_TRIES` the entry goes without it.
   */
  photoSlowTries?: number;
  /**
   * When the server first held this entry's photo back for a while (its disk
   * nearly full, an upload cap spent). No try is spent on it; `PHOTO_HOLD_MS`
   * on, the entry goes without the photo.
   */
  photoHeldSince?: string;
  queuedAt: string;
  attempts: number;
  /** set once the server refused it for good, so we stop retrying */
  failedReason?: string;
}

const MAX_QUEUE = 50;
const MAX_ATTEMPTS = 8;
/**
 * A photo goes with a typed entry, which the server takes only
 * `LIMITS.MANUAL_BACKFILL_DAYS` back. Three flushes are a few foregrounds or
 * background runs: long enough for the connection to pick up, short of the
 * entry running out of days while it waits for its photo.
 */
const SLOW_PHOTO_TRIES = 3;
/**
 * How long a photo the server holds back (507 `disk_full`, 429 `upload_limit`)
 * keeps its entry waiting. An hour outlasts the hourly caps, whose wait is the
 * usual one; a full disk waits for the owner and the day's budget up to a day,
 * and the entry's days would run out first. Time, not flushes: every foreground
 * and every saved entry flushes, eight of them came in minutes, and spending a
 * try on each threw the entry away while the server still had room for it.
 * After it the entry is sent without the photo, which is dropped only once the
 * entry lands or is refused: on a disk too full for the entry too, it waits
 * with it and goes up first once there is room.
 */
const PHOTO_HOLD_MS = 60 * 60 * 1000;

/** Who is logged in on this phone, from storage: the background task has no store. */
export async function currentOwnerId(): Promise<string | null> {
  const me = await getJson<{ id?: unknown }>(StorageKeys.me);
  return me && typeof me.id === 'string' ? me.id : null;
}

/**
 * Something other than our server answered (the tunnel while the owner's PC
 * sleeps, a Wi-Fi login page; lib/api.ts): for the queue that is no
 * connection. Neither a sent entry nor a refused one, and the flush stops
 * rather than spending a try toward giving up: a PC asleep all night would
 * otherwise use up all eight by morning.
 */
function serverAbsent(error: ApiError): boolean {
  return error.code === 'server_down' || error.code === 'not_koydum';
}

export async function readQueue(): Promise<PendingEntry[]> {
  const stored = await getJson<PendingEntry[]>(QUEUE_KEY);
  return Array.isArray(stored) ? stored : [];
}

async function writeQueue(items: PendingEntry[]): Promise<void> {
  await setJson(QUEUE_KEY, items.slice(-MAX_QUEUE));
}

let chain: Promise<unknown> = Promise.resolve();

/**
 * One read-modify-write of the stored list at a time, resolving with the list
 * `change` made. AsyncStorage answers every call from its own native thread,
 * so a tap parking its entry and a flush storing what it sent each read the
 * list before the other wrote: the second write put back a list without the
 * first one's change, and a glass told "Sıraya alındı" was gone. Reads take
 * no turn, and nothing holds one across a request. Never call it from inside
 * `change`: that turn would wait for itself.
 */
function mutateQueue(change: (queue: PendingEntry[]) => PendingEntry[]): Promise<PendingEntry[]> {
  const run = chain.then(async () => {
    const next = change(await readQueue());
    await writeQueue(next);
    return next;
  });
  chain = run.catch(() => {});
  return run;
}

/**
 * `ownerId` is the account that tapped, taken when its write started
 * (useAddEntry): a logout or another sign-in before the answer must not park
 * the entry under whoever is logged in by then. Left out, it is read here.
 */
export async function enqueueEntry(
  challengeId: string,
  body: PendingEntry['body'],
  id: string,
  proofLocalUri?: string,
  challengeTitle?: string,
  owner?: string | null
): Promise<PendingEntry> {
  const ownerId = owner === undefined ? await currentOwnerId() : owner;
  // two accounts on one phone in the same çelınc build the same id for a day
  const key = ownerId ? `${ownerId}/${id}` : id;
  const item: PendingEntry = {
    id: key,
    challengeId,
    body,
    ...(proofLocalUri ? { proofLocalUri } : {}),
    ...(ownerId ? { ownerId } : {}),
    ...(challengeTitle ? { challengeTitle } : {}),
    queuedAt: new Date().toISOString(),
    attempts: 0,
  };
  // A repeated write with the same id replaces the older one. The caller builds
  // the id: for upsert metrics it names the challenge, day and source (so a
  // corrected value supersedes the first), for append metrics (manual_count) it
  // also carries the client time, because two glasses of water on one day are
  // two entries, not a correction.
  await mutateQueue((queue) => [...queue.filter((existing) => existing.id !== key), item]);
  return item;
}

export async function removeFromQueue(id: string): Promise<void> {
  await mutateQueue((queue) => queue.filter((item) => item.id !== id));
}

/**
 * A write that just reached the server spends the copy parked under the same
 * id (`enqueueEntry`): a second "Geldim" that got through, a day's number put
 * right. Replayed after it, the check-in came back "Bugün zaten check-in
 * yaptın." and was told as a refused entry, and the day got its older number.
 */
export async function dropParked(id: string, owner?: string | null): Promise<void> {
  // the account whose write landed (`enqueueEntry`'s `owner`), not whoever is logged in now
  const ownerId = owner === undefined ? await currentOwnerId() : owner;
  await removeFromQueue(ownerId ? `${ownerId}/${id}` : id);
}

/**
 * The same parked write as `item`: same id, and not parked again since. A
 * re-park under the id (a corrected number, another "Geldim") gets a new
 * `queuedAt`, and a flush that read the older one must leave the newer alone.
 */
function sameParking(a: PendingEntry, b: PendingEntry): boolean {
  return a.id === b.id && a.queuedAt === b.queuedAt;
}

/** Stores what a flush learned about one item (its uploaded photo) before going on. */
async function replaceInQueue(next: PendingEntry): Promise<void> {
  await mutateQueue((queue) => queue.map((item) => (sameParking(item, next) ? next : item)));
}

/**
 * Whether `item` is still waiting as this flush read it. A write that got
 * through directly meanwhile spent it (`dropParked`), and a re-park replaced
 * it: sending the copy in hand would put the older value back over the newer
 * one, with no word to anybody (the server upserts a day).
 */
async function stillParked(item: PendingEntry): Promise<boolean> {
  return (await readQueue()).some((stored) => sameParking(stored, item));
}

/**
 * Days whose own write is on its way to the server right now, by the key
 * useAddEntry builds (no owner in front: the writer is whoever is logged in).
 * A count rather than a flag, so a second write of the same day started before
 * the first answered still holds it once the first lets go.
 */
const held = new Map<string, number>();

/**
 * A write of this day is on its way directly: its parked copy must not
 * overtake it. A flush sending the older copy meanwhile landed after the newer
 * one, and the server keeps the last write of a day ("Yapmadım" put right back
 * to "Yaptım", 120 dk back to 300). Released once that write is done with the
 * copy: dropped it, parked its own value in its place, or was refused, leaving
 * it to go as before (`releaseParked`).
 */
export function holdParked(id: string): void {
  held.set(id, (held.get(id) ?? 0) + 1);
}

export function releaseParked(id: string): void {
  const count = (held.get(id) ?? 0) - 1;
  if (count > 0) held.set(id, count);
  else held.delete(id);
}

/** Whether `item`'s day is held: its id without the owner `enqueueEntry` put in front. */
function isHeld(item: PendingEntry): boolean {
  const prefix = item.ownerId ? `${item.ownerId}/` : '';
  return held.has(prefix && item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id);
}

/** Removes `item` once it landed, but not a re-park that took its id meanwhile. */
async function removeDelivered(item: PendingEntry): Promise<void> {
  await mutateQueue((queue) => queue.filter((stored) => !sameParking(stored, item)));
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
const PHOTO_TOO_SLOW = 'Kanıt fotoğrafı gitmedi, bağlantı çok yavaştı.';
/**
 * The server's "Check-in sadece bugün için yapılır." reads as the friend's
 * mistake; they pressed it on the day, and only the queue arrived on the next.
 */
const CHECKIN_DAY_OVER = 'Check-in sunucuya ulaşamadan gün bitti, o gün sayılmadı.';

/**
 * A parked check-in the server already has: the first send landed and only its
 * answer was lost (a timeout parks it), so the copy comes back as a replay.
 * That night counted; it is delivered, not refused.
 */
function alreadyCheckedIn(item: PendingEntry, error: ApiError): boolean {
  return item.body.source === 'checkin' && error.status === 409 && error.code === 'already_checked_in';
}

type PhotoOutcome =
  | { kind: 'sent'; url: string }
  /** no connection: stop the flush, keep everything */
  | { kind: 'offline' }
  /** the upload ran out of time but the server answers: this photo is too heavy for the connection, the rest may go */
  | { kind: 'slow' }
  /** the server is struggling: count an attempt */
  | { kind: 'later' }
  /** the server will take no photo for a while (a nearly full disk, an upload cap): wait, spend no try */
  | { kind: 'held'; reason: string }
  /** it will never go up; `reason` is told to the user if the entry is refused without it */
  | { kind: 'lost'; reason: string }
  /** the session ended (a password change elsewhere): stop, keep everything for the next sign-in */
  | { kind: 'signedOut' }
  /** the server turned the request down, not the file: final for the entry */
  | { kind: 'refused'; reason: string };

async function sendQueuedPhoto(client: ApiClient, uri: string): Promise<PhotoOutcome> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return { kind: 'sent', url: (await uploadLocalPhoto(client, uri)).url };
    } catch (error) {
      if (!(error instanceof ApiError)) return { kind: 'later' };
      // before any status: a portal's 404 or a proxy's 401 is not about the photo
      if (serverAbsent(error)) return { kind: 'offline' };
      // 429 upload_limit says "in N minutes", not "never", and 507 disk_full
      // lasts until the owner clears the disk: neither is the entry's fault
      if (error.status === 429 || error.status === 507) return { kind: 'held', reason: error.message };
      if (error.status >= 500) return { kind: 'later' };
      // the file's own problems: too big, not an image, empty
      if (error.status === 400 || error.status === 413) return { kind: 'lost', reason: error.message };
      if (error.status === 401) return { kind: 'signedOut' };
      if (error.status >= 400) return { kind: 'refused', reason: error.message };
      if (error.code === 'timeout') {
        // Two minutes without an answer (lib/api.ts UPLOAD_TIMEOUT_MS). If a
        // small question gets one, the connection is up and only too slow for
        // the photo: calling that offline stopped every entry behind it, flush
        // after flush, until the days ran out. Not tried again in this flush.
        try {
          await client.health();
        } catch {
          return { kind: 'offline' };
        }
        return { kind: 'slow' };
      }
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
  const [queue, owner] = await Promise.all([readQueue(), currentOwnerId()]);
  // another account's entries wait for it: its parked "Geldim" is not this account's tap
  return queue.filter(
    (item) =>
      item.challengeId === challengeId && !item.failedReason && (!item.ownerId || item.ownerId === owner)
  );
}

export interface FlushResult {
  sent: number;
  dropped: number;
  remaining: number;
}

/**
 * Replays the queue oldest first. A validation error from the server is final
 * (the day has passed, the cap was hit): the item is dropped with its reason so
 * the user can be told. A network error, or the server's full disk (507), stops
 * the flush and leaves the rest.
 *
 * An entry parked with a photo still on the phone uploads it first. A photo
 * that can never go up (the file is gone, the server refused it, it ran out
 * of time on a working connection `SLOW_PHOTO_TRIES` flushes running, or the
 * server held photos back for `PHOTO_HOLD_MS`) is dropped from the entry, which then goes on its own: an optional photo costs
 * nothing more, and a çelınc that requires one refuses the entry, whose reason
 * then says what happened to the photo. A photo still getting its tries does
 * not hold up the entries behind it.
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
  // A 401 is the session, not the entry: a password changed on another phone
  // or the owner reset it. The phone is being signed out; whatever waits here
  // goes up untouched when the same account signs in again.
  let signedOut = false;
  // both by id and `queuedAt` (`sameParking`): a re-park during the flush is not this one
  const delivered: PendingEntry[] = [];
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
    if (offline || signedOut || queued.failedReason) continue;
    let item = queued;
    let photoLost: string | null = null;
    // A photo held back an hour (a full disk, the hour's limit) goes only once
    // its entry lands or is refused: on a disk too full for the entry as well,
    // dropping it bought nothing, and an entry that needs one lost its day.
    let heldSince: string | null = null;

    if (item.proofLocalUri && !item.body.proofUrl) {
      const photo = await sendQueuedPhoto(client, item.proofLocalUri);
      if (photo.kind === 'offline') {
        // no try spent (MAX_ATTEMPTS is for a server that keeps failing it)
        offline = true;
        continue;
      }
      if (photo.kind === 'later') {
        retryLater(item);
        continue;
      }
      if (photo.kind === 'held') {
        const now = Date.now();
        const since = item.photoHeldSince ?? new Date(now).toISOString();
        if (now - Date.parse(since) < PHOTO_HOLD_MS) {
          // not offline either: the entries behind this one may carry no photo
          touched.set(item.id, { ...item, photoHeldSince: since });
          continue;
        }
        // held back for an hour: the entry goes without it, and says why if refused
        photoLost = photo.reason;
        heldSince = since;
      }
      if (photo.kind === 'slow') {
        const photoSlowTries = (item.photoSlowTries ?? 0) + 1;
        if (photoSlowTries < SLOW_PHOTO_TRIES) {
          // not offline: the entries behind this one carry no photo, or a lighter one
          touched.set(item.id, { ...item, attempts: item.attempts + 1, photoSlowTries });
          continue;
        }
        // too slow once too often: dropped below like a photo that is gone, so
        // the entry still counts where a photo is optional and says why where not
        photoLost = PHOTO_TOO_SLOW;
      }
      if (photo.kind === 'signedOut') {
        signedOut = true;
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
      // upload the same photo again, or chase a file that is gone. Not a photo
      // only held back: it stays parked with its entry until that entry is
      // through (`heldSince`).
      if (heldSince === null) await replaceInQueue(item);
    }

    // A photo can take two minutes, and the app is open meanwhile: the same
    // day may have been written directly (and this one dropped) or parked anew.
    // That write may also still be on its way (`holdParked`): left parked, the
    // copy is dropped once it lands, or replaced if it parks. The hold is read
    // after the queue, with nothing awaited between it and the POST.
    if (!(await stillParked(queued)) || isHeld(queued)) continue;

    const landed = async () => {
      sent += 1;
      delivered.push(item);
      // persisted immediately: a crash or a second pass must not re-send it
      await removeDelivered(item);
    };
    try {
      await client.addEntry(item.challengeId, item.body);
      await landed();
      // The photo is left where the picker put it: its cache is the OS's to clear.
    } catch (error) {
      // before the 4xx below: a 403 page from a portal never refused anything.
      // No try spent either: a night of these must not leave the first real
      // hiccup of the morning as the ninth try that gives up.
      if (error instanceof ApiError && (error.isNetwork || serverAbsent(error))) {
        offline = true;
        continue;
      }
      if (error instanceof ApiError && error.status === 401) {
        signedOut = true;
        continue;
      }
      // The server's disk is full: every entry behind this one fails the same
      // way until the owner frees room. Waits like no connection, no try spent:
      // eight flushes come in minutes, and the entries were gone by the time
      // the disk had room again.
      if (error instanceof ApiError && error.status === 507) {
        offline = true;
        continue;
      }
      if (error instanceof ApiError && alreadyCheckedIn(item, error)) {
        await landed();
        continue;
      }
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        // the server will never accept this one
        dropped += 1;
        const refusal = error.code === 'checkin_today_only' ? CHECKIN_DAY_OVER : error.message;
        const failedReason = photoLost ? `${photoLost} ${refusal}` : refusal;
        touched.set(item.id, { ...item, attempts: item.attempts + 1, failedReason });
        continue;
      }
      // a held photo is tried again first next time
      retryLater(heldSince === null ? item : { ...queued, photoHeldSince: heldSince });
    }
  }

  // re-read so anything queued while we were sending survives, then write back
  // the attempt counters and failure reasons this pass produced
  const keep = await mutateQueue((current) =>
    current
      .filter((item) => !delivered.some((sent) => sameParking(sent, item)))
      .map((item) => {
        const next = touched.get(item.id);
        return next && sameParking(next, item) ? next : item;
      })
  );
  return { sent, dropped, remaining: keep.filter((item) => mine(item) && !item.failedReason).length };
}

/**
 * Clears the entries the user has already been told about: the ones in `ids`,
 * or every refused one without it. With the ids, a refusal that lands while
 * the toast is up stays for the next one.
 */
export async function clearFailed(ids?: readonly string[]): Promise<void> {
  const told = ids ? new Set(ids) : null;
  await mutateQueue((queue) => queue.filter((item) => !item.failedReason || (told !== null && !told.has(item.id))));
}

export const OfflineQueueKeys = { queue: QUEUE_KEY, storage: StorageKeys };
