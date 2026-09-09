import { Platform } from 'react-native';

import { localNotifications, type LocalNotifications } from '@/services/expoNotifications';
import { ANDROID_CHANNEL_ID, installNotificationHandler } from '@/services/notifications';

/**
 * Local reminders scheduled on the device itself.
 *
 * The server sends the social notifications ("Mustafa sana koydu"), but two
 * nudges only make sense on the phone because they depend on a wall clock the
 * server would have to guess at, and they must fire even when push is
 * unavailable (Expo Go on Android, no project id, permission denied):
 *
 *  - a check-in challenge whose deadline is at 07:00 needs a poke at 06:30;
 *  - a challenge that ends tonight needs a "son saat" warning.
 *
 * `expo-notifications` is reached through `services/expoNotifications` rather
 * than imported: the barrel throws at import time in Expo Go on Android, and a
 * reminder is never worth taking the app down for.
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
    return permission.status === 'granted' ? api : null;
  } catch {
    return null;
  }
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
  endsAt: string;
  metricType: string;
  /** "HH:mm" for check-in challenges */
  deadlineTime: string | null;
  /** true when the reader has already done today's check-in */
  doneToday: boolean;
}

const MINUTES_BEFORE_DEADLINE = 30;

/**
 * Replaces every scheduled reminder with the ones the given challenges need.
 * Safe to call on every refresh: it is idempotent by construction.
 */
export async function syncReminders(
  challenges: ReminderChallenge[],
  level: 1 | 2 | 3,
  now: Date = new Date()
): Promise<number> {
  const api = await ready();
  if (!api) return 0;
  await cancelAllReminders();

  let scheduled = 0;
  for (const challenge of challenges) {
    if (challenge.metricType === 'checkin_deadline' && challenge.deadlineTime && !challenge.doneToday) {
      const at = minusMinutes(challenge.deadlineTime, MINUTES_BEFORE_DEADLINE);
      if (at) {
        const ok = await schedule(api, {
          content: {
            title:
              level === 1 ? 'Check-in vakti' : level === 2 ? 'Kalk lan, süre doluyor' : 'Kalk yoksa yiyeceksin 🍆',
            body:
              level === 1
                ? `${challenge.title}: ${challenge.deadlineTime}'e ${MINUTES_BEFORE_DEADLINE} dakika kaldı.`
                : `${challenge.title}: ${MINUTES_BEFORE_DEADLINE} dakikan var. "GELDİM" demezsen uyudun sayılırsın.`,
            data: { kind: REMINDER_KIND, reminder: 'checkin', challengeId: challenge.id, type: 'reminder' },
            sound: true,
          },
          trigger: {
            type: api.SchedulableTriggerInputTypes.DAILY,
            hour: at.hour,
            minute: at.minute,
            ...(Platform.OS === 'android' ? { channelId: ANDROID_CHANNEL_ID } : {}),
          },
        });
        if (ok) scheduled += 1;
      }
    }

    const endsIn = new Date(challenge.endsAt).getTime() - now.getTime();
    // one hour before the end, but only if that moment is still in the future
    const secondsUntilLastHour = Math.floor((endsIn - 60 * 60_000) / 1000);
    if (Number.isFinite(secondsUntilLastHour) && secondsUntilLastHour > 60) {
      const ok = await schedule(api, {
        content: {
          title: level === 1 ? 'Son bir saat' : 'SON 1 SAAT ⏳',
          body:
            level === 1
              ? `${challenge.title} bir saat sonra bitiyor. Girişlerini kontrol et.`
              : `${challenge.title} bitiyor. Adımlarını senkronla, senkronsuz yiyen çok oldu.`,
          data: { kind: REMINDER_KIND, reminder: 'last_hour', challengeId: challenge.id, type: 'reminder' },
          sound: true,
        },
        trigger: {
          type: api.SchedulableTriggerInputTypes.TIME_INTERVAL,
          seconds: secondsUntilLastHour,
          ...(Platform.OS === 'android' ? { channelId: ANDROID_CHANNEL_ID } : {}),
        },
      });
      if (ok) scheduled += 1;
    }
  }
  return scheduled;
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
