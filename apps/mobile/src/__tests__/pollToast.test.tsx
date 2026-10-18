/**
 * The toast the inbox poll shows while the app is on screen. One new row opens
 * its own screen and counts as read, as a tap on its push would; a pile of
 * them goes to Gelen.
 */
import type { Me } from '@koydum/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '@/components/Toast';
import { ApiClient } from '@/lib/api';
import { useAuth } from '@/store/auth';

const mockReplace = jest.fn();
const mockPush = jest.fn();

jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockPush(...args), replace: (...args: unknown[]) => mockReplace(...args), back: jest.fn(), canGoBack: () => false },
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

const mockRegisterForPush = jest.fn(async (_options?: { askAgain?: boolean }) => ({
  token: null,
  granted: true,
  reason: 'no-fcm' as const,
}));

jest.mock('@/services/notifications', () => ({
  registerForPush: (options?: { askAgain?: boolean }) => mockRegisterForPush(options),
  installNotificationHandler: () => {},
  addResponseListener: () => ({ remove: () => {} }),
  addReceivedListener: () => ({ remove: () => {} }),
  getInitialRoute: async () => null,
  routeForNotificationData: (data: unknown) =>
    jest.requireActual('@/services/notifications').routeForNotificationData(data),
}));

const mockStartTracking = jest.fn(() => () => {});
const mockRequestSteps = jest.fn(async () => true);

jest.mock('@/services/steps', () => ({
  startForegroundStepTracking: () => mockStartTracking(),
  requestStepPermission: () => mockRequestSteps(),
  getDailySteps: async () => [],
  getTodaySteps: async () => null,
  getStepAvailability: async () => ({ available: false, reason: 'web' }),
}));

// everything else the bridge starts once it is allowed to: none of it asks the user anything
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
const mockDelivery = { items: [] as unknown[] };
jest.mock('@/services/inboxNotifier', () => ({
  deliverNewInbox: async () => ({ surface: 'in-app', items: mockDelivery.items }),
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

function render(element: ReactElement): ReactTestRenderer {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <SafeAreaProvider
        initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
        <QueryClientProvider client={client}>
          <ToastProvider>{element}</ToastProvider>
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

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'taunt',
  title: 'KOYDUM MU?',
  body: 'Veli sana sapladı',
  data: { challengeId: 'c1' },
  readAt: null,
  createdAt: '2026-10-18T10:00:00.000Z',
  pushed: false,
  ...extra,
});

/** Presses the toast that shows `title`. */
function pressToast(tree: ReactTestRenderer, title: string): void {
  const [node] = tree.root.findAll(
    (candidate) =>
      typeof candidate.props.onPress === 'function' &&
      candidate.findAll((child) => child.props.children === title).length > 0
  );
  if (!node) throw new Error(`"${title}" bulunamadı`);
  act(() => {
    node.props.onPress();
  });
}

let markRead: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  markRead = jest.spyOn(ApiClient.prototype, 'markInboxRead').mockResolvedValue({ updated: 1 } as never);
  useAuth.setState({ token: 'tok', me: ME, onboarding: false, serverUrl: 'http://192.168.1.20:4000' });
});

afterEach(() => {
  markRead.mockRestore();
  for (const { tree, client } of mounted.splice(0)) {
    act(() => {
      tree.unmount();
    });
    client.clear();
  }
});

describe("the inbox poll's toast", () => {
  it("opens a single new row's own screen and marks it read", async () => {
    mockDelivery.items = [row('n1')];
    const { NotificationBridge } = require('@/providers/NotificationBridge');
    const tree = render(<NotificationBridge />);
    await settle();

    pressToast(tree, 'KOYDUM MU?');
    await settle();

    expect(mockPush).toHaveBeenCalledWith('/challenge/c1/results');
    expect(markRead).toHaveBeenCalledWith({ ids: ['n1'] });
  });

  it('sends a pile to Gelen without marking anything', async () => {
    mockDelivery.items = [row('n2'), row('n1')];
    const { NotificationBridge } = require('@/providers/NotificationBridge');
    const tree = render(<NotificationBridge />);
    await settle();

    pressToast(tree, 'KOYDUM MU?');
    await settle();

    expect(mockPush).toHaveBeenCalledWith('/(app)/(tabs)/inbox');
    expect(markRead).not.toHaveBeenCalled();
  });
});
