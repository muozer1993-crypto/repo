/**
 * The first minute after sign-up. NotificationBridge used to ask for
 * notifications and physical activity the moment the token landed, so both
 * system dialogs popped up over the first welcome slide with nothing on screen
 * to say why. Now the bridge waits while the slides are up, the last slide asks
 * for both with a reason, and the wait ends however the slides go away.
 *
 * The real auth store is used here (screens.test mocks it), because what is
 * under test is the bridge reacting to the store's `onboarding` flag changing.
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

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: (...args: unknown[]) => mockReplace(...args), back: jest.fn(), canGoBack: () => false },
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
  routeForNotificationData: () => null,
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
jest.mock('@/services/reminders', () => ({ refreshReminders: async () => 0, cancelAllReminders: async () => {} }));
jest.mock('@/services/stepSync', () => ({ syncStepsNow: async () => ({ days: 0, updated: 0 }) }));
jest.mock('@/services/screenTimeSync', () => ({ syncScreenTimeNow: async () => ({ days: 0, updated: 0 }) }));
jest.mock('@/services/offlineQueue', () => ({
  flushQueue: async () => ({ sent: 0 }),
  readQueue: async () => [],
  clearFailed: async () => {},
}));
jest.mock('@/services/inboxNotifier', () => ({ deliverNewInbox: async () => ({ surface: 'in-app', items: [] }) }));
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

function textIn(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textIn);
  if (node && typeof node === 'object' && 'children' in node) return textIn((node as { children: unknown }).children);
  return [];
}

const rendered = (tree: ReactTestRenderer) => textIn(tree.toJSON()).join(' ');

function findWith(tree: ReactTestRenderer, key: string, value: string, handler: string) {
  const [node] = tree.root.findAll(
    (candidate) => candidate.props[key] === value && typeof candidate.props[handler] === 'function'
  );
  if (!node) throw new Error(`${key}="${value}" bulunamadı`);
  return node;
}

function press(tree: ReactTestRenderer, title: string): void {
  act(() => {
    findWith(tree, 'title', title, 'onPress').props.onPress();
  });
}

/** Presses the first pressable that shows `label` (one without a `title`, such as "Geç"). */
function pressText(tree: ReactTestRenderer, label: string): void {
  const [node] = tree.root.findAll(
    (candidate) =>
      typeof candidate.props.onPress === 'function' &&
      candidate.findAll((child) => child.props.children === label).length > 0
  );
  if (!node) throw new Error(`"${label}" bulunamadı`);
  act(() => {
    node.props.onPress();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  useAuth.setState({ token: null, me: null, onboarding: false, serverUrl: 'http://192.168.1.20:4000' });
});

afterEach(() => {
  for (const { tree, client } of mounted.splice(0)) {
    act(() => {
      tree.unmount();
    });
    client.clear();
  }
});

describe('the bridge during the welcome slides', () => {
  it('asks for nothing while they are up, and for both once they are gone', async () => {
    const { NotificationBridge } = require('@/providers/NotificationBridge');
    useAuth.setState({ token: 'tok', me: ME, onboarding: true });
    render(<NotificationBridge />);
    await settle();
    expect(mockRegisterForPush).not.toHaveBeenCalled();
    expect(mockStartTracking).not.toHaveBeenCalled();

    act(() => {
      useAuth.getState().setOnboarding(false);
    });
    await settle();
    expect(mockRegisterForPush).toHaveBeenCalledTimes(1);
    // without a second dialog when the slide already asked (permissionPrompts.test)
    expect(mockRegisterForPush).toHaveBeenCalledWith({ askAgain: false });
    expect(mockStartTracking).toHaveBeenCalledTimes(1);
  });

  it('a sign-up raises the flag before the token lands, then opens the slides', async () => {
    const register = jest.spyOn(ApiClient.prototype, 'register').mockResolvedValue({ token: 'tok', me: ME });
    const health = jest.spyOn(ApiClient.prototype, 'health').mockRejectedValue(new Error('offline'));
    const seen: { token: string | null; onboarding: boolean }[] = [];
    const unsubscribe = useAuth.subscribe((state) => seen.push({ token: state.token, onboarding: state.onboarding }));
    try {
      const RegisterScreen = require('@/app/(auth)/register').default;
      const tree = render(<RegisterScreen />);
      await settle();
      act(() => {
        findWith(tree, 'label', 'Kullanıcı adı', 'onChangeText').props.onChangeText('mustafa');
        findWith(tree, 'label', 'Görünen ad', 'onChangeText').props.onChangeText('Mustafa');
        findWith(tree, 'label', 'Şifre', 'onChangeText').props.onChangeText('cokgizli');
      });
      press(tree, 'Kaydol ve başla');
      await settle();

      expect(register).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith('/onboarding');
      // there was never a moment with a token and no hold for the bridge to act on
      expect(seen.filter((state) => state.token && !state.onboarding)).toEqual([]);
      expect(useAuth.getState().onboarding).toBe(true);
    } finally {
      unsubscribe();
      register.mockRestore();
      health.mockRestore();
    }
  });
});

describe('the permission slide', () => {
  function renderSlides(): ReactTestRenderer {
    useAuth.setState({ token: 'tok', me: ME, onboarding: true });
    const OnboardingScreen = require('@/app/onboarding').default;
    return render(<OnboardingScreen />);
  }

  it('is the fourth slide, and its two buttons ask for each permission', async () => {
    const tree = renderSlides();
    press(tree, 'DEVAM');
    press(tree, 'DEVAM');
    press(tree, 'DEVAM');
    expect(() => findWith(tree, 'title', 'BAŞLAYALIM', 'onPress')).not.toThrow();
    expect(rendered(tree)).toContain('İki izin, o kadar');
    expect(rendered(tree)).toContain('Kanka sana koyunca duyman lazım');

    press(tree, 'Bildirim izni');
    await settle();
    expect(mockRegisterForPush).toHaveBeenCalledTimes(1);
    expect(rendered(tree)).toContain('Bildirim izni verildi');

    mockRequestSteps.mockResolvedValueOnce(false);
    press(tree, 'Adım izni');
    await settle();
    expect(mockRequestSteps).toHaveBeenCalledTimes(1);
    // a no keeps the button for a second try and says it is fine either way
    expect(rendered(tree)).not.toContain('Adım izni verildi');
    expect(rendered(tree)).toContain('Vermezsen de olur');
    expect(() => findWith(tree, 'title', 'Adım izni', 'onPress')).not.toThrow();

    // nothing here waits on the answers
    press(tree, 'BAŞLAYALIM');
    expect(useAuth.getState().onboarding).toBe(false);
    expect(mockReplace).toHaveBeenCalledWith('/(app)/(tabs)');
  });

  it('"Geç" skips the talk but lands on the permissions, and only leaves from there', () => {
    const tree = renderSlides();

    pressText(tree, 'Geç');
    expect(mockReplace).not.toHaveBeenCalled();
    expect(() => findWith(tree, 'title', 'BAŞLAYALIM', 'onPress')).not.toThrow();
    expect(useAuth.getState().onboarding).toBe(true);

    pressText(tree, 'Geç');
    expect(mockReplace).toHaveBeenCalledWith('/(app)/(tabs)');
    expect(useAuth.getState().onboarding).toBe(false);
  });

  it('lets the bridge go when the slides are left any other way (Android back)', () => {
    renderSlides();
    expect(useAuth.getState().onboarding).toBe(true);
    const { tree, client } = mounted.pop()!;
    act(() => {
      tree.unmount();
    });
    client.clear();
    expect(useAuth.getState().onboarding).toBe(false);
  });
});
