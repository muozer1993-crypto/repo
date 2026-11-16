/* eslint-disable import/first -- the jest.mock calls must run before the modules under test are imported */
import type { ChallengeSummary } from '@koydum/shared';

/**
 * The phone's own reminders: the maths of the check-in slot, which days get
 * one, and the switch in Ayarlar that turns them off without touching anything
 * the server sends.
 */

interface MockRequest {
  identifier?: string;
  content: { title?: string; body?: string; data: Record<string, unknown> };
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
    /** the çelınc's own status, and everybody's answer, the reader's included */
    challengeStatus?: 'pending' | 'active';
    players?: ('invited' | 'accepted')[];
    /** the zone the server reads the reader's days in on this çelınc; an older server sends none */
    myTimezone?: string;
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
      ...(overrides.challengeStatus ? { status: overrides.challengeStatus } : {}),
    },
    ...(overrides.players ? { participants: overrides.players.map((status) => ({ status })) } : {}),
    me: { status: overrides.status ?? 'accepted', lastEntryAt: overrides.lastEntryAt ?? null },
    ...(overrides.myTimezone ? { myTimezone: overrides.myTimezone } : {}),
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

  it('rings nothing for a çelınc still waiting for a second yes, past its start or not', async () => {
    // started two days ago, nobody but the reader said yes: no "Geldim" to press
    const stalled = checkinSummary({
      id: 'c-stalled',
      endsAt: new Date(NOW.getTime() + 3 * DAY_MS),
      challengeStatus: 'pending',
      players: ['accepted', 'invited'],
    });
    // starts in three days, and the invite is still unanswered
    const startsAt = new Date('2026-10-07T21:00:00.000Z');
    const early = checkinSummary({
      id: 'c-early',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 7 * DAY_MS),
      challengeStatus: 'pending',
      players: ['accepted', 'invited'],
    });

    // neither a check-in poke nor "son 1 saat" for a çelınc cancelled at its end
    expect(await refreshReminders(listOf(stalled, early), 3, TZ)).toBe(0);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('sets the pokes of a çelınc that starts later once a second player is in', async () => {
    const startsAt = new Date('2026-10-07T21:00:00.000Z');
    const client = listOf(
      checkinSummary({
        startsAt,
        endsAt: new Date(startsAt.getTime() + 7 * DAY_MS),
        challengeStatus: 'pending',
        players: ['accepted', 'accepted', 'invited'],
      })
    );

    await refreshReminders(client, 2, TZ);

    const checkins = checkinRequests();
    expect(checkins[0]?.identifier).toBe('koydum-checkin-c1-2026-10-08');
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

  it('pokes in the zone the reader joined the çelınc in, not the one the account moved to since', async () => {
    // joined in Istanbul, then a login in New York moved the profile: the
    // server still wants the check-in by 23:00 Istanbul
    const client = listOf(
      checkinSummary({
        deadlineTime: '23:00',
        endsAt: new Date(NOW.getTime() + 2 * DAY_MS),
        myTimezone: 'Europe/Istanbul',
      })
    );

    await refreshReminders(client, 2, 'America/New_York');

    const checkins = checkinRequests();
    expect(checkins.map((request) => request.identifier)).toEqual([
      'koydum-checkin-c1-2026-10-05',
      'koydum-checkin-c1-2026-10-06',
    ]);
    // 22:30 in Istanbul, where 22:30 in New York would be 02:30Z the next day
    expect(checkins.map((request) => request.trigger.date?.toISOString())).toEqual([
      '2026-10-05T19:30:00.000Z',
      '2026-10-06T19:30:00.000Z',
    ]);
  });

  it('takes back only today\'s poke after a check-in, and a refresh does not put it back', async () => {
    // a list read just before the check-in landed: nothing entered today yet
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

/** 23:59:59.999 tonight in Istanbul, where the app snaps an end. */
const TONIGHT_END = new Date('2026-10-05T20:59:59.999Z');

/** An Adım Yarışı the reader is in, ending at midnight tonight in Istanbul unless told otherwise. */
function stepsSummary(overrides: { endsAt?: Date; myTimezone?: string } = {}): ChallengeSummary {
  const summary = checkinSummary({ id: 's1', endsAt: overrides.endsAt ?? TONIGHT_END, myTimezone: overrides.myTimezone });
  summary.challenge = { ...summary.challenge, title: 'Ofis Ligi', metricType: 'auto_steps', deadlineTime: null };
  return summary;
}

/** The "son 1 saat" warning and the tap after a step çelınc's end, in the order they were asked for. */
function endRequests(): MockRequest[] {
  return mockSchedule.mock.calls.map(([request]) => request).filter((request) => request.content.data.reminder === 'last_hour');
}

describe('the end of a step çelınc', () => {
  it('tells a step player to open the app once it is over, and taps them two minutes after the end', async () => {
    expect(await refreshReminders(listOf(stepsSummary()), 1, TZ)).toBe(2);

    const [lastHour, ended] = endRequests();
    // nothing to type in a step race: the steps only count if the phone sends them
    expect(lastHour?.content.body).toBe('Ofis Ligi bir saat sonra bitiyor. Bitince uygulamayı bir kez aç, son adımların da sayılsın.');
    expect(lastHour?.trigger.seconds).toBe(Math.floor((TONIGHT_END.getTime() - HOUR_MS - NOW.getTime()) / 1000));
    // the tap opens the çelınc, whose settling screen syncs the last day
    expect(ended?.content.data).toEqual({ kind: REMINDER_KIND, reminder: 'last_hour', challengeId: 's1', type: 'reminder' });
    expect(ended?.content.body).toContain('Ofis Ligi bitti.');
    expect(ended?.trigger).toMatchObject({
      type: 'timeInterval',
      seconds: Math.floor((TONIGHT_END.getTime() + 2 * 60_000 - NOW.getTime()) / 1000),
    });
  });

  it('says it at every level, none of them "Skorunu girmediysen"', async () => {
    const bodies: string[] = [];
    for (const level of [1, 2, 3] as const) {
      mockSchedule.mockClear();
      await refreshReminders(listOf(stepsSummary()), level, TZ);
      const requests = endRequests();
      expect(requests).toHaveLength(2);
      bodies.push(...requests.map((request) => `${request.content.title} | ${request.content.body}`));
    }
    expect(new Set(bodies).size).toBe(6);
    for (const body of bodies) expect(body).not.toContain('Skorunu');
  });

  it('sets the tap again when a refresh lands between the end and two minutes after it', async () => {
    jest.setSystemTime(new Date(TONIGHT_END.getTime() + 60_000));
    try {
      await refreshReminders(listOf(stepsSummary()), 2, TZ);
      // every refresh clears first: the tap has to be set again for the minute left
      const requests = endRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0]?.content.body).toContain('bitti');
      expect(requests[0]?.trigger.seconds).toBe(60);

      mockSchedule.mockClear();
      jest.setSystemTime(new Date(TONIGHT_END.getTime() + 3 * 60_000));
      await refreshReminders(listOf(stepsSummary()), 2, TZ);
      expect(mockSchedule).not.toHaveBeenCalled();
    } finally {
      jest.setSystemTime(NOW);
    }
  });

  it('tells a reader whose last day the end cuts in half to open the app before it, and does not tap after', async () => {
    // snapped to midnight in Istanbul, 22:00 in London: that evening after the end never counts
    expect(await refreshReminders(listOf(stepsSummary({ myTimezone: 'Europe/London' })), 1, TZ)).toBe(1);

    const requests = endRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.content.body).toBe('Ofis Ligi bir saat sonra bitiyor. Bitmeden uygulamayı bir kez aç, son adımların da sayılsın.');
  });

  it('keeps "Skorunu girmediysen yersin" for a çelınc the reader types into, with no tap after the end', async () => {
    await refreshReminders(listOf(checkinSummary()), 2, TZ);

    const requests = endRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.content.body).toBe('Sabah Kalkma bir saat sonra bitiyor. Skorunu girmediysen yersin.');
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
