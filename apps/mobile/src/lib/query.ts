import { QueryClient } from '@tanstack/react-query';

import { ApiError } from '@/lib/api';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      gcTime: 5 * 60_000,
      retry: (failureCount, error) => {
        // never retry a rejected token or a validation error
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
    },
    mutations: { retry: 0 },
  },
});

export const qk = {
  me: ['me'] as const,
  catalog: ['catalog'] as const,
  challenges: (status?: string) => ['challenges', status ?? 'all'] as const,
  challenge: (id: string) => ['challenge', id] as const,
  results: (id: string) => ['results', id] as const,
  friends: ['friends'] as const,
  inbox: ['inbox'] as const,
  unread: ['unread'] as const,
  leaderboard: ['leaderboard'] as const,
  profile: (id: string) => ['profile', id] as const,
  search: (q: string) => ['search', q] as const,
};
