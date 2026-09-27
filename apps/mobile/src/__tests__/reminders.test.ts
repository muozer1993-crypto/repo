/* eslint-disable import/first -- the jest.mock calls must run before the modules under test are imported */
import type { ChallengeSummary } from '@koydum/shared';

/**
 * The phone's own reminders: the maths of the check-in slot, and the switch in
 * Ayarlar that turns them off without touching anything the server sends.
 */

/** What the OS holds right now: scheduling adds to it, cancelling takes away. */
const mockScheduled: { identifier: string; content: { data: Record<string, unknown> } }[] = [];
let mockNextId = 0;
const mockSchedule = jest.fn(async (request: { content: { data: Record<string, unknown> } }) => {
  mockNextId += 1;
  const identifier = `n${mockNextId}`;
  mockScheduled.push({ identifier, content: request.content });
  return identifier;
});
const mockCancel = jest.fn(async (identifier: string) => {
  const index = mockScheduled.findIndex((item) => item.identifier === identifier);
  if (index >= 0) mockScheduled.splice(index, 1);
});

jest.mock('@/services/expoNotifications', () => ({
  localNotifications: () => ({
    getPermissionsAsync: async () => ({ status: 'granted' }),
    getAllScheduledNotificationsAsync: async () => [...mockScheduled],
    cancelScheduledNotificationAsync: mockCancel,
    scheduleNotificationAsync: mockSchedule,
    SchedulableTriggerInputTypes: { DAILY: 'daily', DATE: 'date', TIME_INTERVAL: 'timeInterval' },
  }),
}));

jest.mock('@/services/notifications', () => ({
  ANDROID_CHANNEL_ID: 'koydum',
  installNotificationHandler: () => {},
}));

import AsyncStorage from '@react-native-async-storage/async-storage';

import { StorageKeys } from '@/lib/storage';
import {
  REMINDER_KIND,
  deviceRemindersEnabled,
  minusMinutes,
  refreshReminders,
  setDeviceRemindersEnabled,
} from '@/services/reminders';

describe('reminder scheduling maths', () => {
  it('subtracts minutes from a HH:mm deadline', () => {
    expect(minusMinutes('07:00', 30)).toEqual({ hour: 6, minute: 30 });
    expect(minusMinutes('23:00', 45)).toEqual({ hour: 22, minute: 15 });
    expect(minusMinutes('09:15', 15)).toEqual({ hour: 9, minute: 0 });
  });

  it('wraps around midnight', () => {
    expect(minusMinutes('00:10', 30)).toEqual({ hour: 23, minute: 40 });
    expect(minusMinutes('00:00', 1)).toEqual({ hour: 23, minute: 59 });
  });

  it('rejects nonsense', () => {
    expect(minusMinutes('24:00', 30)).toBeNull();
    expect(minusMinutes('7:00', 30)).toBeNull();
    expect(minusMinutes('', 30)).toBeNull();
  });
});

/** A check-in çelınc that ends in five hours: a daily slot and a last-hour warning. */
function checkinSummary(): ChallengeSummary {
  return {
    challenge: {
      id: 'c1',
      title: 'Sabah Kalkma',
      endsAt: new Date(Date.now() + 5 * 60 * 60_000).toISOString(),
      metricType: 'checkin_deadline',
      deadlineTime: '07:00',
    },
    me: { lastEntryAt: null },
  } as unknown as ChallengeSummary;
}

describe('the "Saatli çelınc uyarıları" switch', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    mockScheduled.splice(0);
    mockSchedule.mockClear();
    mockCancel.mockClear();
  });

  it('is on until somebody switches it off, and remembers either way', async () => {
    expect(await deviceRemindersEnabled()).toBe(true);
    await setDeviceRemindersEnabled(false);
    expect(await deviceRemindersEnabled()).toBe(false);
    expect(await AsyncStorage.getItem(StorageKeys.deviceRemindersOff)).toBe('1');
    await setDeviceRemindersEnabled(true);
    expect(await deviceRemindersEnabled()).toBe(true);
  });

  it('schedules what the open çelınclar need while it is on', async () => {
    const client = { challenges: jest.fn(async () => [checkinSummary()]) };

    expect(await refreshReminders(client, 2, 'Europe/Istanbul')).toBe(2);
    expect(client.challenges).toHaveBeenCalledWith('active,pending');
    expect(mockSchedule).toHaveBeenCalledTimes(2);
  });

  it('clears what is already on the phone and schedules nothing once it is off', async () => {
    mockScheduled.push(
      { identifier: 'old-1', content: { data: { kind: REMINDER_KIND, reminder: 'checkin', challengeId: 'c1' } } },
      { identifier: 'old-2', content: { data: { kind: REMINDER_KIND, reminder: 'last_hour', challengeId: 'c1' } } },
      // somebody else's notification is not ours to cancel
      { identifier: 'other', content: { data: { kind: 'something-else' } } }
    );
    await setDeviceRemindersEnabled(false);
    const client = { challenges: jest.fn(async () => [checkinSummary()]) };

    expect(await refreshReminders(client, 2, 'Europe/Istanbul')).toBe(0);

    expect(mockCancel.mock.calls.map(([identifier]) => identifier)).toEqual(['old-1', 'old-2']);
    expect(mockScheduled.map((item) => item.identifier)).toEqual(['other']);
    expect(mockSchedule).not.toHaveBeenCalled();
    // nothing to schedule means nothing to ask the server
    expect(client.challenges).not.toHaveBeenCalled();
  });

  it('does not let a refresh still waiting on the list schedule after the switch went off', async () => {
    let release!: (value: ChallengeSummary[]) => void;
    const slow = { challenges: jest.fn(() => new Promise<ChallengeSummary[]>((resolve) => (release = resolve))) };
    const first = refreshReminders(slow, 2, 'Europe/Istanbul');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Ayarlar: store the switch, then refresh
    await setDeviceRemindersEnabled(false);
    const second = refreshReminders({ challenges: jest.fn(async () => []) }, 2, 'Europe/Istanbul');
    release([checkinSummary()]);
    await first;
    await second;

    // the first run did schedule, but the second one waited for it and cleared everything
    expect(mockSchedule).toHaveBeenCalledTimes(2);
    expect(mockScheduled).toEqual([]);
  });
});
