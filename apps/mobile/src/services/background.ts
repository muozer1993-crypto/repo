import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { runBackgroundWork } from '@/services/backgroundWork';

/**
 * Periodic background work: push the last few days of steps to the server so a
 * challenge keeps scoring even when nobody opens the app, and pull the unread
 * inbox count so a device without push still finds out it got dunked on.
 *
 * The app layer injects a richer handler while it is alive
 * (`setBackgroundHandler`); when the task fires headless — the app was swiped
 * away and React never mounted — `runBackgroundWork` does the same job from the
 * stored session. The task body itself has to be defined at module scope,
 * before React runs, which is why this file knows nothing about providers.
 */

export const BACKGROUND_TASK_NAME = 'koydum-sync';

type Handler = () => Promise<void>;

let handler: Handler | null = null;

export function setBackgroundHandler(next: Handler | null): void {
  handler = next;
}

if (Platform.OS !== 'web' && !TaskManager.isTaskDefined(BACKGROUND_TASK_NAME)) {
  TaskManager.defineTask(BACKGROUND_TASK_NAME, async () => {
    try {
      if (handler) await handler();
      else await runBackgroundWork();
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

export async function registerBackgroundSync(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) return false;
    const already = await TaskManager.isTaskRegisteredAsync(BACKGROUND_TASK_NAME);
    if (already) return true;
    // 15 minutes is the platform floor; the system will still batch as it likes
    await BackgroundTask.registerTaskAsync(BACKGROUND_TASK_NAME, { minimumInterval: 15 });
    return true;
  } catch {
    return false;
  }
}

export async function unregisterBackgroundSync(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const registered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_TASK_NAME);
    if (registered) await BackgroundTask.unregisterTaskAsync(BACKGROUND_TASK_NAME);
  } catch {
    // ignore
  }
}
