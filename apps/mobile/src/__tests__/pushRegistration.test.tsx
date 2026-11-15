/**
 * The push token goes up once per session. A password change clears it on the
 * server (the phones it signed out may hold it) and hands this phone a new
 * session token: the bridge used to remember only the device token, saw the
 * same one again, and left this phone without push until the next login.
 */
import type { Me } from '@koydum/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppState, type AppStateStatus } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '@/components/Toast';
import { ApiClient } from '@/lib/api';
import { useAuth } from '@/store/auth';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => false },
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

const mockRegisterForPush = jest.fn(async (_options?: { askAgain?: boolean }) => ({
  token: 'ExponentPushToken[telefon]' as string | null,
  granted: true,
  reason: null,
}));

jest.mock('@/services/notifications', () => ({
  registerForPush: (options?: { askAgain?: boolean }) => mockRegisterForPush(options),
  installNotificationHandler: () => {},
  addResponseListener: () => ({ remove: () => {} }),
  addReceivedListener: () => ({ remove: () => {} }),
  getInitialRoute: async () => null,
  routeForNotificationData: () => null,
}));

// everything else the bridge starts: none of it is under test here
jest.mock('@/services/steps', () => ({
  startForegroundStepTracking: () => () => {},
  requestStepPermission: async () => true,
  getDailySteps: async () => [],
  getTodaySteps: async () => null,
  getStepAvailability: async () => ({ available: false, reason: 'web' }),
}));
jest.mock('@/services/background', () => ({
  registerBackgroundSync: async () => {},
  setBackgroundHandler: () => {},
}));
jest.mock('@/services/reminders', () => ({
  refreshReminders: async () => 0,
  clearReminders: async () => {},
}));
jest.mock('@/services/stepSync', () => ({ syncStepsNow: async () => ({ days: 0, updated: 0 }) }));
jest.mock('@/services/screenTimeSync', () => ({ syncScreenTimeNow: async () => ({ days: 0, updated: 0 }) }));
jest.mock('@/services/offlineQueue', () => ({
  flushQueue: async () => ({ sent: 0 }),
  readQueue: async () => [],
  clearFailed: async () => {},
}));
jest.mock('@/services/inboxNotifier', () => ({
  deliverNewInbox: async () => ({ surface: 'in-app', items: [] }),
}));
jest.mock('@/services/invite', () => ({
  ...jest.requireActual('@/services/invite'),
  applyPendingInvite: async () => null,
}));

const ME = {
  id: 'me-1',
  username: 'mustafa',
  displayName: 'Mustafa',
  avatarEmoji: '🔥',
  vulgarityMax: 2,
  timezone: 'Europe/Istanbul',
} as Me;

const mounted: { tree: ReactTestRenderer; client: QueryClient }[] = [];

function renderBridge(): void {
  const { NotificationBridge } = require('@/providers/NotificationBridge');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <SafeAreaProvider
        initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
        <QueryClientProvider client={client}>
          <ToastProvider>
            <NotificationBridge />
          </ToastProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    );
  });
  mounted.push({ tree, client });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

let setPushToken: jest.SpyInstance;
let appStateListeners: ((state: AppStateStatus) => void)[];

/** The session token each POST /me/push-token went up with. */
const sentWith = () => setPushToken.mock.contexts.map((client) => (client as ApiClient).token);

beforeEach(() => {
  jest.clearAllMocks();
  setPushToken = jest.spyOn(ApiClient.prototype, 'setPushToken').mockResolvedValue({ ok: true } as never);
  appStateListeners = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((type, listener) => {
    if (type === 'change') appStateListeners.push(listener as (state: AppStateStatus) => void);
    return { remove: () => {} } as ReturnType<typeof AppState.addEventListener>;
  });
  useAuth.setState({ token: 'oturum-1', me: ME, onboarding: false, serverUrl: 'http://192.168.1.20:4000' });
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const { tree, client } of mounted.splice(0)) {
    act(() => {
      tree.unmount();
    });
    client.clear();
  }
});

describe('push token registration', () => {
  it('sends the same device token again for the session a password change hands out', async () => {
    renderBridge();
    await settle();
    expect(sentWith()).toEqual(['oturum-1']);

    // the same session coming back (the welcome slides, a foreground) sends nothing
    act(() => useAuth.setState({ onboarding: true }));
    act(() => useAuth.setState({ onboarding: false }));
    await settle();
    act(() => appStateListeners.forEach((listener) => listener('active')));
    await settle();
    expect(sentWith()).toEqual(['oturum-1']);

    // the password sheet's setSession
    act(() => useAuth.setState({ token: 'oturum-2' }));
    await settle();
    expect(sentWith()).toEqual(['oturum-1', 'oturum-2']);
    expect(setPushToken).toHaveBeenLastCalledWith({ token: 'ExponentPushToken[telefon]', platform: expect.any(String) });
  });

  it("tries the new session's again at the next foreground when the first one failed", async () => {
    renderBridge();
    await settle();

    setPushToken.mockRejectedValueOnce(new Error('offline'));
    act(() => useAuth.setState({ token: 'oturum-2' }));
    await settle();
    expect(sentWith()).toEqual(['oturum-1', 'oturum-2']);

    act(() => appStateListeners.forEach((listener) => listener('active')));
    await settle();
    expect(sentWith()).toEqual(['oturum-1', 'oturum-2', 'oturum-2']);
  });
});
