import { LIMITS } from '@koydum/shared';
import type { QueryClient } from '@tanstack/react-query';

import type { ApiClient } from '@/lib/api';
import { getDailySteps } from '@/services/steps';

/**
 * One place that pushes device steps to the server.
 *
 * `POST /me/steps` fans out to every active auto_steps challenge, so a sync
 * started from the challenge detail invalidates exactly what a sync started
 * from the home header does: the list, the open detail, and `me.stats`.
 */
export interface StepSyncResult {
  /** days the server wrote */
  updated: number;
  /** days the device could report; 0 means there was nothing to send */
  days: number;
}

export async function syncStepsNow(options: {
  client: ApiClient;
  queryClient: QueryClient;
  refreshMe?: () => Promise<unknown>;
  days?: number;
}): Promise<StepSyncResult> {
  const days = await getDailySteps(options.days ?? LIMITS.STEPS_BACKFILL_DAYS);
  if (days.length === 0) return { updated: 0, days: 0 };
  const result = await options.client.syncSteps(days);
  await Promise.all([
    options.queryClient.invalidateQueries({ queryKey: ['challenges'] }),
    options.queryClient.invalidateQueries({ queryKey: ['challenge'] }),
    options.refreshMe ? options.refreshMe() : Promise.resolve(),
  ]);
  return { updated: result.updated, days: days.length };
}
