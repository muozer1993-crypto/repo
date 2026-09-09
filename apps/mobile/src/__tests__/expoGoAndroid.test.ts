/* eslint-disable import/first -- the jest.mock calls must run before the modules under test are imported */
/**
 * The exact runtime that took the app down: Expo Go, Android.
 *
 * There, requiring `expo-notifications` throws. This test proves two things:
 * the app never requires it in the first place on that runtime, and the local
 * notification surface still comes back so reminders and the taunt fallback
 * keep working.
 */

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: {
    OS: 'android',
    select: (options: Record<string, unknown>) =>
      options.android ?? options.native ?? options.default,
  },
}));

const mockBarrelRequired = jest.fn();
jest.mock('expo-notifications', () => {
  mockBarrelRequired();
  throw new Error(
    'expo-notifications: Android Push notifications (remote notifications) functionality ' +
      'provided by expo-notifications was removed from Expo Go with the release of SDK 53.'
  );
});

// a Proxy rather than a spread: the real module is full of lazy getters that
// blow up when they are all read at once
jest.mock('expo', () => {
  const actual = jest.requireActual('expo');
  return new Proxy(actual, {
    get: (target, property) =>
      property === 'isRunningInExpoGo' ? () => true : Reflect.get(target, property),
  });
});

jest.mock('expo-device', () => ({ isDevice: true })); // a real phone, not an emulator

const mockSchedule = jest.fn(async () => 'id-1');
const mockChannel = jest.fn(async () => null);

jest.mock('expo-notifications/build/NotificationsHandler', () => ({
  setNotificationHandler: jest.fn(),
}));
jest.mock('expo-notifications/build/NotificationsEmitter', () => ({
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  getLastNotificationResponseAsync: jest.fn(async () => null),
}));
jest.mock('expo-notifications/build/NotificationPermissions', () => ({
  getPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
}));
jest.mock('expo-notifications/build/scheduleNotificationAsync', () => ({
  scheduleNotificationAsync: mockSchedule,
}));
jest.mock('expo-notifications/build/getAllScheduledNotificationsAsync', () => ({
  getAllScheduledNotificationsAsync: jest.fn(async () => []),
}));
jest.mock('expo-notifications/build/cancelScheduledNotificationAsync', () => ({
  cancelScheduledNotificationAsync: jest.fn(async () => {}),
}));
jest.mock('expo-notifications/build/setNotificationChannelAsync', () => ({
  setNotificationChannelAsync: mockChannel,
}));
jest.mock('expo-notifications/build/setBadgeCountAsync', () => ({
  setBadgeCountAsync: jest.fn(async () => true),
}));
jest.mock('expo-notifications/build/Notifications.types', () => ({
  SchedulableTriggerInputTypes: { DAILY: 'daily', TIME_INTERVAL: 'timeInterval' },
}));
jest.mock('expo-notifications/build/NotificationChannelManager.types', () => ({
  AndroidImportance: { MAX: 5 },
  AndroidNotificationVisibility: { PUBLIC: 1 },
}));

import { Platform } from 'react-native';

import {
  isExpoGo,
  localNotifications,
  pushNotifications,
  resetNotificationModuleCache,
} from '@/services/expoNotifications';
import { fireLocal, registerForPush } from '@/services/notifications';

beforeEach(() => {
  resetNotificationModuleCache();
  mockBarrelRequired.mockClear();
  mockSchedule.mockClear();
  mockChannel.mockClear();
});

describe('Expo Go on Android', () => {
  it('is the runtime under test', () => {
    expect(Platform.OS).toBe('android');
    expect(isExpoGo()).toBe(true);
  });

  it('never requires the module that throws', () => {
    expect(localNotifications()).not.toBeNull();
    expect(pushNotifications()).toBeNull();
    expect(mockBarrelRequired).not.toHaveBeenCalled();
  });

  it('reports expo-go-android rather than failing registration', async () => {
    const registration = await registerForPush();
    expect(registration.reason).toBe('expo-go-android');
    expect(registration.granted).toBe(true);
    expect(registration.token).toBeNull();
    expect(mockBarrelRequired).not.toHaveBeenCalled();
  });

  it('creates the KOYDUM channel and still fires the taunt locally', async () => {
    await fireLocal('KOYDUM', 'Mustafa sana sapır sapır sapladı', { type: 'taunt' });
    expect(mockChannel).toHaveBeenCalledWith('koydum', expect.objectContaining({ name: 'KOYDUM' }));
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });
});
