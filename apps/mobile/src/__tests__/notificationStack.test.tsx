/**
 * Tapping a notification, its in-app toast or the poll's toast opens a screen.
 * Each of them used `router.push`, so a "Dürtüldün" about the çelınc on screen
 * stacked a second copy of it (back seemed to do nothing), and a kanka request
 * tapped on a çelınc stacked a second tab bar over it.
 */
import type { Me } from '@koydum/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '@/components/Toast';
import { ApiClient } from '@/lib/api';
import { useAuth } from '@/store/auth';

/** One screen of the (app) stack: the tab bar (`tab` is the open one) or a screen over it. */
interface MockScreen {
  path: string;
  params: Record<string, string>;
}

/** Bottom first: `mockStack[0]` is the tab bar. */
const mockStack: MockScreen[] = [];

/** `'/(app)/(tabs)/inbox'`, `'/challenge/c-1?invite=u-3'` or `{ pathname, params }` → a stack entry. */
function mockResolve(href: unknown): MockScreen {
  if (typeof href === 'object' && href !== null) {
    const { pathname, params = {} } = href as { pathname: string; params?: Record<string, string> };
    return { path: pathname.replace('[id]', params.id ?? ''), params: { ...params } };
  }
  const [rawPath = '', query = ''] = String(href).split('?');
  // groups are invisible in the URL, as in expo-router
  const path = rawPath.replace(/\/\([^)]+\)/g, '') || '/';
  const params: Record<string, string> = Object.fromEntries(new URLSearchParams(query));
  const challenge = /^\/challenge\/([^/]+)/.exec(path);
  if (challenge?.[1]) params.id = challenge[1];
  if (['/', '/inbox', '/friends', '/profile'].includes(path)) return { path: '(tabs)', params: { tab: path } };
  return { path, params };
}

/**
 * The (app) stack as expo-router 57 keeps it, cut down to what these taps
 * touch. The real router cannot load under this jest config (its entry imports
 * an ESM package the preset does not transform); these are the rules it showed
 * when rendered with ExpoRoot and getMockContext: `push` always adds a screen;
 * `navigate` adds one unless the screen in front is the same route with the
 * same params (it never goes back to an older copy); a tab route from the tab
 * bar only switches tabs, from a screen over it (push or navigate) it stacks a
 * second tab bar; `dismissAll` goes back down to the tab bar.
 */
function mockOpen(href: unknown, how: 'push' | 'navigate'): void {
  const screen = mockResolve(href);
  const top = mockStack[mockStack.length - 1]!;
  if (screen.path === '(tabs)' && top.path === '(tabs)') {
    top.params = screen.params;
    return;
  }
  const paramsOf = (entry: MockScreen) => JSON.stringify(Object.entries(entry.params).sort());
  const same = top.path === screen.path && paramsOf(top) === paramsOf(screen);
  if (how === 'navigate' && same) return;
  mockStack.push(screen);
}

jest.mock('expo-router', () => ({
  router: {
    push: (href: unknown) => mockOpen(href, 'push'),
    navigate: (href: unknown) => mockOpen(href, 'navigate'),
    replace: () => {
      throw new Error('a notification never replaces a screen');
    },
    canDismiss: () => mockStack.length > 1,
    dismissAll: () => {
      mockStack.splice(1);
    },
    back: () => {
      mockStack.pop();
    },
    canGoBack: () => mockStack.length > 1,
  },
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

/** What the bridge hands the OS: the push tap handler and the foreground push handler. */
const mockListeners: {
  tap?: (route: unknown) => void;
  received?: (title: string, body: string, data: unknown) => void;
} = {};

jest.mock('@/services/notifications', () => ({
  registerForPush: async () => ({ token: null, granted: true, reason: 'no-fcm' as const }),
  installNotificationHandler: () => {},
  addResponseListener: (handler: (route: unknown) => void) => {
    mockListeners.tap = handler;
    return { remove: () => {} };
  },
  addReceivedListener: (handler: (title: string, body: string, data: unknown) => void) => {
    mockListeners.received = handler;
    return { remove: () => {} };
  },
  getInitialRoute: async () => null,
  routeForNotificationData: (data: unknown) =>
    jest.requireActual('@/services/notifications').routeForNotificationData(data),
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
const mockDelivery = { items: [] as unknown[] };
jest.mock('@/services/inboxNotifier', () => ({
  deliverNewInbox: async () => ({ surface: 'in-app', items: mockDelivery.items }),
}));
jest.mock('@/services/invite', () => ({
  ...jest.requireActual('@/services/invite'),
  applyPendingInvite: async () => null,
}));

const { routeForNotificationData } = jest.requireActual('@/services/notifications') as typeof import('@/services/notifications');

const ME = {
  id: 'me-1',
  username: 'mustafa',
  displayName: 'Mustafa',
  avatarEmoji: '🔥',
  vulgarityMax: 2,
  timezone: 'Europe/Istanbul',
} as Me;

const mounted: { tree: ReactTestRenderer; client: QueryClient }[] = [];

function renderBridge(): ReactTestRenderer {
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

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** The stack, bottom first: `(tabs) /inbox` for the tab bar, the path for a screen over it. */
function stack(): string[] {
  return mockStack.map(({ path, params }) => {
    if (path === '(tabs)') return `(tabs) ${params.tab}`;
    return params.invite ? `${path}?invite=${params.invite}` : path;
  });
}

/** Starts the stack as if the user had walked there: the tab bar, then these screens. */
function startOn(tab: string, ...paths: string[]): void {
  mockStack.splice(0, mockStack.length, { path: '(tabs)', params: { tab } }, ...paths.map((path) => mockResolve(path)));
}

/** A tap on the phone's notification with this payload. */
function tapPush(data: Record<string, unknown>): void {
  act(() => {
    mockListeners.tap!(routeForNotificationData(data));
  });
}

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
  mockDelivery.items = [];
  delete mockListeners.tap;
  delete mockListeners.received;
  startOn('/');
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

describe('a notification about the çelınc on screen', () => {
  it('leaves one copy of it when the same push is tapped three times', async () => {
    renderBridge();
    await settle();

    for (let i = 0; i < 3; i++) tapPush({ type: 'poke', challengeId: 'c-1', notificationId: `n${i}` });
    expect(stack()).toEqual(['(tabs) /', '/challenge/c-1']);
    // three times the poke row, still read each time
    expect(markRead).toHaveBeenCalledTimes(3);

    for (let i = 0; i < 3; i++) tapPush({ type: 'taunt', challengeId: 'c-1' });
    expect(stack()).toEqual(['(tabs) /', '/challenge/c-1', '/challenge/c-1/results']);
  });

  it('does not stack the çelınc again from the toast of a push that came in while it was open', async () => {
    startOn('/', '/challenge/c-1');
    const tree = renderBridge();
    await settle();

    act(() => {
      mockListeners.received!('Dürtüldün', 'Ali seni dürttü.', { type: 'poke', challengeId: 'c-1' });
    });
    pressToast(tree, 'Dürtüldün');
    expect(stack()).toEqual(['(tabs) /', '/challenge/c-1']);
  });

  it('does not stack the results again from the poll toast of a "KOYDUM MU?" read on them', async () => {
    startOn('/', '/challenge/c-1', '/challenge/c-1/results');
    mockDelivery.items = [
      {
        id: 'n1',
        type: 'taunt',
        title: 'KOYDUM MU?',
        body: 'Veli sana sapladı',
        data: { challengeId: 'c-1' },
        readAt: null,
        createdAt: '2026-10-18T10:00:00.000Z',
        pushed: false,
      },
    ];
    const tree = renderBridge();
    await settle();

    pressToast(tree, 'KOYDUM MU?');
    expect(stack()).toEqual(['(tabs) /', '/challenge/c-1', '/challenge/c-1/results']);
    expect(markRead).toHaveBeenCalledWith({ ids: ['n1'] });
  });

  it('opens a new kanka\'s invite once, however often it is tapped', async () => {
    renderBridge();
    await settle();

    tapPush({ type: 'friend_accepted', challengeId: 'c-1', userId: 'u-3' });
    tapPush({ type: 'friend_accepted', challengeId: 'c-1', userId: 'u-3' });
    expect(stack()).toEqual(['(tabs) /', '/challenge/c-1?invite=u-3']);
  });

  it('still opens another çelınc over it, and the first one again after that', async () => {
    renderBridge();
    await settle();

    tapPush({ type: 'poke', challengeId: 'c-1' });
    tapPush({ type: 'poke', challengeId: 'c-2' });
    tapPush({ type: 'poke', challengeId: 'c-1' });
    expect(stack()).toEqual(['(tabs) /', '/challenge/c-1', '/challenge/c-2', '/challenge/c-1']);
  });
});

describe('a notification that opens a tab', () => {
  it('lands a kanka request tapped on a çelınc on the friends tab, without a second tab bar', async () => {
    startOn('/', '/challenge/c-1', '/challenge/c-1/results');
    renderBridge();
    await settle();

    tapPush({ type: 'friend_request' });
    expect(stack()).toEqual(['(tabs) /friends']);
  });

  it('sends a pile from the poll to Gelen with one tab bar, from a çelınc', async () => {
    startOn('/', '/challenge/c-1');
    mockDelivery.items = [
      { id: 'n2', type: 'poke', title: 'Dürtüldün', body: 'Ali seni dürttü.', data: { challengeId: 'c-1' }, readAt: null, createdAt: '2026-10-18T10:01:00.000Z', pushed: false },
      { id: 'n1', type: 'poke', title: 'Dürtüldün', body: 'Veli seni dürttü.', data: { challengeId: 'c-1' }, readAt: null, createdAt: '2026-10-18T10:00:00.000Z', pushed: false },
    ];
    const tree = renderBridge();
    await settle();

    pressToast(tree, 'Dürtüldün');
    expect(stack()).toEqual(['(tabs) /inbox']);
    expect(markRead).not.toHaveBeenCalled();
  });

  it('only switches tabs from home', async () => {
    renderBridge();
    await settle();

    tapPush({ type: 'badge' });
    expect(stack()).toEqual(['(tabs) /inbox']);
  });
});
