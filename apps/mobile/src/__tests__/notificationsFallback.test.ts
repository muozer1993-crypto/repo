/* eslint-disable import/first -- the jest.mock calls must run before the modules under test are imported */
/**
 * The barrel throwing must degrade to the local-notification surface, not to a
 * dead app. This reproduces the Expo Go / Android failure by making the module
 * throw on require, exactly as `warnOfExpoGoPushUsage` does on a real phone.
 */

jest.mock('expo-notifications', () => {
  throw new Error(
    'expo-notifications: Android Push notifications (remote notifications) functionality ' +
      'provided by expo-notifications was removed from Expo Go with the release of SDK 53.'
  );
});

const mockSchedule = jest.fn(async () => 'id-1');
const mockSetHandler = jest.fn();

jest.mock('expo-notifications/build/NotificationsHandler', () => ({
  setNotificationHandler: mockSetHandler,
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
  setNotificationChannelAsync: jest.fn(async () => null),
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

import { localNotifications, pushNotifications, resetNotificationModuleCache } from '@/services/expoNotifications';
import { fireLocal, registerForPush } from '@/services/notifications';
import { syncReminders } from '@/services/reminders';

beforeEach(() => {
  resetNotificationModuleCache();
  mockSchedule.mockClear();
  mockSetHandler.mockClear();
});

describe('when expo-notifications refuses to load', () => {
  it('still hands back the local notification surface', () => {
    const api = localNotifications();
    expect(api).not.toBeNull();
    expect(typeof api?.scheduleNotificationAsync).toBe('function');
    expect(api?.AndroidImportance.MAX).toBe(5);
  });

  it('has no push surface', () => {
    expect(pushNotifications()).toBeNull();
  });

  it('reports a registration without a token instead of throwing', async () => {
    const registration = await registerForPush();
    expect(registration.token).toBeNull();
    expect(registration.reason).toBeDefined();
  });

  it('still fires a local notification', async () => {
    await fireLocal('KOYDUM', 'Mustafa sana sapır sapır sapladı');
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it('still schedules reminders', async () => {
    const count = await syncReminders(
      [
        {
          id: 'c1',
          title: 'Sabah Kalkma',
          endsAt: new Date(Date.now() + 5 * 60 * 60_000).toISOString(),
          metricType: 'checkin_deadline',
          deadlineTime: '07:00',
          doneToday: false,
        },
      ],
      3
    );
    expect(count).toBe(2);
    expect(mockSchedule).toHaveBeenCalledTimes(2);
  });
});
