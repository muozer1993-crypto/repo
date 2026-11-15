/**
 * An entry the server refuses for good is told to the user once, by name, and
 * only then let go. The background handler drains the queue too while the app
 * is alive but off screen; its toast reached nobody and the entry was gone.
 */
import { addDays, type Me } from '@koydum/shared';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState, type AppStateStatus } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '@/components/Toast';
import { useAddEntry, type AddEntryResult } from '@/hooks/queries';
import { ApiClient, ApiError } from '@/lib/api';
import { qk } from '@/lib/query';
import { enqueueEntry, readQueue } from '@/services/offlineQueue';
import { useAuth } from '@/store/auth';
import { safeTodayKey } from '@/utils/datetime';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => false },
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

// the handler NotificationBridge installs for the OS's periodic run
const mockBackground: { handler: (() => Promise<void>) | null } = { handler: null };
jest.mock('@/services/background', () => ({
  registerBackgroundSync: async () => {},
  setBackgroundHandler: (handler: (() => Promise<void>) | null) => {
    mockBackground.handler = handler;
  },
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

const ME = {
  id: 'me-1',
  username: 'mustafa',
  displayName: 'Mustafa',
  avatarEmoji: '🔥',
  vulgarityMax: 2,
  timezone: 'Europe/Istanbul',
} as Me;

const mounted: { tree: ReactTestRenderer; client: QueryClient }[] = [];

function render(client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })): ReactTestRenderer {
  const { NotificationBridge } = require('@/providers/NotificationBridge');
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

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Every string drawn on screen. */
function texts(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAll((node) => typeof node.props.children === 'string')
    .map((node) => node.props.children as string);
}

const appState = AppState as unknown as { currentState: unknown };
const realState = appState.currentState;
let appStateListeners: ((state: AppStateStatus) => void)[];
let addEntry: jest.SpyInstance;

beforeEach(async () => {
  await AsyncStorage.clear();
  appStateListeners = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((type, listener) => {
    if (type === 'change') appStateListeners.push(listener as (state: AppStateStatus) => void);
    return { remove: () => {} } as ReturnType<typeof AppState.addEventListener>;
  });
  addEntry = jest
    .spyOn(ApiClient.prototype, 'addEntry')
    .mockRejectedValue(new ApiError('too_late', 'Süre bitti, artık giriş yok.', 400));
  useAuth.setState({ token: 'tok', me: ME, onboarding: false, serverUrl: 'http://192.168.1.20:4000' });
});

afterEach(() => {
  jest.restoreAllMocks();
  appState.currentState = realState;
  for (const { tree, client } of mounted.splice(0)) {
    act(() => {
      tree.unmount();
    });
    client.clear();
  }
});

describe('a parked entry the server refuses for good', () => {
  it('waits while the app is off screen, then names the çelınc and the day', async () => {
    appState.currentState = 'active';
    const tree = render();
    await settle();

    // off screen: the entry is refused by the background run
    appState.currentState = 'background';
    const yesterday = addDays(safeTodayKey('Europe/Istanbul'), -1);
    await enqueueEntry(
      'c1',
      { dayKey: yesterday, value: 3, source: 'manual', clientTime: new Date().toISOString() },
      'c1:gun',
      undefined,
      'Adım savaşı'
    );
    expect(mockBackground.handler).not.toBeNull();
    await act(async () => {
      await mockBackground.handler?.();
    });
    await settle();

    expect(addEntry).toHaveBeenCalledTimes(1);
    const waiting = await readQueue();
    expect(waiting.map((item) => item.failedReason)).toEqual(['Süre bitti, artık giriş yok.']);
    expect(texts(tree)).not.toContain('Bir giriş gönderilemedi');

    // back on screen: told once, by name, then let go
    appState.currentState = 'active';
    act(() => {
      for (const listener of appStateListeners) listener('active');
    });
    await settle();

    expect(texts(tree)).toContain('Bir giriş gönderilemedi');
    expect(texts(tree)).toContain('“Adım savaşı” · Dün: Süre bitti, artık giriş yok.');
    expect(await readQueue()).toEqual([]);
  });

  it('names a çelınc parked before titles were kept from the cached list', async () => {
    appState.currentState = 'active';
    const day = { dayKey: '2026-09-08', value: 3, source: 'manual', clientTime: '2026-09-08T10:00:00.000Z' };
    await enqueueEntry('c2', day, 'c2:gun');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    client.setQueryData(['challenges', 'all'], [{ challenge: { id: 'c2', title: 'Su içme' } }]);
    const tree = render(client);
    await settle();

    expect(texts(tree)).toContain('“Su içme” · 8 Eylül: Süre bitti, artık giriş yok.');
  });
});

describe('an entry written while a Wi-Fi login page answers for the server', () => {
  it('is parked with its çelınc, not shown as an error nor taken for sent', async () => {
    addEntry.mockRestore();
    const realFetch = global.fetch;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () =>
      new Response('<html>Misafir Wi-Fi girişi</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
    );
    try {
      // a finished mutation lingers five minutes by default and keeps Jest from exiting
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: 0 } },
      });
      client.setQueryData(qk.challenge('c3'), { challenge: { id: 'c3', title: 'Sabah koşusu' } });
      const hook: { add: ReturnType<typeof useAddEntry>['mutateAsync'] | null } = { add: null };
      function Probe() {
        hook.add = useAddEntry('c3').mutateAsync;
        return null;
      }
      let tree!: ReactTestRenderer;
      act(() => {
        tree = create(
          <QueryClientProvider client={client}>
            <Probe />
          </QueryClientProvider>
        );
      });

      let result: AddEntryResult | undefined;
      await act(async () => {
        result = await hook.add?.({ dayKey: '2026-09-08', value: 3, source: 'manual', clientTime: '2026-09-08T10:00:00.000Z' });
      });

      expect(result?.queued).toBe(true);
      const [item] = await readQueue();
      expect(item?.challengeId).toBe('c3');
      expect(item?.challengeTitle).toBe('Sabah koşusu');
      act(() => {
        tree.unmount();
      });
      client.clear();
    } finally {
      (global as unknown as { fetch: unknown }).fetch = realFetch;
    }
  });
});
