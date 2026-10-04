/* eslint-disable import/first -- the jest.mock calls must run before the modules under test are imported */
import type { ChallengeSummary } from '@koydum/shared';

/**
 * The phone's own reminders: the maths of the check-in slot, which days get
 * one, and the switch in Ayarlar that turns them off without touching anything
 * the server sends.
 */

interface MockRequest {
  identifier?: string;
  content: { data: Record<string, unknown> };
  trigger: { type: string; date?: Date; seconds?: number };
}

/** What the OS holds right now: scheduling adds to it, cancelling takes away. */
const mockScheduled: { identifier: string; content: { data: Record<string, unknown> } }[] = [];
let mockNextId = 0;
const mockSchedule = jest.fn(async (request: MockRequest) => {
  mockNextId += 1;
  // like the OS: the same identifier replaces what was there
  const identifier = request.identifier ?? `n${mockNextId}`;
  const index = mockScheduled.findIndex((item) => item.identifier === identifier);
  if (index >= 0) mockScheduled.splice(index, 1);
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

const mockEnsureChannel = jest.fn(async () => {});

jest.mock('@/services/notifications', () => ({
  ANDROID_CHANNEL_ID: 'koydum',
  ensureAndroidChannel: () => mockEnsureChannel(),
  installNotificationHandler: () => {},
}));

import AsyncStorage from '@react-native-async-storage/async-storage';

import { StorageKeys } from '@/lib/storage';
import {
  REMINDER_KIND,
  clearReminders,
  deviceRemindersEnabled,
  minusMinutes,
  refreshReminders,
  setDeviceRemindersEnabled,
  skipTodayCheckinReminder,
} from '@/services/reminders';

/** 06:00 on a Monday in Istanbul: half an hour before a 07:00 çelınc's poke. */
const NOW = new Date('2026-10-05T03:00:00.000Z');
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const TZ = 'Europe/Istanbul';

// only the clock: the queue test below still needs a real setTimeout
beforeAll(() => {
  jest.useFakeTimers({
    now: NOW,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
});

afterAll(() => {
  jest.useRealTimers();
});

beforeEach(async () => {
  await AsyncStorage.clear();
  mockScheduled.splice(0);
  mockSchedule.mockClear();
  mockCancel.mockClear();
  mockEnsureChannel.mockClear();
});

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

/** A 07:00 check-in çelınc, by default one that ends in five hours: today's slot and a last-hour warning. */
function checkinSummary(
  overrides: {
    id?: string;
    startsAt?: Date;
    endsAt?: Date;
    deadlineTime?: string;
    status?: 'invited' | 'accepted';
    lastEntryAt?: string | null;
  } = {}
): ChallengeSummary {
  return {
    challenge: {
      id: overrides.id ?? 'c1',
      title: 'Sabah Kalkma',
      startsAt: (overrides.startsAt ?? new Date(Date.now() - 2 * DAY_MS)).toISOString(),
      endsAt: (overrides.endsAt ?? new Date(Date.now() + 5 * HOUR_MS)).toISOString(),
      metricType: 'checkin_deadline',
      deadlineTime: overrides.deadlineTime ?? '07:00',
    },
    me: { status: overrides.status ?? 'accepted', lastEntryAt: overrides.lastEntryAt ?? null },
  } as unknown as ChallengeSummary;
}

function listOf(...summaries: ChallengeSummary[]) {
  return { challenges: jest.fn(async () => summaries) };
}

/** What each schedule call asked for, check-in pokes only. */
function checkinRequests(): MockRequest[] {
  return mockSchedule.mock.calls.map(([request]) => request).filter((request) => request.content.data.reminder === 'checkin');
}

describe('which days get a check-in poke', () => {
  it('sets one dated poke per day left, none at or after the end and none repeating', async () => {
    const client = listOf(checkinSummary({ endsAt: new Date(NOW.getTime() + 2 * DAY_MS) }));

    // 06:30 today and tomorrow; the day after it is over by 06:00. Plus the last hour.
    expect(await refreshReminders(client, 2, TZ)).toBe(3);

    const checkins = checkinRequests();
    expect(checkins.map((request) => request.identifier)).toEqual([
      'koydum-checkin-c1-2026-10-05',
      'koydum-checkin-c1-2026-10-06',
    ]);
    expect(checkins.map((request) => request.trigger.date?.toISOString())).toEqual([
      '2026-10-05T03:30:00.000Z',
      '2026-10-06T03:30:00.000Z',
    ]);
    expect(mockSchedule.mock.calls.every(([request]) => request.trigger.type !== 'daily')).toBe(true);
    // ready() made sure the channel exists before anything went to it
    expect(mockEnsureChannel).toHaveBeenCalled();
    expect(mockEnsureChannel.mock.invocationCallOrder[0]).toBeLessThan(
      mockSchedule.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('schedules nothing for a çelınc the reader was only invited to', async () => {
    const client = listOf(checkinSummary({ status: 'invited', endsAt: new Date(NOW.getTime() + 5 * DAY_MS) }));

    expect(await refreshReminders(client, 3, TZ)).toBe(0);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('starts a çelınc that has not begun on its first day', async () => {
    // starts at midnight three days from now, runs a week
    const startsAt = new Date('2026-10-07T21:00:00.000Z');
    const client = listOf(checkinSummary({ startsAt, endsAt: new Date(startsAt.getTime() + 7 * DAY_MS) }));

    await refreshReminders(client, 1, TZ);

    const checkins = checkinRequests();
    expect(checkins[0]?.identifier).toBe('koydum-checkin-c1-2026-10-08');
    expect(checkins[0]?.trigger.date?.toISOString()).toBe('2026-10-08T03:30:00.000Z');
    expect(checkins).toHaveLength(7);
  });

  it('skips today once today is checked in', async () => {
    const client = listOf(
      checkinSummary({
        endsAt: new Date(NOW.getTime() + 2 * DAY_MS),
        lastEntryAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
      })
    );

    await refreshReminders(client, 2, TZ);

    expect(checkinRequests().map((request) => request.identifier)).toEqual(['koydum-checkin-c1-2026-10-06']);
  });

  it('pokes a 00:10 deadline at 23:40 the evening before', async () => {
    const client = listOf(checkinSummary({ deadlineTime: '00:10', endsAt: new Date(NOW.getTime() + 2 * DAY_MS) }));

    await refreshReminders(client, 2, TZ);

    // today's 00:10 is long gone; tomorrow's is poked tonight
    const checkins = checkinRequests();
    expect(checkins[0]?.identifier).toBe('koydum-checkin-c1-2026-10-06');
    expect(checkins[0]?.trigger.date?.toISOString()).toBe('2026-10-05T20:40:00.000Z');
  });

  it('takes back only today\'s poke after a check-in, and a refresh does not put it back', async () => {
    // a parked check-in: the server still says nothing was entered today
    const client = listOf(checkinSummary({ id: 'c9', endsAt: new Date(NOW.getTime() + 2 * DAY_MS) }));
    await refreshReminders(client, 2, TZ);
    mockCancel.mockClear();

    await skipTodayCheckinReminder('c9', TZ);

    expect(mockCancel.mock.calls.map(([identifier]) => identifier)).toEqual(['koydum-checkin-c9-2026-10-05']);
    expect(mockScheduled.map((item) => item.identifier)).toContain('koydum-checkin-c9-2026-10-06');
    expect(mockScheduled.map((item) => item.identifier)).not.toContain('koydum-checkin-c9-2026-10-05');

    await refreshReminders(client, 2, TZ);
    expect(mockScheduled.map((item) => item.identifier)).not.toContain('koydum-checkin-c9-2026-10-05');
    expect(mockScheduled.map((item) => item.identifier)).toContain('koydum-checkin-c9-2026-10-06');
  });
});

describe('the "Saatli çelınc uyarıları" switch', () => {
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

  it('does not let a refresh still waiting on the list schedule the old account\'s alarms after logout', async () => {
    let release!: (value: ChallengeSummary[]) => void;
    const slow = { challenges: jest.fn(() => new Promise<ChallengeSummary[]>((resolve) => (release = resolve))) };
    const inFlight = refreshReminders(slow, 2, 'Europe/Istanbul');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Çıkış yap while the list is still on its way (the old token still works)
    const cleared = clearReminders();
    release([checkinSummary()]);
    await inFlight;
    await cleared;

    expect(mockSchedule).toHaveBeenCalled();
    expect(mockScheduled).toEqual([]);
  });
});
