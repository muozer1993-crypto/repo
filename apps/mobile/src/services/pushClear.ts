import { ApiClient, ApiError } from '@/lib/api';
import { StorageKeys, getJson, removeItem, setJson } from '@/lib/storage';

/**
 * "Çıkış yap"'s request that the server stop pushing to this phone, kept until
 * it gets through.
 *
 * Logout sends it once and never waits for it: an unreachable server must not
 * trap anybody in a session. But the owner's PC sleeps, and a tablet signed out
 * while it slept kept the account's one push slot: every laf and invite rang
 * the tablet in the drawer, and the phone in use, which already sent its token
 * and leaves a slot the server says is taken alone (`pushTokenNeedsSending`),
 * never took it back. So a DELETE that did not reach the server is stored with
 * the session it was for and sent again on the next start, foreground and
 * background run, signed out or not, until the server answers.
 */
export interface PendingPushClear {
  serverUrl: string;
  /** the session token of the account that signed out; the server still takes it */
  sessionToken: string;
  /** the device token this phone registered for that account */
  pushToken: string;
}

const TIMEOUT_MS = 15_000;

function isPending(value: unknown): value is PendingPushClear {
  const entry = value as Partial<PendingPushClear> | null;
  return (
    typeof entry?.serverUrl === 'string' &&
    typeof entry.sessionToken === 'string' &&
    typeof entry.pushToken === 'string' &&
    entry.pushToken !== ''
  );
}

/**
 * Whether a failure is the server's own answer (a refusal that a retry would
 * only repeat, a 401 for a session already gone) rather than no answer at all:
 * no connection, a timeout, the tunnel while the PC sleeps (5xx), a full disk.
 */
function answered(error: unknown): boolean {
  // a Wi-Fi login page or a router answering for the address is not the server
  return error instanceof ApiError && error.status > 0 && error.status < 500 && error.code !== 'not_koydum';
}

/**
 * Sends `entry`'s DELETE. Kept for later when it did not get through, unless
 * somebody has signed in on this phone since: that sign-in sends this phone's
 * token for its own account, and a late DELETE for the same account would
 * clear the slot it just took.
 */
export async function sendPushClear(entry: PendingPushClear): Promise<void> {
  try {
    await new ApiClient({ baseUrl: entry.serverUrl, token: entry.sessionToken, timeoutMs: TIMEOUT_MS }).clearPushToken(
      entry.pushToken
    );
    await removeItem(StorageKeys.pendingPushClear);
  } catch (error) {
    if (answered(error)) {
      await removeItem(StorageKeys.pendingPushClear);
      return;
    }
    if (await signedInSince(entry)) return;
    await setJson(StorageKeys.pendingPushClear, entry);
  }
}

/** A session on this phone other than the one that signed out. */
async function signedInSince(entry: PendingPushClear): Promise<boolean> {
  const token = await getJson<string>(StorageKeys.token);
  return typeof token === 'string' && token !== '' && token !== entry.sessionToken;
}

/** Sends a logout's stored DELETE again, if there is one. Never throws. */
export async function flushPendingPushClear(): Promise<void> {
  try {
    const entry = await getJson<unknown>(StorageKeys.pendingPushClear);
    if (entry === null) return;
    if (!isPending(entry) || (await signedInSince(entry))) {
      await removeItem(StorageKeys.pendingPushClear);
      return;
    }
    await sendPushClear(entry);
  } catch {
    // the next start or foreground tries again
  }
}

/** A sign-in on this phone: its own POST settles the slot, so a stored DELETE must not follow it. */
export async function forgetPendingPushClear(): Promise<void> {
  await removeItem(StorageKeys.pendingPushClear);
}
