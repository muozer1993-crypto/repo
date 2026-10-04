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

/**
 * The server an invite link points at, from anything a friend may paste: the
 * app link (`koydum://davet/ABC123?server=https%3A%2F%2F…`), the page link the
 * share button sends (`https://….trycloudflare.com/davet/ABC123`, whose origin
 * IS the server), or a whole WhatsApp message with one of them inside. Null
 * when the text holds neither, so the caller can read it as a bare address.
 */
export function serverFromInviteLink(text: string): string | null {
  const param = /[?&]server=([^&#\s]+)/i.exec(text);
  if (param) {
    try {
      return normalizeServerUrl(decodeURIComponent(param[1]));
    } catch {
      return null;
    }
  }
  const page = /(https?:\/\/[^/?#\s]+)\/(?:davet|indir)(?:[/?#\s]|$)/i.exec(text);
  return page ? normalizeServerUrl(page[1]) : null;
}

/**
 * Whatever a friend pastes before the app knows any server: the WhatsApp
 * message with the invite link, the link alone, or a bare address. Android's
 * installer ends on "Aç", which starts the app with no link, so this paste is
 * how both the server and the code reach a fresh install. The code comes from
 * `/davet/CODE` (or the `/indir?kod=CODE` page the download falls back to).
 */
export function parsePastedInvite(text: string): { server: string | null; code: string | null } {
  // "Adres bu: https://abc.trycloudflare.com." — a bare address inside a
  // sentence, without the sentence's last full stop
  const inline = /https?:\/\/[^\s]+/i.exec(text)?.[0].replace(/[.,;:!?)]+$/, '');
  const server =
    serverFromInviteLink(text) ?? normalizeServerUrl(text) ?? (inline ? normalizeServerUrl(inline) : null);
  const found = /(?:\/davet\/|[?&]kod=)([A-Za-z0-9]{4,12})(?![A-Za-z0-9])/i.exec(text);
  return { server, code: found ? normalizeInviteCode(found[1]) : null };
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
