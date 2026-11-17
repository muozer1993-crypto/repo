/**
 * A check-in parked while the app stays on screen goes out by itself once the
 * server answers again. It used to wait for the next foreground: "Geldim"
 * tapped two minutes before the deadline during a short outage sat in the
 * queue until the screen was switched off and on, and the server stored it
 * late.
 */
import type { Me } from '@koydum/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState, type AppStateStatus } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '@/components/Toast';
import { ApiClient, ApiError, type HealthResponse } from '@/lib/api';
import type { PendingEntry } from '@/services/offlineQueue';
import { useAuth } from '@/store/auth';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), canGoBack: () => false },
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('@/services/notifications', () => ({
  registerForPush: async () => ({ token: null, granted: true, reason: 'no-fcm' as const }),
  installNotificationHandler: () => {},
  addResponseListener: () => ({ remove: () => {} }),
  addReceivedListener: () => ({ remove: () => {} }),
  getInitialRoute: async () => null,
  routeForNotificationData: () => null,
}));

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
jest.mock('@/services/inboxNotifier', () => ({
  deliverNewInbox: async () => ({ surface: 'system', items: [] }),
}));
jest.mock('@/services/invite', () => ({
  ...jest.requireActual('@/services/invite'),
  applyPendingInvite: async () => null,
}));

/** What the queue holds as the bridge reads it, and the flush it starts. */
const mockQueue: { items: PendingEntry[] } = { items: [] };
const mockFlush = jest.fn(async (_client: unknown) => ({ sent: 0, dropped: 0, remaining: 1 }));
jest.mock('@/services/offlineQueue', () => ({
  ...jest.requireActual('@/services/offlineQueue'),
  flushQueue: (client: unknown) => mockFlush(client),
  readQueue: async () => mockQueue.items,
  currentOwnerId: async () => 'u1',
  clearFailed: async () => {},
}));

const ME = {
  id: 'u1',
  username: 'mustafa',
  displayName: 'Mustafa',
  avatarEmoji: '🔥',
  vulgarityMax: 2,
  timezone: 'Europe/Istanbul',
} as Me;

/** "Geldim" tapped during the outage: never answered, so no try spent on it. */
function parkedCheckin(extra: Partial<PendingEntry> = {}): PendingEntry {
  return {
    id: 'u1/c1:2026-11-17:checkin:',
    challengeId: 'c1',
    body: { dayKey: '2026-11-17', value: 1, source: 'checkin', clientTime: '2026-11-17T09:26:00.000Z' },
    ownerId: 'u1',
    queuedAt: '2026-11-17T09:26:01.000Z',
    attempts: 0,
    ...extra,
  };
}

const HEALTHY: HealthResponse = { ok: true, version: '1.0.0', time: '2026-11-17T09:27:00.000Z' };

const mounted: { tree: ReactTestRenderer; client: QueryClient }[] = [];

function render(): ReactTestRenderer {
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
  return tree;
}

/** Real timeouts drain the promise chains; only the intervals wait for the test. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** The clock moves `ms` with the app open, and whatever it started runs out. */
async function wait(ms: number): Promise<void> {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
  await settle();
}

const appState = AppState as unknown as { currentState: unknown };
const realState = appState.currentState;
let appStateEvents: number;
let health: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: [
      'Date', 'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
      'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
    ],
  });
  mockFlush.mockClear();
  mockQueue.items = [parkedCheckin()];
  appState.currentState = 'active';
  appStateEvents = 0;
  // a foreground drains too: nothing here may lean on one
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, _listener: (state: AppStateStatus) => void) => {
    appStateEvents += 1;
    return { remove: () => {} } as ReturnType<typeof AppState.addEventListener>;
  });
  health = jest.spyOn(ApiClient.prototype, 'health').mockResolvedValue(HEALTHY);
  useAuth.setState({ token: 'tok', me: ME, onboarding: false, serverUrl: 'http://192.168.1.20:4000' });
});

afterEach(() => {
  for (const { tree, client } of mounted.splice(0)) {
    act(() => {
      tree.unmount();
    });
    client.clear();
  }
  jest.useRealTimers();
  jest.restoreAllMocks();
  appState.currentState = realState;
});

describe('an entry parked while the app stays open', () => {
  it('goes out within 15 s once the server answers, with no foreground', async () => {
    render();
    await settle();
    // the mount's own drain
    expect(mockFlush).toHaveBeenCalledTimes(1);
    const listeners = appStateEvents;

    await wait(14_999);
    expect(mockFlush).toHaveBeenCalledTimes(1);
    await wait(1);
    expect(health).toHaveBeenCalledTimes(1);
    expect(mockFlush).toHaveBeenCalledTimes(2);

    // and again while it still waits
    await wait(15_000);
    expect(mockFlush).toHaveBeenCalledTimes(3);
    expect(appStateEvents).toBe(listeners);
  });

  it('leaves an entry a server error already counted to the foreground and background runs', async () => {
    // eight tries are for a server that keeps failing it, not for two minutes of an open app
    mockQueue.items = [parkedCheckin({ attempts: 1 })];
    render();
    await settle();

    await wait(45_000);
    expect(mockFlush).toHaveBeenCalledTimes(1);
    expect(health).not.toHaveBeenCalled();
  });

  it('waits out the hour of a photo the server holds back instead of sending it four times a minute', async () => {
    mockQueue.items = [parkedCheckin({ proofLocalUri: 'file:///cache/kanit.jpg', photoHeldSince: '2026-11-17T09:20:00.000Z' })];
    render();
    await settle();

    await wait(15_000);
    expect(mockFlush).toHaveBeenCalledTimes(1);
    expect(health).not.toHaveBeenCalled();
  });

  it('asks nothing of the server when nothing is waiting', async () => {
    // an idle phone: no traffic for the open app
    mockQueue.items = [];
    render();
    await settle();

    await wait(60_000);
    expect(health).not.toHaveBeenCalled();
    expect(mockFlush).toHaveBeenCalledTimes(1);
  });

  it("leaves a refusal waiting for its toast, and another account's entry for its owner", async () => {
    mockQueue.items = [
      parkedCheckin({ failedReason: 'Süre bitti, artık giriş yok.' }),
      parkedCheckin({ id: 'u2/c1:2026-11-17:checkin:', ownerId: 'u2' }),
    ];
    render();
    await settle();

    await wait(15_000);
    expect(health).not.toHaveBeenCalled();
    expect(mockFlush).toHaveBeenCalledTimes(1);
  });

  it('keeps it parked while /health does not answer', async () => {
    health.mockRejectedValue(new ApiError('server_down', 'Sunucu şu an kapalı, uyuyor ya da adresi değişmiş.', 530));
    render();
    await settle();

    await wait(15_000);
    expect(health).toHaveBeenCalledTimes(1);
    expect(mockFlush).toHaveBeenCalledTimes(1);

    // the server is back: the next tick sends it
    health.mockResolvedValue(HEALTHY);
    await wait(15_000);
    expect(mockFlush).toHaveBeenCalledTimes(2);
  });

  it('asks once at a time while /health hangs', async () => {
    health.mockImplementation(() => new Promise<HealthResponse>(() => {}));
    render();
    await settle();

    await wait(15_000);
    await wait(15_000);
    await wait(15_000);
    expect(health).toHaveBeenCalledTimes(1);
    expect(mockFlush).toHaveBeenCalledTimes(1);
  });

  it('does nothing while the app is off screen', async () => {
    render();
    await settle();
    appState.currentState = 'background';

    await wait(30_000);
    expect(health).not.toHaveBeenCalled();
    expect(mockFlush).toHaveBeenCalledTimes(1);
  });

  it('stops with the bridge', async () => {
    const tree = render();
    await settle();
    const [{ client }] = mounted.splice(0);
    act(() => {
      tree.unmount();
    });
    client.clear();
    // the inbox poll's interval went with it, and so did this one
    expect(jest.getTimerCount()).toBe(0);

    await wait(30_000);
    expect(health).not.toHaveBeenCalled();
    expect(mockFlush).toHaveBeenCalledTimes(1);
  });

  it('does not run over the welcome slides', async () => {
    useAuth.setState({ onboarding: true });
    render();
    await settle();

    await wait(30_000);
    expect(health).not.toHaveBeenCalled();
    expect(mockFlush).not.toHaveBeenCalled();
  });
});
