/**
 * The OS keeps the last notification response for as long as the app runs,
 * warm taps included, and the bridge asks for it on every sign-in. Ali tapped
 * a "Dürtüldün" for c-1, logged out and signed in again (or moved to another
 * server), and the app opened c-1 once more: on the new account a çelınc it
 * never had, over its home screen or its welcome slides.
 */
const mockLast: { response: unknown } = { response: null };
const mockTap: { handler?: (response: unknown) => void } = {};

jest.mock('@/services/expoNotifications', () => ({
  localNotifications: () => ({
    getLastNotificationResponseAsync: async () => mockLast.response,
    addNotificationResponseReceivedListener: (handler: (response: unknown) => void) => {
      mockTap.handler = handler;
      return { remove: () => {} };
    },
  }),
  pushNotifications: () => null,
  isExpoGo: () => false,
}));

/** A response as expo-notifications hands it over: the notification's id and its data. */
function response(identifier: string, data: Record<string, unknown>) {
  return { notification: { request: { identifier, content: { data } } } };
}

let notifications: typeof import('@/services/notifications');

beforeEach(() => {
  // a fresh process each time: what was opened lives in the module
  jest.isolateModules(() => {
    notifications = require('@/services/notifications');
  });
  mockLast.response = null;
  delete mockTap.handler;
});

describe('the notification the app was opened with', () => {
  it('opens once, not again on the next sign-in', async () => {
    mockLast.response = response('push-1', { type: 'poke', challengeId: 'c-1' });
    expect(await notifications.getInitialRoute()).toEqual({ kind: 'challenge', challengeId: 'c-1' });
    // logout, login: the bridge asks again and the OS still has it
    expect(await notifications.getInitialRoute()).toBeNull();
  });

  it('leaves out a tap the listener already opened while the app ran', async () => {
    const opened: unknown[] = [];
    notifications.addResponseListener((route) => opened.push(route));
    const tap = response('push-2', { type: 'poke', challengeId: 'c-2' });
    mockLast.response = tap;
    mockTap.handler!(tap);
    expect(opened).toEqual([{ kind: 'challenge', challengeId: 'c-2' }]);

    expect(await notifications.getInitialRoute()).toBeNull();
  });

  it('still opens a newer tap than the one it opened', async () => {
    mockLast.response = response('push-1', { type: 'poke', challengeId: 'c-1' });
    await notifications.getInitialRoute();
    mockLast.response = response('push-3', { type: 'taunt', challengeId: 'c-3' });
    expect(await notifications.getInitialRoute()).toEqual({ kind: 'results', challengeId: 'c-3' });
  });
});
