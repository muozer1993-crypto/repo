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
  UnreadCount,
} from '@koydum/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { qk } from '@/lib/query';
import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/store/auth';

/* --------------------------------------------------------------- reads */

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

export function useInbox() {
  const api = useApi();
  const token = useAuth((s) => s.token);
  return useQuery<Notification[]>({
    queryKey: qk.inbox,
    queryFn: () => api.inbox({ limit: 50 }),
    enabled: !!token,
  });
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

export function useAddEntry(id: string) {
  const api = useApi();
  const invalidate = useInvalidator();
  return useMutation<
    { entry: Entry; standings: ParticipantView[] },
    Error,
    Parameters<typeof api.addEntry>[1]
  >({
    mutationFn: (body) => api.addEntry(id, body),
    onSuccess: () => invalidate.challenge(id),
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

export function useRematch(id: string) {
  const api = useApi();
  const invalidate = useInvalidator();
  return useMutation<Challenge, Error, void>({
    mutationFn: () => api.rematch(id),
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
  >({
    mutationFn: (action) => {
      if (action.kind === 'request')
        return api.requestFriend({ username: action.username, inviteCode: action.inviteCode });
      if (action.kind === 'remove') return api.removeFriend(action.userId);
      if (action.kind === 'accept') return api.acceptFriend(action.friendshipId);
      return api.declineFriend(action.friendshipId);
    },
    onSuccess: () => {
      void invalidate.friends();
      void invalidate.inbox();
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
