import * as Localization from 'expo-localization';
import type { Me } from '@koydum/shared';
import { create } from 'zustand';

import { ApiClient } from '@/lib/api';
import { guessServerUrl } from '@/lib/config';
import { queryClient } from '@/lib/query';
import { StorageKeys, getJson, removeItem, setItem, setJson } from '@/lib/storage';

interface AuthState {
  hydrated: boolean;
  token: string | null;
  me: Me | null;
  serverUrl: string;
  /** true while the initial /me refresh is in flight */
  refreshing: boolean;

  hydrate: () => Promise<void>;
  setSession: (token: string, me: Me) => Promise<void>;
  setMe: (me: Me) => Promise<void>;
  setServerUrl: (url: string) => Promise<void>;
  logout: () => Promise<void>;
  client: () => ApiClient;
  refreshMe: () => Promise<Me | null>;
}

/** Device timezone, e.g. "Europe/Istanbul". */
export function deviceTimezone(): string {
  try {
    const calendars = Localization.getCalendars();
    const tz = calendars[0]?.timeZone;
    if (tz) return tz;
  } catch {
    // fall through
  }
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) return tz;
  } catch {
    // fall through
  }
  return 'Europe/Istanbul';
}

/** Guards the re-entrant logout path (see `logout` below). */
let loggingOut = false;

export const useAuth = create<AuthState>((set, get) => ({
  hydrated: false,
  token: null,
  me: null,
  serverUrl: guessServerUrl(),
  refreshing: false,

  hydrate: async () => {
    const [token, me, storedUrl] = await Promise.all([
      getJson<string>(StorageKeys.token).then((value) =>
        typeof value === 'string' ? value : null
      ),
      getJson<Me>(StorageKeys.me),
      getJson<string>(StorageKeys.serverUrl),
    ]);
    set({
      token,
      me: me ?? null,
      serverUrl: typeof storedUrl === 'string' && storedUrl ? storedUrl : guessServerUrl(),
      hydrated: true,
    });
    if (token) void get().refreshMe();
  },

  setSession: async (token, me) => {
    // a different account on the same phone must never read the previous one's
    // cached challenges, inbox or unread badge
    const previous = get().me;
    if (previous && previous.id !== me.id) queryClient.clear();
    set({ token, me });
    await Promise.all([setJson(StorageKeys.token, token), setJson(StorageKeys.me, me)]);
  },

  setMe: async (me) => {
    set({ me });
    await setJson(StorageKeys.me, me);
  },

  setServerUrl: async (url) => {
    set({ serverUrl: url });
    await setItem(StorageKeys.serverUrl, JSON.stringify(url));
  },

  /**
   * Everything this account left on the device goes with it: the server stops
   * pushing to this phone, the react-query cache is dropped so the next login
   * cannot paint the previous user's rows, and the inbox cursor is reset so the
   * next account does not get local notifications for someone else's history.
   */
  logout: async () => {
    // `clearPushToken` can itself answer 401, which calls `onUnauthorized` →
    // `logout` again: without this guard that recurses until the stack blows
    if (loggingOut) return;
    loggingOut = true;
    try {
      if (get().token) {
        try {
          await get().client().clearPushToken();
        } catch {
          // best effort: an unreachable server must never trap the user in a session
        }
      }
      set({ token: null, me: null });
      queryClient.clear();
      await Promise.all([
        removeItem(StorageKeys.token),
        removeItem(StorageKeys.me),
        removeItem(StorageKeys.pushToken),
        removeItem(StorageKeys.lastInboxId),
      ]);
    } finally {
      loggingOut = false;
    }
  },

  client: () => {
    const { serverUrl, token } = get();
    return new ApiClient({
      baseUrl: serverUrl,
      token,
      onUnauthorized: () => {
        void get().logout();
      },
    });
  },

  refreshMe: async () => {
    if (!get().token) return null;
    set({ refreshing: true });
    try {
      const me = await get().client().me();
      await get().setMe(me);
      return me;
    } catch {
      // stale cache is better than an empty screen; a 401 already logged us out
      return null;
    } finally {
      set({ refreshing: false });
    }
  },
}));

/** The vulgarity level used for UI copy (defaults to "argo" before login). */
export function useLevel(): 1 | 2 | 3 {
  return useAuth((state) => state.me?.vulgarityMax ?? 2);
}
