import { QueryClient } from '@tanstack/react-query';

import { ApiClient } from '@/lib/api';
import { StorageKeys, getJson } from '@/lib/storage';
import { guessServerUrl, serverUrlIsEditable } from '@/lib/config';
import { deliverNewInbox } from '@/services/inboxNotifier';
import { flushQueue } from '@/services/offlineQueue';
import { syncScreenTimeNow } from '@/services/screenTimeSync';
import { syncStepsNow } from '@/services/stepSync';

/**
 * The work the periodic background task does when the app itself is not
 * running.
 *
 * `NotificationBridge` installs a richer handler while the app is alive, but a
 * background task started by the OS after the user swiped the app away runs
 * headless: the JS bundle loads, React never mounts, no provider ever calls
 * `setBackgroundHandler` (in that run the task exists at all only because the
 * app entry, `index.ts`, imports `services/background`). Without this fallback the
 * task was a no-op exactly in the situation it exists for ("a çelınc keeps
 * scoring even when nobody opens the app"). So the session is read straight
 * from storage and the same three things happen: device readings go up, parked
 * entries drain, the badge reflects the inbox.
 */
export async function runBackgroundWork(): Promise<void> {
  const [token, storedUrl] = await Promise.all([
    getJson<string>(StorageKeys.token),
    getJson<string>(StorageKeys.serverUrl),
  ]);
  if (typeof token !== 'string' || !token) return;

  const baseUrl =
    serverUrlIsEditable() && typeof storedUrl === 'string' && storedUrl ? storedUrl : guessServerUrl();
  const client = new ApiClient({ baseUrl, token, timeoutMs: 20_000 });
  // a throwaway cache: nothing is mounted to read it, invalidation is a no-op
  const queryClient = new QueryClient();

  try {
    await syncStepsNow({ client, queryClient });
  } catch {
    // the next foreground sync gets another go
  }
  try {
    await syncScreenTimeNow({ client, queryClient });
  } catch {
    // same
  }
  try {
    await flushQueue(client);
  } catch {
    // the queue keeps the entries
  }
  try {
    // the reason this task matters most: without Firebase push, this is how a
    // closed app still shows the loser "KOYDUM MU?"
    await deliverNewInbox(client, 'system');
  } catch {
    // offline: the next run tries again
  }
}
