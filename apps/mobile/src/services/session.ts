import type { ApiClient } from '@/lib/api';
import { StorageKeys, getJson, setJson } from '@/lib/storage';

/**
 * Keeps a session alive without anybody typing their password again.
 *
 * A token is good for 90 days from the moment the server signed it, and nothing
 * used to renew it: friends who joined the same week were all thrown out on the
 * same day, and a phone that only ever ran the background task stopped sending
 * steps without a word. So about once a week, whichever runs first (the app
 * opening, or the headless task) trades the token for a fresh one. A phone has
 * to sit untouched for ~83 days in a row before its token lapses now.
 */

/** How old the last renewal may get before the next one. */
export const RENEW_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** The token on this phone was just issued (login, sign-up, password change). */
export async function markTokenRenewed(now: Date = new Date()): Promise<void> {
  await setJson(StorageKeys.tokenRenewedAt, now.toISOString());
}

/**
 * Renews `client`'s token when the last renewal is missing or a week old,
 * stores it, and hands it to `onToken`. Returns the new token, or null when
 * nothing was due or the server could not be asked. Never throws: offline, the
 * next run tries again; a 401 means the token is already dead, and renewal is
 * not a way back in.
 */
export async function renewTokenIfDue(
  client: ApiClient,
  onToken?: (token: string) => void,
  now: Date = new Date()
): Promise<string | null> {
  const used = client.token;
  if (!used) return null;
  try {
    const renewedAt = Date.parse((await getJson<string>(StorageKeys.tokenRenewedAt)) ?? '');
    const age = now.getTime() - renewedAt;
    // a stamp from the future (the phone's clock was wrong) counts as due
    if (Number.isFinite(age) && age >= 0 && age < RENEW_AFTER_MS) return null;

    const { token } = await client.refreshToken();
    // Signed out, or into another account, while the request was out: writing
    // this token back would sign the old account in again on the next start.
    if ((await getJson<string>(StorageKeys.token)) !== used) return null;
    await setJson(StorageKeys.token, token);
    await markTokenRenewed(now);
    onToken?.(token);
    return token;
  } catch {
    return null;
  }
}
