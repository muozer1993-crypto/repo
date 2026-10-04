import { addDays } from '@koydum/shared';
import { Platform } from 'react-native';

import type { ApiClient } from '@/lib/api';
import { StorageKeys, getItem, removeItem, setItem } from '@/lib/storage';
import { localNotifications, type LocalNotifications } from '@/services/expoNotifications';
import { ANDROID_CHANNEL_ID, ensureAndroidChannel, installNotificationHandler } from '@/services/notifications';
import { safeDayKey, safeDayKeysBetween, safeTodayKey, zonedInstant } from '@/utils/datetime';

/**
 * Local reminders scheduled on the device itself.
 *
 * The server sends the social notifications ("Mustafa sana koydu"), but two
 * nudges only make sense on the phone because they depend on a wall clock the
 * server would have to guess at, and they must fire even when push is
 * unavailable (Expo Go on Android, no project id, permission denied):
 *
 *  - a check-in challenge whose deadline is at 07:00 needs a poke at 06:30 on
 *    every day it still runs, and none once today's check-in is in;
 *  - a challenge that ends tonight needs a "son saat" warning.
 *
 * Only çelınclar the reader accepted get them: the list also carries the ones
 * they were merely invited to, and an unanswered invite has no deadline to miss.
 *
 * `expo-notifications` is reached through `services/expoNotifications` rather
 * than imported: the barrel throws at import time in Expo Go on Android, and a
 * reminder is never worth taking the app down for.
 *
 * Ayarlar can switch them off ("Saatli çelınc uyarıları"). The switch lives on
 * the phone, not on the account, because only the phone schedules them.
 */

export const REMINDER_KIND = 'koydum.reminder' as const;

type NotificationRequest = Parameters<LocalNotifications['scheduleNotificationAsync']>[0];

interface ScheduledReminder {
  identifier: string;
  challengeId: string;
  kind: 'checkin' | 'last_hour';
}

/** The notification API, but only once it is usable and permitted. */
async function ready(): Promise<LocalNotifications | null> {
  if (Platform.OS === 'web') return null;
  const api = localNotifications();
  if (!api) return null;
  try {
    installNotificationHandler();
    const permission = await api.getPermissionsAsync();
    if (permission.status !== 'granted') return null;
  } catch {
    return null;
  }
  try {
    // Only push registration used to create the channel, and the headless task
    // never registers: reminders scheduled before it existed were never shown.
    await ensureAndroidChannel();
  } catch {
    // one created by an earlier run still carries them
  }
  return api;
}

/** Every reminder this app scheduled, so we can replace them wholesale. */
async function listOurs(api: LocalNotifications): Promise<ScheduledReminder[]> {
  try {
    const scheduled = await api.getAllScheduledNotificationsAsync();
    return scheduled
      .map((item) => {
        const data = item.content.data as Record<string, unknown> | null;
        if (!data || data.kind !== REMINDER_KIND) return null;
        return {
          identifier: item.identifier,
          challengeId: typeof data.challengeId === 'string' ? data.challengeId : '',
          kind: data.reminder === 'checkin' ? ('checkin' as const) : ('last_hour' as const),
        };
      })
      .filter((item): item is ScheduledReminder => item !== null);
  } catch {
    return [];
  }
}

export async function cancelAllReminders(): Promise<void> {
  if (Platform.OS === 'web') return;
  const api = localNotifications();
  if (!api) return;
  for (const reminder of await listOurs(api)) {
    try {
      await api.cancelScheduledNotificationAsync(reminder.identifier);
    } catch {
      // ignore
    }
  }
}

export interface ReminderChallenge {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  metricType: string;
  /** "HH:mm" for check-in challenges */
  deadlineTime: string | null;
  /** true when the reader has already done today's check-in */
  doneToday: boolean;
}

const MINUTES_BEFORE_DEADLINE = 30;
/** Check-in slots set per çelınc; every foreground and background run tops them up. */
const CHECKIN_DAYS_AHEAD = 14;
/** iOS keeps only an app's 64 soonest local notifications and drops the rest without a word. */
const MAX_SCHEDULED = 60;

/** One per çelınc and check-in day, so a single day can be taken back. */
function checkinIdentifier(challengeId: string, dayKey: string): string {
  return `koydum-checkin-${challengeId}-${dayKey}`;
}

/**
 * Today's slots the reader checked in for on this phone. A parked (offline)
 * check-in reaches the server only when the queue drains, and a refresh that
 * reads the list before that would put the slot right back. Keyed by the
 * identifier, so yesterday's entries never match again.
 */
const checkedInHere = new Set<string>();

/** False once the reader switched the alerts off in Ayarlar; on until then. */
export async function deviceRemindersEnabled(): Promise<boolean> {
  return (await getItem(StorageKeys.deviceRemindersOff)) !== '1';
}

/** Stores the switch only; `refreshReminders` is what acts on it. */
export async function setDeviceRemindersEnabled(enabled: boolean): Promise<void> {
  if (enabled) await removeItem(StorageKeys.deviceRemindersOff);
  else await setItem(StorageKeys.deviceRemindersOff, '1');
}

let refreshQueue: Promise<unknown> = Promise.resolve();

/**
 * Asks the server for the reader's open çelınclar and schedules what they need,
 * or clears every reminder, without asking anything, when the alerts are off.
 *
 * One run at a time: the bridge refreshes on every foreground and Ayarlar right
 * after the switch flips, and a run still waiting on the list would otherwise
 * schedule after the one that has just cleared everything.
 */
export function refreshReminders(
  client: Pick<ApiClient, 'challenges'>,
  level: 1 | 2 | 3,
  tz: string
): Promise<number> {
  const run = refreshQueue.then(() => refresh(client, level, tz));
  refreshQueue = run.catch(() => undefined);
  return run;
}

async function refresh(client: Pick<ApiClient, 'challenges'>, level: 1 | 2 | 3, tz: string): Promise<number> {
  if (!(await deviceRemindersEnabled())) {
    await cancelAllReminders();
    return 0;
  }
  const summaries = await client.challenges('active,pending');
  // day keys are counted in the ACCOUNT's zone, both here and on the server
  const today = safeTodayKey(tz);
  const reminders: ReminderChallenge[] = summaries
    .filter((summary) => summary.me?.status === 'accepted')
    .map((summary) => ({
      id: summary.challenge.id,
      title: summary.challenge.title,
      startsAt: summary.challenge.startsAt,
      endsAt: summary.challenge.endsAt,
      metricType: summary.challenge.metricType,
      deadlineTime: summary.challenge.deadlineTime,
      doneToday: safeDayKey(summary.me?.lastEntryAt, tz) === today,
    }));
  return syncReminders(reminders, level, tz);
}

/**
 * Takes back today's check-in poke once the reader has checked in, sent or
 * parked offline. Without it a check-in at 06:05 still got "30 dakikan kaldı"
 * at 06:30, because nothing refreshed the reminders in between.
 *
 * Waits its turn behind a refresh that may be about to schedule that very slot.
 */
export function skipTodayCheckinReminder(challengeId: string, tz: string): Promise<void> {
  const identifier = checkinIdentifier(challengeId, safeTodayKey(tz));
  checkedInHere.add(identifier);
  const run = refreshQueue.then(async () => {
    if (Platform.OS === 'web') return;
    const api = localNotifications();
    if (!api) return;
    try {
      await api.cancelScheduledNotificationAsync(identifier);
    } catch {
      // not scheduled (or already rung): nothing to take back
    }
  });
  refreshQueue = run.catch(() => undefined);
  return run;
}

/**
 * Replaces every scheduled reminder with the ones the given challenges need.
 * Safe to call on every refresh: it is idempotent by construction.
 */
export async function syncReminders(
  challenges: ReminderChallenge[],
  level: 1 | 2 | 3,
  tz: string,
  now: Date = new Date()
): Promise<number> {
  const api = await ready();
  if (!api) return 0;
  await cancelAllReminders();

  const channel = Platform.OS === 'android' ? { channelId: ANDROID_CHANNEL_ID } : {};
  const planned: { at: number; request: NotificationRequest }[] = [];
  for (const challenge of challenges) {
    for (const slot of checkinSlots(challenge, tz, now)) {
      const identifier = checkinIdentifier(challenge.id, slot.dayKey);
      if (checkedInHere.has(identifier)) continue;
      planned.push({
        at: slot.at.getTime(),
        request: {
          identifier,
          content: {
            title:
              level === 1 ? 'Check-in vakti' : level === 2 ? 'Süre doluyor lan' : 'Yetiştir yoksa yersin 🍆',
            body:
              level === 1
                ? `${challenge.title}: check-in saati ${challenge.deadlineTime}. ${MINUTES_BEFORE_DEADLINE} dakikan kaldı.`
                : `${challenge.title}: ${MINUTES_BEFORE_DEADLINE} dakikan kaldı. Check-in yapmazsan bugün sayılmaz.`,
            data: { kind: REMINDER_KIND, reminder: 'checkin', challengeId: challenge.id, type: 'reminder' },
            sound: true,
          },
          trigger: { type: api.SchedulableTriggerInputTypes.DATE, date: slot.at, ...channel },
        },
      });
    }

    const endsIn = new Date(challenge.endsAt).getTime() - now.getTime();
    // one hour before the end, but only if that moment is still in the future
    const secondsUntilLastHour = Math.floor((endsIn - 60 * 60_000) / 1000);
    if (Number.isFinite(secondsUntilLastHour) && secondsUntilLastHour > 60) {
      planned.push({
        at: now.getTime() + secondsUntilLastHour * 1000,
        request: {
          content: {
            title: level === 1 ? 'Son bir saat' : 'SON 1 SAAT ⏳',
            body:
              level === 1
                ? `${challenge.title} bir saat sonra bitiyor. Girişlerini kontrol et.`
                : `${challenge.title} bir saat sonra bitiyor. Skorunu girmediysen yersin.`,
            data: { kind: REMINDER_KIND, reminder: 'last_hour', challengeId: challenge.id, type: 'reminder' },
            sound: true,
          },
          trigger: {
            type: api.SchedulableTriggerInputTypes.TIME_INTERVAL,
            seconds: secondsUntilLastHour,
            ...channel,
          },
        },
      });
    }
  }

  // soonest first: whatever the cap leaves out, a later refresh puts back
  planned.sort((a, b) => a.at - b.at);
  let scheduled = 0;
  for (const { request } of planned.slice(0, MAX_SCHEDULED)) {
    if (await schedule(api, request)) scheduled += 1;
  }
  return scheduled;
}

/**
 * When a check-in çelınc should be poked: 30 minutes before the deadline on
 * each remaining day, counted in the account's zone like the server counts it.
 *
 * This used to be one repeating daily alarm, which knew nothing about the
 * çelınc's window: it kept ringing every morning after the end (or a cancel)
 * until the app was next opened. One dated alarm per day cannot outlive it.
 */
function checkinSlots(challenge: ReminderChallenge, tz: string, now: Date): { dayKey: string; at: Date }[] {
  if (challenge.metricType !== 'checkin_deadline' || !challenge.deadlineTime) return [];
  const deadline = minusMinutes(challenge.deadlineTime, 0);
  const at = minusMinutes(challenge.deadlineTime, MINUTES_BEFORE_DEADLINE);
  const startsAt = Date.parse(challenge.startsAt);
  const endsAt = Date.parse(challenge.endsAt);
  if (!deadline || !at || !Number.isFinite(startsAt) || !Number.isFinite(endsAt)) return [];
  // a 00:10 deadline is poked at 23:40 the evening before
  const eveningBefore = at.hour * 60 + at.minute > deadline.hour * 60 + deadline.minute;

  const today = safeTodayKey(tz, now);
  const days = safeDayKeysBetween(challenge.startsAt, challenge.endsAt, tz)
    .filter((dayKey) => dayKey > today || (dayKey === today && !challenge.doneToday))
    .slice(0, CHECKIN_DAYS_AHEAD);

  const slots: { dayKey: string; at: Date }[] = [];
  for (const dayKey of days) {
    const slot = zonedInstant(eveningBefore ? addDays(dayKey, -1) : dayKey, at.hour, at.minute, tz);
    if (!slot) continue;
    const time = slot.getTime();
    if (time > now.getTime() && time >= startsAt && time < endsAt) slots.push({ dayKey, at: slot });
  }
  return slots;
}

async function schedule(api: LocalNotifications, request: NotificationRequest): Promise<boolean> {
  try {
    await api.scheduleNotificationAsync(request);
    return true;
  } catch {
    return false;
  }
}

/** "07:00" minus 30 minutes → { hour: 6, minute: 30 }; wraps around midnight. */
export function minusMinutes(hhmm: string, minutes: number): { hour: number; minute: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) return null;
  const total = Number(match[1]) * 60 + Number(match[2]) - minutes;
  const wrapped = ((total % 1440) + 1440) % 1440;
  return { hour: Math.floor(wrapped / 60), minute: wrapped % 60 };
}
