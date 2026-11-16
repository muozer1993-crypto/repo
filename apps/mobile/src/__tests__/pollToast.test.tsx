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
const mockNavigate = jest.fn();
const mockDismissAll = jest.fn();

jest.mock('expo-router', () => ({
  router: {
    push: (...args: unknown[]) => mockPush(...args),
    navigate: (...args: unknown[]) => mockNavigate(...args),
    replace: (...args: unknown[]) => mockReplace(...args),
    back: jest.fn(),
    canGoBack: () => false,
    // on a tab: nothing stacked over the tab bar
    canDismiss: () => false,
    dismissAll: (...args: unknown[]) => mockDismissAll(...args),
  },
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
const mockRefreshReminders = jest.fn(async (..._args: unknown[]) => 0);
jest.mock('@/services/reminders', () => ({
  refreshReminders: (...args: unknown[]) => mockRefreshReminders(...args),
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
/** What the invite parked before sign-in came to; null when there was none. */
const mockPendingInvite: { outcome: { kind: 'accepted'; name: string | null } | null } = { outcome: null };
jest.mock('@/services/invite', () => ({
  ...jest.requireActual('@/services/invite'),
  applyPendingInvite: async () => mockPendingInvite.outcome,
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
  mockPendingInvite.outcome = null;
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

    expect(mockNavigate).toHaveBeenCalledWith('/challenge/c1/results');
    expect(mockPush).not.toHaveBeenCalled();
    expect(markRead).toHaveBeenCalledWith({ ids: ['n1'] });
  });

  it('sends a pile to Gelen without marking anything', async () => {
    mockDelivery.items = [row('n2'), row('n1')];
    const { NotificationBridge } = require('@/providers/NotificationBridge');
    const tree = render(<NotificationBridge />);
    await settle();

    pressToast(tree, 'KOYDUM MU?');
    await settle();

    expect(mockNavigate).toHaveBeenCalledWith('/(app)/(tabs)/inbox');
    expect(mockDismissAll).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    expect(markRead).not.toHaveBeenCalled();
  });
});

describe("the phone's reminders and the inbox poll", () => {
  // Ali sat alone in his "Yarın 04:00" Erken Kalkan Koyar when the phone last
  // planned its alarms; Veli's yes made it a race with a first morning to play.
  it('plans them again when a kanka\'s yes comes in', async () => {
    mockDelivery.items = [
      row('n3', { type: 'challenge_accepted', title: 'Veli kabul etti', body: 'Veli katıldı.', data: { challengeId: 'c1' } }),
    ];
    const { NotificationBridge } = require('@/providers/NotificationBridge');
    render(<NotificationBridge />);
    await settle();
    // once on the way in, once for the yes
    expect(mockRefreshReminders).toHaveBeenCalledTimes(2);
  });

  it('leaves them alone for a laf', async () => {
    mockDelivery.items = [row('n4')];
    const { NotificationBridge } = require('@/providers/NotificationBridge');
    render(<NotificationBridge />);
    await settle();
    expect(mockRefreshReminders).toHaveBeenCalledTimes(1);
  });
});

describe('the toast after an invite parked before sign-in', () => {
  /** Everything on screen once the bridge has applied the invite, read at `level`. */
  async function toastAt(level: 1 | 2 | 3): Promise<string> {
    mockPendingInvite.outcome = { kind: 'accepted', name: 'Ali' };
    // nothing new in the inbox, so no other toast takes its place
    mockDelivery.items = [];
    useAuth.setState({ me: { ...ME, vulgarityMax: level } });
    const { NotificationBridge } = require('@/providers/NotificationBridge');
    const tree = render(<NotificationBridge />);
    await settle();
    const walk = (node: unknown): string[] => {
      if (typeof node === 'string') return [node];
      if (Array.isArray(node)) return node.flatMap(walk);
      if (node && typeof node === 'object' && 'children' in node) return walk((node as { children: unknown }).children);
      return [];
    };
    return walk(tree.toJSON()).join(' ');
  }

  it('sends a "Nazik" reader off to the first çelınc without koy', async () => {
    const text = await toastAt(1);
    expect(text).toContain('Kanka oldunuz');
    expect(text).toContain('İlk çelıncı aç, bakalım kim kazanacak.');
    expect(text).not.toContain('koyacak');
  });

  it('keeps the line as it was from level 2 up', async () => {
    expect(await toastAt(2)).toContain('İlk çelıncı aç, kim kime koyacak görelim.');
  });
});
