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
import { fireLocal, pushPermissionStatus, registerForPush, routeForNotificationData } from '@/services/notifications';
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
    // channels are an Android thing; everywhere else "now" is a null trigger
    expect(mockSchedule).toHaveBeenCalledWith(expect.objectContaining({ trigger: null }));
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

  it('reads the permission for the home card without ever asking for it', async () => {
    const permissions = require('expo-notifications/build/NotificationPermissions') as {
      getPermissionsAsync: jest.Mock;
      requestPermissionsAsync: jest.Mock;
    };
    permissions.requestPermissionsAsync.mockClear();
    permissions.getPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });
    expect(await pushPermissionStatus()).toBe('denied');
    permissions.getPermissionsAsync.mockResolvedValueOnce({ status: 'undetermined' });
    expect(await pushPermissionStatus()).toBe('undetermined');
    expect(await pushPermissionStatus()).toBe('granted');
    permissions.getPermissionsAsync.mockRejectedValueOnce(new Error('ReactContextLost'));
    expect(await pushPermissionStatus()).toBe('unknown');
    expect(permissions.requestPermissionsAsync).not.toHaveBeenCalled();
  });
});

describe('where a tapped notification goes', () => {
  it('opens the results for the winner\'s "hâlâ bekliyor" reminder, where the laf is sent', () => {
    expect(routeForNotificationData({ type: 'reminder', kind: 'taunt_followup', challengeId: 'c1' })).toEqual({
      kind: 'results',
      challengeId: 'c1',
    });
  });

  it('keeps every other reminder on the çelınc itself', () => {
    // the phone's own check-in / last-hour reminders carry a kind too
    expect(
      routeForNotificationData({ type: 'reminder', kind: 'koydum.reminder', reminder: 'checkin', challengeId: 'c1' })
    ).toEqual({ kind: 'challenge', challengeId: 'c1' });
    expect(routeForNotificationData({ type: 'reminder', dayKey: '2026-09-27' })).toEqual({ kind: 'inbox' });
  });

  it('keeps the inbox row it came from, so the tap can mark it read', () => {
    // the server's push and the phone's own copy (fireLocal) both carry it
    expect(routeForNotificationData({ type: 'poke', challengeId: 'c1', notificationId: 'n1' })).toEqual({
      kind: 'challenge',
      challengeId: 'c1',
      notificationId: 'n1',
    });
    expect(routeForNotificationData({ type: 'taunt', challengeId: 'c1', tauntId: 't1', notificationId: 'n2' })).toEqual({
      kind: 'results',
      challengeId: 'c1',
      notificationId: 'n2',
    });
    expect(routeForNotificationData({ type: 'friend_request', notificationId: 'n3' })).toEqual({
      kind: 'friends',
      notificationId: 'n3',
    });
    expect(routeForNotificationData({ type: 'badge', notificationId: 'n4' })).toEqual({
      kind: 'inbox',
      notificationId: 'n4',
    });
  });

  it('adds no id when there is no row behind it', () => {
    // the phone's own reminders and the "N bildirim daha" summary
    expect(routeForNotificationData({ type: 'inbox' })).toEqual({ kind: 'inbox' });
    expect(routeForNotificationData({ type: 'taunt', challengeId: 'c1', notificationId: 42 })).toEqual({
      kind: 'results',
      challengeId: 'c1',
    });
  });
});
