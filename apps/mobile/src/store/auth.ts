import * as Localization from 'expo-localization';
import type { Me } from '@koydum/shared';
import { create } from 'zustand';

import { ApiClient } from '@/lib/api';
import { guessServerUrl } from '@/lib/config';
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

  logout: async () => {
    set({ token: null, me: null });
    await Promise.all([removeItem(StorageKeys.token), removeItem(StorageKeys.me)]);
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
