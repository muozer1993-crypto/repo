import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

import {
  isExpoGo,
  localNotifications,
  pushNotifications,
} from '@/services/expoNotifications';
import { Colors } from '@/theme';

/**
 * Push + local notifications.
 *
 * Every function here is defensive: KOYDUM has to keep working in Expo Go (no
 * Android push — and the library throws at import time there, which is why
 * nothing below touches `expo-notifications` directly; see
 * `services/expoNotifications.ts`), on a simulator (no push token) and on the
 * web (no module at all). Failure to register is never fatal — the in-app inbox
 * is the source of truth and the app polls it.
 */

export const ANDROID_CHANNEL_ID = 'koydum';

export { isExpoGo };

let handlerInstalled = false;

export function installNotificationHandler(): void {
  if (handlerInstalled || Platform.OS === 'web') return;
  const api = localNotifications();
  if (!api) return;
  handlerInstalled = true;
  try {
    api.setNotificationHandler({
      handleNotification: async () => ({
        shouldPlaySound: true,
        shouldSetBadge: true,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
  } catch {
    // an unusable handler must not take the screen that installed it down
  }
}

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const api = localNotifications();
  if (!api) return;
  await api.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
    name: 'KOYDUM',
    importance: api.AndroidImportance.MAX,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: Colors.accent,
    lockscreenVisibility: api.AndroidNotificationVisibility.PUBLIC,
  });
}

export interface PushRegistration {
  token: string | null;
  granted: boolean;
  /** why there is no token, for the settings screen */
  reason?:
    | 'web'
    | 'simulator'
    | 'denied'
    | 'no-project-id'
    | 'expo-go-android'
    | 'unavailable'
    | 'error';
  detail?: string;
}

function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;
}

export async function registerForPush(): Promise<PushRegistration> {
  if (Platform.OS === 'web') return { token: null, granted: false, reason: 'web' };

  try {
    const api = localNotifications();
    if (!api) return { token: null, granted: false, reason: 'unavailable' };

    installNotificationHandler();
    await ensureAndroidChannel();

    if (!Device.isDevice) {
      return { token: null, granted: false, reason: 'simulator' };
    }

    const existing = await api.getPermissionsAsync();
    let status = existing.status;
    if (status !== 'granted') {
      const asked = await api.requestPermissionsAsync();
      status = asked.status;
    }
    if (status !== 'granted') {
      return { token: null, granted: false, reason: 'denied' };
    }

    const push = pushNotifications();
    if (!push) {
      // local notifications still work, so we keep permission but have no token
      return {
        token: null,
        granted: true,
        reason: Platform.OS === 'android' && isExpoGo() ? 'expo-go-android' : 'unavailable',
      };
    }

    const id = projectId();
    if (!id) {
      return { token: null, granted: true, reason: 'no-project-id' };
    }

    const result = await push.getExpoPushTokenAsync({ projectId: id });
    return { token: result.data, granted: true };
  } catch (error) {
    return {
      token: null,
      granted: false,
      reason: 'error',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Fire a notification from the device itself (used when push is unavailable). */
export async function fireLocal(
  title: string,
  body: string,
  data: Record<string, unknown> = {}
): Promise<void> {
  if (Platform.OS === 'web') return;
  const api = localNotifications();
  if (!api) return;
  try {
    installNotificationHandler();
    await ensureAndroidChannel();
    await api.scheduleNotificationAsync({
      content: { title, body, data, sound: true },
      trigger: null,
    });
  } catch {
    // a failed local notification must never break the calling screen
  }
}

export async function setBadgeCount(count: number): Promise<void> {
  if (Platform.OS === 'web') return;
  const api = localNotifications();
  if (!api) return;
  try {
    await api.setBadgeCountAsync(Math.max(0, count));
  } catch {
    // ignore
  }
}

export type NotificationRoute =
  | { kind: 'challenge'; challengeId: string }
  | { kind: 'results'; challengeId: string }
  | { kind: 'inbox' }
  | { kind: 'friends' }
  | null;

/** Maps a notification payload to the screen it should open. */
export function routeForNotificationData(data: unknown): NotificationRoute {
  if (!data || typeof data !== 'object') return null;
  const payload = data as Record<string, unknown>;
  const type = typeof payload.type === 'string' ? payload.type : '';
  const challengeId = typeof payload.challengeId === 'string' ? payload.challengeId : null;

  if (type === 'friend_request' || type === 'friend_accepted') return { kind: 'friends' };
  if (!challengeId) return { kind: 'inbox' };
  if (type === 'taunt' || type === 'challenge_finished') return { kind: 'results', challengeId };
  return { kind: 'challenge', challengeId };
}

const NO_SUBSCRIPTION = { remove: () => {} };

export function addResponseListener(
  handler: (route: NotificationRoute) => void
): { remove: () => void } {
  if (Platform.OS === 'web') return NO_SUBSCRIPTION;
  const api = localNotifications();
  if (!api) return NO_SUBSCRIPTION;
  try {
    const sub = api.addNotificationResponseReceivedListener((response) => {
      handler(routeForNotificationData(response.notification.request.content.data));
    });
    return { remove: () => sub.remove() };
  } catch {
    return NO_SUBSCRIPTION;
  }
}

export function addReceivedListener(
  handler: (title: string, body: string, data: unknown) => void
): { remove: () => void } {
  if (Platform.OS === 'web') return NO_SUBSCRIPTION;
  const api = localNotifications();
  if (!api) return NO_SUBSCRIPTION;
  try {
    const sub = api.addNotificationReceivedListener((notification) => {
      const { title, body, data } = notification.request.content;
      handler(title ?? '', body ?? '', data);
    });
    return { remove: () => sub.remove() };
  } catch {
    return NO_SUBSCRIPTION;
  }
}

/** The notification that launched the app, if any. */
export async function getInitialRoute(): Promise<NotificationRoute> {
  if (Platform.OS === 'web') return null;
  const api = localNotifications();
  if (!api) return null;
  try {
    const response = await api.getLastNotificationResponseAsync();
    if (!response) return null;
    return routeForNotificationData(response.notification.request.content.data);
  } catch {
    return null;
  }
}
