import { LIMITS } from '@koydum/shared';
import type { QueryClient } from '@tanstack/react-query';

import type { ApiClient } from '@/lib/api';
import { getDailyScreenMinutes, getScreenTimeAvailability } from '@/services/screenTime';

/**
 * One place that pushes the phone's screen time to the server, the twin of
 * `stepSync.ts`.
 *
 * `POST /me/screen-time` fans out to every open Ekran Süresi çelınc, so a sync
 * started from the challenge detail invalidates exactly what the background
 * task does: the list, the open detail, and `me.stats`. On a phone that cannot
 * read screen time (iPhone, Expo Go, permission not granted) this is a cheap
 * no-op — `days: 0` — and the entry screen keeps asking the user.
 */
export interface ScreenTimeSyncResult {
  /** entries the server wrote */
  updated: number;
  /** days the device could report; 0 means there was nothing to send */
  days: number;
}

export async function syncScreenTimeNow(options: {
  client: ApiClient;
  queryClient: QueryClient;
  refreshMe?: () => Promise<unknown>;
  days?: number;
}): Promise<ScreenTimeSyncResult> {
  const availability = await getScreenTimeAvailability();
  if (!availability.available) return { updated: 0, days: 0 };

  const window = Math.min(options.days ?? LIMITS.SCREEN_TIME_BACKFILL_DAYS, LIMITS.SCREEN_TIME_SYNC_DAYS_MAX);
  const days = (await getDailyScreenMinutes(window))
    .map((day) => ({ dayKey: day.dayKey, minutes: Math.min(day.minutes, LIMITS.SCREEN_TIME_MINUTES_PER_DAY_MAX) }))
    .slice(0, LIMITS.SCREEN_TIME_SYNC_DAYS_MAX);
  if (days.length === 0) return { updated: 0, days: 0 };

  const result = await options.client.syncScreenTime(days);
  await Promise.all([
    options.queryClient.invalidateQueries({ queryKey: ['challenges'] }),
    options.queryClient.invalidateQueries({ queryKey: ['challenge'] }),
    options.refreshMe ? options.refreshMe() : Promise.resolve(),
  ]);
  return { updated: result.updated, days: days.length };
}
