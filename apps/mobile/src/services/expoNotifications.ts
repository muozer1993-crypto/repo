import { Platform } from 'react-native';

/**
 * The only place in the app that is allowed to load `expo-notifications`.
 *
 * `import * as Notifications from 'expo-notifications'` THROWS while the module
 * is being evaluated when the app runs inside Expo Go on Android: the barrel
 * re-exports `DevicePushTokenAutoRegistration.fx`, whose module scope calls
 * `addPushTokenListener()`, which calls `warnOfExpoGoPushUsage()`, which throws
 * on Android in Expo Go (node_modules/expo-notifications/build/
 * warnOfExpoGoPushUsage.js:9). Push was removed from Expo Go in SDK 53.
 *
 * A throw during module evaluation is fatal for Expo Router: the route module
 * ends up `undefined`, the router reports "missing the required default export"
 * and then dies on `Cannot read property 'ErrorBoundary' of undefined`. In other
 * words, the entire app white-screens because push is unavailable — on the one
 * runtime most people will try it in first.
 *
 * So: nothing else imports the library directly. This module loads it lazily
 * inside a try/catch, and when the barrel refuses it assembles the same surface
 * from the deep modules that hold the *local* notification API. Every one of
 * those was checked against the installed tree (57.0.17) and none of them pulls
 * in the poisoned import. Local notifications, the Android channel, permissions
 * and tap handling therefore keep working in Expo Go; only the push token is
 * lost, and the app already has a name for that state ('expo-go-android').
 */

type NotificationsModule = typeof import('expo-notifications');

/** The subset the app uses that works without remote push. */
export type LocalNotifications = Pick<
  NotificationsModule,
  | 'setNotificationHandler'
  | 'setNotificationChannelAsync'
  | 'getPermissionsAsync'
  | 'requestPermissionsAsync'
  | 'scheduleNotificationAsync'
  | 'getAllScheduledNotificationsAsync'
  | 'cancelScheduledNotificationAsync'
  | 'setBadgeCountAsync'
  | 'addNotificationReceivedListener'
  | 'addNotificationResponseReceivedListener'
  | 'getLastNotificationResponseAsync'
  | 'AndroidImportance'
  | 'AndroidNotificationVisibility'
  | 'SchedulableTriggerInputTypes'
>;

/** The part that only a development build (or iOS Expo Go) can do. */
export type PushNotifications = Pick<NotificationsModule, 'getExpoPushTokenAsync'>;

/* eslint-disable @typescript-eslint/no-require-imports -- see the header: these
   have to be runtime requires so that a throwing module can be caught. */

/** True when the app is running inside the Expo Go client. */
export function isExpoGo(): boolean {
  try {
    const expo = require('expo') as { isRunningInExpoGo?: () => boolean };
    if (typeof expo.isRunningInExpoGo === 'function') return expo.isRunningInExpoGo();
  } catch {
    // fall through to the expo-constants answer
  }
  try {
    const constants = (require('expo-constants') as { default?: { appOwnership?: string | null } })
      .default;
    return constants?.appOwnership === 'expo';
  } catch {
    return false;
  }
}

/** True when we already know the barrel will throw, so we do not even try it. */
function pushIsRemovedHere(): boolean {
  return Platform.OS === 'android' && isExpoGo();
}

function loadBarrel(): NotificationsModule | null {
  try {
    return require('expo-notifications') as NotificationsModule;
  } catch {
    return null;
  }
}

/**
 * Rebuilds the local API out of the deep modules. Each specifier below is a
 * literal because Metro can only resolve literal requires, and each one is a
 * leaf that does not reach `DevicePushTokenAutoRegistration.fx`.
 */
function loadLocalOnly(): LocalNotifications | null {
  try {
    const handler = require('expo-notifications/build/NotificationsHandler');
    const emitter = require('expo-notifications/build/NotificationsEmitter');
    const permissions = require('expo-notifications/build/NotificationPermissions');
    const scheduling = require('expo-notifications/build/scheduleNotificationAsync');
    const listScheduled = require('expo-notifications/build/getAllScheduledNotificationsAsync');
    const cancelScheduled = require('expo-notifications/build/cancelScheduledNotificationAsync');
    const channels = require('expo-notifications/build/setNotificationChannelAsync');
    const badge = require('expo-notifications/build/setBadgeCountAsync');
    const commonTypes = require('expo-notifications/build/Notifications.types');
    const androidTypes = require('expo-notifications/build/NotificationChannelManager.types');

    const local = {
      setNotificationHandler: handler.setNotificationHandler,
      setNotificationChannelAsync: channels.setNotificationChannelAsync,
      getPermissionsAsync: permissions.getPermissionsAsync,
      requestPermissionsAsync: permissions.requestPermissionsAsync,
      scheduleNotificationAsync: scheduling.scheduleNotificationAsync,
      getAllScheduledNotificationsAsync: listScheduled.getAllScheduledNotificationsAsync,
      cancelScheduledNotificationAsync: cancelScheduled.cancelScheduledNotificationAsync,
      setBadgeCountAsync: badge.setBadgeCountAsync,
      addNotificationReceivedListener: emitter.addNotificationReceivedListener,
      addNotificationResponseReceivedListener: emitter.addNotificationResponseReceivedListener,
      getLastNotificationResponseAsync: emitter.getLastNotificationResponseAsync,
      AndroidImportance: androidTypes.AndroidImportance,
      AndroidNotificationVisibility: androidTypes.AndroidNotificationVisibility,
      SchedulableTriggerInputTypes: commonTypes.SchedulableTriggerInputTypes,
    };

    // a half-loaded module is worse than none: the caller would crash later
    for (const value of Object.values(local)) {
      if (value === undefined || value === null) return null;
    }
    return local as LocalNotifications;
  } catch {
    return null;
  }
}

/* eslint-enable @typescript-eslint/no-require-imports */

let localCache: LocalNotifications | null | undefined;
let pushCache: PushNotifications | null | undefined;

/**
 * The local notification API, or `null` where there is none (web, or a runtime
 * that refuses the module altogether). Never throws.
 */
export function localNotifications(): LocalNotifications | null {
  if (localCache !== undefined) return localCache;
  if (Platform.OS === 'web') {
    localCache = null;
    return null;
  }
  const barrel = pushIsRemovedHere() ? null : loadBarrel();
  localCache = barrel ?? loadLocalOnly();
  return localCache;
}

/**
 * The push-token API, or `null` when this runtime cannot mint one (Expo Go on
 * Android, the web). Never throws.
 */
export function pushNotifications(): PushNotifications | null {
  if (pushCache !== undefined) return pushCache;
  if (Platform.OS === 'web' || pushIsRemovedHere()) {
    pushCache = null;
    return null;
  }
  const barrel = loadBarrel();
  pushCache = barrel && typeof barrel.getExpoPushTokenAsync === 'function' ? barrel : null;
  return pushCache;
}

/** Test seam: forget what was loaded so the next call decides again. */
export function resetNotificationModuleCache(): void {
  localCache = undefined;
  pushCache = undefined;
}
