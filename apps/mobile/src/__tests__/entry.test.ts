/**
 * The app entry has to define the background task by itself.
 *
 * When Android wakes a swiped-away phone for the 15-minute check it only loads
 * the bundle; expo-router never renders, so nothing under `src/app` (and so no
 * `NotificationBridge`) is evaluated. If the entry does not reach
 * `services/background`, expo-task-manager finds no `koydum-sync` and
 * unregisters it, and closed-phone "KOYDUM MU?" stops for good.
 */

// rendering the router is not what this test is about, and it needs a device
jest.mock('expo-router/entry', () => ({}));

const mockDefineTask = jest.fn();
jest.mock('expo-task-manager', () => ({
  isTaskDefined: () => false,
  defineTask: mockDefineTask,
  isTaskRegisteredAsync: jest.fn(async () => false),
}));

jest.mock('expo-background-task', () => ({
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  BackgroundTaskStatus: { Restricted: 1, Available: 2 },
  getStatusAsync: jest.fn(async () => 2),
  registerTaskAsync: jest.fn(async () => {}),
  unregisterTaskAsync: jest.fn(async () => {}),
}));

const mockRunBackgroundWork = jest.fn(async () => {});
jest.mock('@/services/backgroundWork', () => ({
  runBackgroundWork: mockRunBackgroundWork,
}));

describe('the app entry', () => {
  it('is what package.json starts', () => {
    expect(require('../../package.json').main).toBe('index.ts');
  });

  it('defines the background task without rendering anything', async () => {
    require('../../index');
    expect(mockDefineTask).toHaveBeenCalledTimes(1);
    expect(mockDefineTask).toHaveBeenCalledWith('koydum-sync', expect.any(Function));

    // headless: no bridge ever installed a handler, so the stored-session
    // fallback does the work
    const task = mockDefineTask.mock.calls[0][1] as () => Promise<number>;
    await expect(task()).resolves.toBe(1);
    expect(mockRunBackgroundWork).toHaveBeenCalledTimes(1);
  });
});
