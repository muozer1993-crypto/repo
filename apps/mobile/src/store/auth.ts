import * as Localization from 'expo-localization';
import type { Me } from '@koydum/shared';
import { create } from 'zustand';

import { ApiClient } from '@/lib/api';
import { guessServerUrl, serverUrlIsEditable, stripTrailingSlash } from '@/lib/config';
import { queryClient } from '@/lib/query';
import { StorageKeys, getJson, removeItem, setItem, setJson } from '@/lib/storage';
import { clearReminders } from '@/services/reminders';
import { markTokenRenewed, renewTokenIfDue } from '@/services/session';

interface AuthState {
  hydrated: boolean;
  token: string | null;
  me: Me | null;
  serverUrl: string;
  /**
   * /health's `serverId` of the server this session was signed in on, once the
   * phone has heard it. It is what lets a new tunnel address be recognised as
   * the same server instead of costing everybody a logout (services/serverMove).
   */
  serverId: string | null;
  /** true while the initial /me refresh is in flight */
  refreshing: boolean;
  /**
   * The server turned the token down and the app logged out on its own. The
   * login screen says so once, then clears it, so nobody wonders why they are
   * looking at it.
   */
  sessionEnded: boolean;
  /**
   * The welcome slides are on screen, right after sign-up. NotificationBridge
   * holds back everything that raises a system dialog until they are gone, so
   * the notification and activity prompts come from the slide that explains
   * them, not on top of the first one. Never stored: an app restarted halfway
   * through simply asks the way it always did.
   */
  onboarding: boolean;

  hydrate: () => Promise<void>;
  setSession: (token: string, me: Me) => Promise<void>;
  setMe: (me: Me) => Promise<void>;
  setServerUrl: (url: string) => Promise<void>;
  /** Stores `id` as this session's server, if `forUrl` is still the address in use. */
  rememberServerId: (id: string | null | undefined, forUrl: string) => Promise<void>;
  logout: () => Promise<void>;
  clearSessionEnded: () => void;
  setOnboarding: (on: boolean) => void;
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
  serverId: null,
  refreshing: false,
  sessionEnded: false,
  onboarding: false,

  hydrate: async () => {
    const [token, me, storedUrl, serverId] = await Promise.all([
      getJson<string>(StorageKeys.token).then((value) =>
        typeof value === 'string' ? value : null
      ),
      getJson<Me>(StorageKeys.me),
      getJson<string>(StorageKeys.serverUrl),
      getJson<string>(StorageKeys.serverId),
    ]);
    set({
      token,
      me: me ?? null,
      serverId: typeof serverId === 'string' && serverId ? serverId : null,
      // a URL typed into an earlier (editable) build must not shadow the one a
      // production build has baked in — there would be no screen to change it
      serverUrl:
        serverUrlIsEditable() && typeof storedUrl === 'string' && storedUrl ? storedUrl : guessServerUrl(),
      hydrated: true,
    });
    if (token) {
      void get()
        .refreshMe()
        .then((fresh) => {
          // Only a token the server has just accepted is worth renewing; a dead
          // one already got its 401 and the logout that comes with it.
          if (!fresh) return;
          void renewTokenIfDue(get().client(), (next) => {
            // a logout or another login while the request was out wins
            if (get().token === token) set({ token: next });
          });
        });
    }
  },

  setSession: async (token, me) => {
    // a different account on the same phone must never read the previous one's
    // cached challenges, inbox or unread badge
    const previous = get().me;
    if (previous && previous.id !== me.id) queryClient.clear();
    set({ token, me, sessionEnded: false });
    // The address was right a moment ago, so this is the time to learn which
    // server it is: when the tunnel hands out a new address later, the id is
    // what tells "same server" from "another one". Best effort, never awaited.
    const url = get().serverUrl;
    void new ApiClient({ baseUrl: url, timeoutMs: 8000 })
      .health()
      .then((health) => get().rememberServerId(health.serverId, url))
      .catch(() => {});
    // every token handed to setSession was just signed, so the weekly renewal
    // has nothing to do for a while
    await Promise.all([setJson(StorageKeys.token, token), setJson(StorageKeys.me, me), markTokenRenewed()]);
  },

  setMe: async (me) => {
    set({ me });
    await setJson(StorageKeys.me, me);
  },

  setServerUrl: async (url) => {
    set({ serverUrl: url });
    await setItem(StorageKeys.serverUrl, JSON.stringify(url));
  },

  rememberServerId: async (id, forUrl) => {
    const { token, serverUrl, serverId } = get();
    // The id vouches for the server that issued the token, so it is kept only
    // while signed in, and only for the address still in use: an answer that
    // comes back after a move must not be filed under the new address.
    if (!id || !token || id === serverId) return;
    if (stripTrailingSlash(forUrl) !== stripTrailingSlash(serverUrl)) return;
    set({ serverId: id });
    await setJson(StorageKeys.serverId, id);
  },

  /**
   * Everything this account left on the device goes with it: the server stops
   * pushing to this phone, the react-query cache is dropped so the next login
   * cannot paint the previous user's rows, and the inbox cursor is reset so the
   * next account does not get local notifications for someone else's history.
   */
  logout: async () => {
    const { token, serverUrl } = get();
    if (token) {
      // Best effort, and deliberately not awaited: the server has to stop
      // pushing this account's taunts to the phone, but an unreachable server
      // must never trap the user in a session. A bare client is used so a 401
      // answer cannot re-enter `logout` through `onUnauthorized`.
      void new ApiClient({ baseUrl: serverUrl, token })
        .clearPushToken()
        .catch(() => {});
    }
    set({ token: null, me: null, serverId: null });
    // the next account must not be served this one's challenges, inbox or badge
    queryClient.clear();
    // nor ring for this account's check-ins: the alarms are the phone's own and
    // would go on for up to two weeks. Queued behind a refresh still in flight
    // (it would schedule them again). Not awaited, a failure only means one
    // stray alarm.
    void clearReminders().catch(() => {});
    await Promise.all([
      removeItem(StorageKeys.token),
      removeItem(StorageKeys.tokenRenewedAt),
      removeItem(StorageKeys.me),
      removeItem(StorageKeys.serverId),
      removeItem(StorageKeys.pushToken),
      // otherwise the next account's first poll replays its history as local
      // notifications
      removeItem(StorageKeys.lastInboxId),
    ]);
  },

  clearSessionEnded: () => set({ sessionEnded: false }),

  setOnboarding: (on) => set({ onboarding: on }),

  client: () => {
    const { serverUrl, token } = get();
    return new ApiClient({
      baseUrl: serverUrl,
      token,
      onUnauthorized: () => {
        // A wrong password on the login screen is a 401 too, and there is no
        // session to lose there.
        if (get().token) set({ sessionEnded: true });
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

/** The vulgarity level used for UI copy (defaults to "delikanlı" before login). */
export function useLevel(): 1 | 2 | 3 {
  return useAuth((state) => state.me?.vulgarityMax ?? 2);
}
