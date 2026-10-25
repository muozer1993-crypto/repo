import type { DeviceMetric } from '@koydum/shared';
import type { QueryClient } from '@tanstack/react-query';

import type { ApiClient } from '@/lib/api';
import { syncScreenTimeNow } from '@/services/screenTimeSync';
import { syncStepsNow } from '@/services/stepSync';

/**
 * Sends the phone's reading of one metric now, for the moment a çelınc starts
 * needing it: a "Varım". The server fills in the days this phone already
 * reported as it accepts (`backfillFromPhone`); this brings what it never sent,
 * today's latest count or a day the background task missed, instead of leaving
 * the newcomer at 0 until the next background run. No metric (a çelınc the
 * phone does not count) is a no-op, and a failure is only a later sync.
 */
export async function syncDeviceNow(
  metric: DeviceMetric | undefined,
  deps: { client: ApiClient; queryClient: QueryClient; refreshMe?: () => Promise<unknown> }
): Promise<void> {
  if (!metric) return;
  const sync = metric === 'steps' ? syncStepsNow : syncScreenTimeNow;
  try {
    await sync(deps);
  } catch {
    // best effort: the app sends it again on the next foreground or background run
  }
}
