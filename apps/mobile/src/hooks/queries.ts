import type {
  Challenge,
  ChallengeDetail,
  ChallengeResults,
  ChallengeSummary,
  Entry,
  FriendsView,
  LeaderboardEntry,
  Notification,
  ParticipantView,
  PublicProfile,
  PublicUser,
  UnreadCount,
} from '@koydum/shared';
import { LIMITS } from '@koydum/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { ApiError, type ApiClient } from '@/lib/api';
import { qk } from '@/lib/query';
import { enqueueEntry, flushQueue, uploadLocalPhoto } from '@/services/offlineQueue';
import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/store/auth';

/* --------------------------------------------------------------- reads */

/**
 * What the server says about itself: its public address (for invite links) and
 * the Android build it offers (for "yeni sürüm var"). Cheap and rarely changes.
 *
 * It also says who it is (`serverId`), which the store keeps while signed in:
 * a phone that already knows the id before the tunnel's next new address can
 * tell that address is the same server (services/serverMove.ts).
 */
export function useServerInfo() {
  const api = useApi();
  const serverUrl = useAuth((s) => s.serverUrl);
  const rememberServerId = useAuth((s) => s.rememberServerId);
  return useQuery({
    queryKey: qk.health,
    queryFn: async () => {
      const health = await api.health();
      void rememberServerId(health.serverId, serverUrl);
      return health;
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

export function useCatalog() {
  const api = useApi();
  const token = useAuth((s) => s.token);
  return useQuery({
    queryKey: qk.catalog,
    queryFn: () => api.catalog(),
    enabled: !!token,
    // the catalog only changes when the server is redeployed
    staleTime: 60 * 60_000,
  });
}

export function useChallenges(status?: string) {
  const api = useApi();
  const token = useAuth((s) => s.token);
  return useQuery<ChallengeSummary[]>({
    queryKey: qk.challenges(status),
    queryFn: () => api.challenges(status),
    enabled: !!token,
    refetchInterval: 60_000,
  });
}

export function useChallenge(id: string | undefined) {
  const api = useApi();
  return useQuery<ChallengeDetail>({
    queryKey: qk.challenge(id ?? ''),
    queryFn: () => api.challenge(id as string),
    enabled: !!id,
    refetchInterval: 45_000,
  });
}

export function useResults(id: string | undefined) {
  const api = useApi();
  return useQuery<ChallengeResults>({
    queryKey: qk.results(id ?? ''),
    queryFn: () => api.results(id as string),
    enabled: !!id,
  });
}

export function useFriends() {
  const api = useApi();
  const token = useAuth((s) => s.token);
  return useQuery<FriendsView>({
    queryKey: qk.friends,
    queryFn: () => api.friends(),
    enabled: !!token,
  });
}

/** Ayarlar → Engellediklerin: the only way back to someone a block hid. */
export function useBlocked() {
  const api = useApi();
  const token = useAuth((s) => s.token);
  return useQuery<PublicUser[]>({
    queryKey: qk.blocked,
    queryFn: () => api.blockedUsers(),
    enabled: !!token,
  });
}

/**
 * Gelen, newest page first; scrolling to the bottom asks for the next older
 * page. Invalidating `qk.inbox` refetches every page loaded so far, top down.
 */
export function useInbox() {
  const api = useApi();
  const token = useAuth((s) => s.token);
  return useInfiniteQuery({
    queryKey: qk.inbox,
    queryFn: ({ pageParam }) => api.inbox({ before: pageParam, limit: LIMITS.INBOX_PAGE_DEFAULT }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage, _pages, lastPageParam) => olderInboxCursor(lastPage, lastPageParam),
    enabled: !!token,
  });
}

/**
 * Where the next, older inbox page starts; undefined once a page comes back
 * short, i.e. there is nothing older.
 *
 * The server pages with `created_at < before`, and one scheduler pass can write
 * several rows for a user in the same millisecond (a finish, a badge, a taunt).
 * Cutting at the last row's own instant would skip whichever of them fell just
 * past the page, so the cursor sits one millisecond later: the next page opens
 * with that instant's rows again and the screen drops the ones it already has.
 */
function olderInboxCursor(page: Notification[], previous: string | undefined): string | undefined {
  const last = page[page.length - 1];
  if (!last || page.length < LIMITS.INBOX_PAGE_DEFAULT) return undefined;
  const ms = Date.parse(last.createdAt);
  if (!Number.isFinite(ms)) return undefined;
  const cursor = new Date(ms + 1).toISOString();
  // a whole page inside one millisecond would ask for itself forever
  return cursor === previous ? undefined : cursor;
}

/** Every loaded inbox page as one list, minus the rows a page boundary repeated. */
export function inboxRows(pages: readonly Notification[][] | undefined): Notification[] {
  const seen = new Set<string>();
  const rows: Notification[] = [];
  for (const item of (pages ?? []).flat()) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    rows.push(item);
  }
  return rows;
}

export function useUnread() {
  const api = useApi();
  const token = useAuth((s) => s.token);
  return useQuery<UnreadCount>({
    queryKey: qk.unread,
    queryFn: () => api.unreadCount(),
    enabled: !!token,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}

export function useLeaderboard() {
  const api = useApi();
  const token = useAuth((s) => s.token);
  return useQuery<LeaderboardEntry[]>({
    queryKey: qk.leaderboard,
    queryFn: () => api.leaderboard(),
    enabled: !!token,
  });
}

export function useProfile(id: string | undefined) {
  const api = useApi();
  return useQuery<PublicProfile>({
    queryKey: qk.profile(id ?? ''),
    queryFn: () => api.userProfile(id as string),
    enabled: !!id,
  });
}

/**
 * What new notifications change on screen. The tabs stay mounted and nothing
 * refetches them on focus (lib/query), so without this a taunt lit the badge
 * while Gelen stayed a row short, and a friend request was toasted but missing
 * from "Gelen istekler" until a pull-to-refresh.
 *
 * `data` is either an inbox row's data or a push payload; both carry the
 * çelınc as `challengeId`.
 */
export function invalidateForNotifications(
  qc: QueryClient,
  items: readonly { type?: string; data?: unknown }[]
): void {
  void qc.invalidateQueries({ queryKey: qk.inbox });
  void qc.invalidateQueries({ queryKey: qk.unread });

  let friends = false;
  const challengeIds = new Set<string>();
  for (const item of items) {
    if (item.type === 'friend_request' || item.type === 'friend_accepted') friends = true;
    const challengeId =
      item.data && typeof item.data === 'object' ? (item.data as Record<string, unknown>).challengeId : undefined;
    if (typeof challengeId === 'string' && challengeId) challengeIds.add(challengeId);
  }

  if (friends) void qc.invalidateQueries({ queryKey: qk.friends });
  // a taunt lands on an open results screen, which has no refetch interval:
  // without this the loser keeps reading "henüz konuşmadı, bekle"
  if (challengeIds.size > 0) void qc.invalidateQueries({ queryKey: ['challenges'] });
  for (const id of challengeIds) {
    void qc.invalidateQueries({ queryKey: qk.challenge(id) });
    void qc.invalidateQueries({ queryKey: qk.results(id) });
  }
}

/* ----------------------------------------------------------- mutations */

/** Everything a write can invalidate; challenge lists and detail always move together. */
function useInvalidator() {
  const qc = useQueryClient();
  return {
    challenges: () => qc.invalidateQueries({ queryKey: ['challenges'] }),
    challenge: (id: string) => {
      void qc.invalidateQueries({ queryKey: qk.challenge(id) });
      void qc.invalidateQueries({ queryKey: qk.results(id) });
      void qc.invalidateQueries({ queryKey: ['challenges'] });
    },
    friends: () => qc.invalidateQueries({ queryKey: qk.friends }),
    inbox: () => {
      void qc.invalidateQueries({ queryKey: qk.inbox });
      void qc.invalidateQueries({ queryKey: qk.unread });
    },
    all: () => qc.invalidateQueries(),
  };
}

export function useCreateChallenge() {
  const api = useApi();
  const invalidate = useInvalidator();
  return useMutation<Challenge, Error, Parameters<typeof api.createChallenge>[0]>({
    mutationFn: (body) => api.createChallenge(body),
    onSuccess: () => {
      void invalidate.challenges();
    },
  });
}

export function useChallengeAction(id: string) {
  const api = useApi();
  const invalidate = useInvalidator();
  return useMutation<unknown, Error, 'accept' | 'decline' | 'leave' | 'cancel'>({
    mutationFn: (action) => {
      if (action === 'accept') return api.acceptChallenge(id);
      if (action === 'decline') return api.declineChallenge(id);
      if (action === 'leave') return api.leaveChallenge(id);
      return api.cancelChallenge(id);
    },
    onSuccess: () => invalidate.challenge(id),
  });
}

/**
 * An entry write. `proofLocalUri` is a proof photo the entry modal could not
 * upload for lack of a connection: it goes up first, and when it still cannot,
 * the entry is parked with it and the offline queue sends both later.
 */
export type AddEntryVariables = Parameters<ApiClient['addEntry']>[1] & { proofLocalUri?: string };

/**
 * Posting an entry is the one write that must not be lost: it is what the user
 * walked, drank or read. When the server cannot be reached the entry is parked
 * in `services/offlineQueue` and replayed later, and the mutation resolves as if
 * it had worked so the screen can close.
 */
/**
 * `append` says the metric adds entries up (manual_count) instead of keeping one
 * per day: an offline write then queues as its own item rather than replacing the
 * one already waiting for the same day.
 */
export function useAddEntry(id: string, options: { append?: boolean } = {}) {
  const api = useApi();
  const invalidate = useInvalidator();
  const { append = false } = options;
  return useMutation<AddEntryResult, Error, AddEntryVariables>({
    mutationFn: async ({ proofLocalUri, ...body }) => {
      const key = `${id}:${body.dayKey}:${body.source}:${body.sessionId ?? ''}${append ? `:${body.clientTime}` : ''}`;
      const parkable = (error: unknown) => error instanceof ApiError && (error.isNetwork || error.status >= 500);
      let send = body;
      if (proofLocalUri && !body.proofUrl) {
        try {
          const { url } = await uploadLocalPhoto(api, proofLocalUri);
          send = { ...body, proofUrl: url };
        } catch (error) {
          if (!parkable(error)) throw error;
          await enqueueEntry(id, body, key, proofLocalUri);
          return { entry: null, standings: null, queued: true };
        }
      }
      try {
        const result = await api.addEntry(id, send);
        // a successful write is a good moment to drain anything parked earlier
        void flushQueue(api).catch(() => {});
        return { ...result, queued: false };
      } catch (error) {
        if (parkable(error)) {
          await enqueueEntry(id, send, key);
          return { entry: null, standings: null, queued: true };
        }
        throw error;
      }
    },
    onSuccess: () => invalidate.challenge(id),
  });
}

export interface AddEntryResult {
  entry: Entry | null;
  standings: ParticipantView[] | null;
  /** true when the phone was offline and the entry was parked for later */
  queued: boolean;
}

/** Replays anything the offline queue is holding; safe to call often. */
export function useFlushQueue() {
  const api = useApi();
  const invalidate = useInvalidator();
  return useMutation<Awaited<ReturnType<typeof flushQueue>>, Error, void>({
    mutationFn: () => flushQueue(api),
    onSuccess: (result) => {
      if (result.sent > 0) void invalidate.challenges();
    },
  });
}

export function useDeleteEntry(id: string) {
  const api = useApi();
  const invalidate = useInvalidator();
  return useMutation<unknown, Error, string>({
    mutationFn: (entryId) => api.deleteEntry(id, entryId),
    onSuccess: () => invalidate.challenge(id),
  });
}

export function useDispute(id: string) {
  const api = useApi();
  const invalidate = useInvalidator();
  return useMutation<unknown, Error, { entryId: string; reason: string }>({
    mutationFn: ({ entryId, reason }) => api.disputeEntry(id, entryId, reason),
    onSuccess: () => invalidate.challenge(id),
  });
}

export function useWithdrawDispute(id: string) {
  const api = useApi();
  const invalidate = useInvalidator();
  return useMutation<unknown, Error, string>({
    mutationFn: (entryId) => api.withdrawDispute(id, entryId),
    onSuccess: () => invalidate.challenge(id),
  });
}

export function useAddEntryProof(id: string) {
  const api = useApi();
  const invalidate = useInvalidator();
  return useMutation<unknown, Error, { entryId: string; proofUrl: string }>({
    mutationFn: ({ entryId, proofUrl }) => api.addEntryProof(id, entryId, proofUrl),
    onSuccess: () => invalidate.challenge(id),
  });
}

export function usePoke(id: string) {
  const api = useApi();
  const invalidate = useInvalidator();
  return useMutation<unknown, Error, { toUserId: string; templateId?: string }>({
    mutationFn: (body) => api.poke(id, body),
    onSuccess: () => invalidate.challenge(id),
  });
}

export function useTaunt(id: string) {
  const api = useApi();
  const invalidate = useInvalidator();
  return useMutation<unknown, Error, { toUserId: string; templateId?: string; customBody?: string }>({
    mutationFn: (body) => api.taunt(id, body),
    onSuccess: () => invalidate.challenge(id),
  });
}

export interface RematchResult {
  challenge: Challenge;
  /** who the server actually invited; null when the new çelınc could not be read back */
  invited: PublicUser[] | null;
}

export function useRematch(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  const invalidate = useInvalidator();
  return useMutation<RematchResult, Error, void>({
    mutationFn: async () => {
      const challenge = await api.rematch(id);
      // The answer is the bare Challenge, and the server leaves out anybody who
      // is not a friend, so the line-up is read back before the toast names it.
      // The screen opens that çelınc next, so this is the read it would make anyway.
      try {
        const detail = await qc.fetchQuery({
          queryKey: qk.challenge(challenge.id),
          queryFn: () => api.challenge(challenge.id),
        });
        return { challenge, invited: detail.participants.filter((p) => p.status === 'invited').map((p) => p.user) };
      } catch {
        // the rematch itself went through; only the names are missing
        return { challenge, invited: null };
      }
    },
    onSuccess: () => {
      void invalidate.challenges();
    },
  });
}

export function useFriendAction() {
  const api = useApi();
  const invalidate = useInvalidator();
  return useMutation<
    unknown,
    Error,
    | { kind: 'request'; username?: string; inviteCode?: string }
    | { kind: 'accept' | 'decline'; friendshipId: string }
    | { kind: 'remove'; userId: string }
    // my own unanswered request, and only that: one accepted meanwhile stays a friendship
    | { kind: 'withdraw'; userId: string }
  >({
    mutationFn: (action) => {
      if (action.kind === 'request')
        return api.requestFriend({ username: action.username, inviteCode: action.inviteCode });
      if (action.kind === 'remove') return api.removeFriend(action.userId);
      if (action.kind === 'withdraw') return api.withdrawFriendRequest(action.userId);
      if (action.kind === 'accept') return api.acceptFriend(action.friendshipId);
      return api.declineFriend(action.friendshipId);
    },
    onSuccess: () => {
      void invalidate.friends();
      void invalidate.inbox();
    },
    onError: (_error, action) => {
      // refused because it was accepted or declined meanwhile: the row on screen is stale
      if (action.kind === 'withdraw') void invalidate.friends();
    },
  });
}

/**
 * Lifts a block of mine. The person comes back in search (cached hits were
 * filtered without them) but not as a friend: the block tore that down.
 */
export function useUnblock() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (userId) => api.unblockUser(userId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.blocked });
      void qc.invalidateQueries({ queryKey: qk.friends });
      void qc.invalidateQueries({ queryKey: ['search'] });
    },
  });
}

export function useMarkInboxRead() {
  const api = useApi();
  const invalidate = useInvalidator();
  return useMutation<unknown, Error, { ids?: string[]; all?: boolean }>({
    mutationFn: (body) => api.markInboxRead(body),
    onSuccess: () => invalidate.inbox(),
  });
}

export function useUpdateMe() {
  const api = useApi();
  const setMe = useAuth((s) => s.setMe);
  const invalidate = useInvalidator();
  return useMutation<Awaited<ReturnType<typeof api.updateMe>>, Error, Parameters<typeof api.updateMe>[0]>({
    mutationFn: (body) => api.updateMe(body),
    onSuccess: async (me) => {
      await setMe(me);
      void invalidate.all();
    },
  });
}
