import { ApiError, type ApiClient } from '@/lib/api';
import { normalizeServerUrl } from '@/lib/config';
import { StorageKeys, getJson, removeItem, setJson } from '@/lib/storage';

/**
 * An invite link opened by somebody who has no account on this server yet.
 *
 * The link (`koydum://davet/ABC123?server=...`, from the server's /davet page)
 * lands before login, so the code is parked here and spent right after the
 * first successful login or registration: the friend request goes out on its
 * own and the new player starts with the person who invited them.
 */
export interface PendingInvite {
  code: string;
  /** the server the link came from, normalised; null when it did not say */
  server: string | null;
  savedAt: string;
}

/** A week is plenty: after that the link was forgotten, not pending. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function normalizeInviteCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z0-9]{4,12}$/.test(code) ? code : null;
}

export async function savePendingInvite(code: string, server: string | null): Promise<void> {
  const invite: PendingInvite = {
    code,
    server: server ? normalizeServerUrl(server) : null,
    savedAt: new Date().toISOString(),
  };
  await setJson(StorageKeys.pendingInvite, invite);
}

export async function readPendingInvite(now: Date = new Date()): Promise<PendingInvite | null> {
  const stored = await getJson<PendingInvite>(StorageKeys.pendingInvite);
  if (!stored || typeof stored !== 'object') return null;
  const code = normalizeInviteCode(stored.code);
  const savedAt = Date.parse(stored.savedAt);
  if (!code || !Number.isFinite(savedAt) || now.getTime() - savedAt > MAX_AGE_MS) {
    await clearPendingInvite();
    return null;
  }
  return { code, server: typeof stored.server === 'string' ? stored.server : null, savedAt: stored.savedAt };
}

export async function clearPendingInvite(): Promise<void> {
  await removeItem(StorageKeys.pendingInvite);
}

export type InviteOutcome =
  | { kind: 'sent' | 'accepted' | 'already'; name: string | null }
  | { kind: 'self' | 'missing' }
  | { kind: 'failed'; message: string }
  /** offline: kept for the next try */
  | { kind: 'later' };

/** Sends the friend request an invite code stands for. Never throws. */
export async function sendInvite(client: ApiClient, code: string): Promise<InviteOutcome> {
  let name: string | null = null;
  try {
    name = (await client.invite(code)).inviter.displayName;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { kind: 'missing' };
    // the name is decoration; the request below decides
  }
  try {
    const result = await client.requestFriend({ inviteCode: code });
    return { kind: result.status === 'accepted' ? 'accepted' : 'sent', name };
  } catch (error) {
    if (!(error instanceof ApiError)) return { kind: 'failed', message: 'Kanka isteği gönderilemedi.' };
    if (error.isNetwork || error.status >= 500) return { kind: 'later' };
    if (error.code === 'already_friends' || error.code === 'already_requested') return { kind: 'already', name };
    if (error.code === 'cannot_friend_self') return { kind: 'self' };
    if (error.code === 'user_not_found') return { kind: 'missing' };
    return { kind: 'failed', message: error.message };
  }
}

/**
 * Spends a parked invite for the account that just signed in. Returns null
 * when there was nothing to do. An invite from a different server than the one
 * this account lives on is dropped: the code means nothing here.
 */
export async function applyPendingInvite(client: ApiClient, serverUrl: string): Promise<InviteOutcome | null> {
  const pending = await readPendingInvite();
  if (!pending) return null;
  const here = normalizeServerUrl(serverUrl);
  if (pending.server && here && pending.server !== here) {
    await clearPendingInvite();
    return null;
  }
  const outcome = await sendInvite(client, pending.code);
  if (outcome.kind !== 'later') await clearPendingInvite();
  return outcome;
}
