/**
 * The invite deep link screen, driven the way a phone reaches it:
 * koydum://davet/ABC234?server=... while signed in, and on a fresh install.
 *
 * The two rules that came out of review: a signed-in reader sends (or, when the
 * code's owner already asked, ACCEPTS) only on a tap; and a fresh install on
 * the localhost fallback adopts the link's server instead of warning about a
 * "başka sunucu" it never chose.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '@/components/Toast';

const mockSearchParams: { code?: string; server?: string } = {};
const mockReplace = jest.fn();

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: (...args: unknown[]) => mockReplace(...args), back: jest.fn(), canGoBack: () => false },
  useLocalSearchParams: () => mockSearchParams,
}));

const mockLookup = jest.fn(async () => ({ code: 'ABC234', inviter: { username: 'ali', displayName: 'Ali', avatarEmoji: '🐐' } }));
const mockHealth = jest.fn(async () => ({ ok: true, version: '1', time: '' }));
jest.mock('@/lib/api', () => {
  const actual = jest.requireActual('@/lib/api');
  class FakeClient {
    invite = mockLookup;
    health = mockHealth;
  }
  return { ...actual, ApiClient: FakeClient };
});

const mockRequestFriend = jest.fn(async () => ({ status: 'accepted' as const }));
const mockAuth = {
  token: 'token' as string | null,
  serverUrl: 'http://192.168.1.142:4000',
  setServerUrl: jest.fn(async () => {}),
  logout: jest.fn(async () => {}),
  client: () => ({ invite: mockLookup, requestFriend: mockRequestFriend }),
};
jest.mock('@/store/auth', () => ({
  useAuth: (selector: (state: unknown) => unknown) => selector(mockAuth),
}));

// eslint-disable-next-line import/first
import { queryClient } from '@/lib/query';
// eslint-disable-next-line import/first
import { readPendingInvite } from '@/services/invite';

function render(element: ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>{element}</ToastProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    );
  });
  return tree;
}

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function text(tree: ReactTestRenderer): string {
  const walk = (node: unknown): string[] => {
    if (typeof node === 'string') return [node];
    if (Array.isArray(node)) return node.flatMap(walk);
    if (node && typeof node === 'object' && 'children' in node) return walk((node as { children: unknown }).children);
    return [];
  };
  return walk(tree.toJSON()).join(' ');
}

function pressButton(tree: ReactTestRenderer, label: string) {
  const button = tree.root.findAll(
    (node) => typeof node.props.onPress === 'function' && JSON.stringify(node.props.title ?? '') === JSON.stringify(label)
  )[0];
  if (!button) throw new Error(`no button "${label}" in: ${text(tree)}`);
  act(() => {
    button.props.onPress();
  });
}

const Screen = require('@/app/davet/[code]').default;

beforeEach(async () => {
  jest.clearAllMocks();
  const AsyncStorage = require('@react-native-async-storage/async-storage');
  await AsyncStorage.clear();
  mockAuth.token = 'token';
  mockAuth.serverUrl = 'http://192.168.1.142:4000';
  mockSearchParams.code = 'abc234';
  mockSearchParams.server = 'http://192.168.1.142:4000';
});

describe('invite screen, signed in', () => {
  it('shows who invites and sends nothing until the reader taps', async () => {
    const tree = render(<Screen />);
    await settle();
    expect(text(tree)).toContain('Ali seni çağırıyor');
    expect(mockRequestFriend).not.toHaveBeenCalled();

    pressButton(tree, 'Kanka isteği gönder');
    await settle();
    expect(mockRequestFriend).toHaveBeenCalledWith({ inviteCode: 'ABC234' });
    expect(text(tree)).toContain('Artık kankasınız');
  });

  it('a second link opened on top starts clean', async () => {
    const tree = render(<Screen />);
    await settle();
    pressButton(tree, 'Kanka isteği gönder');
    await settle();
    expect(text(tree)).toContain('Artık kankasınız');

    mockSearchParams.code = 'XYZ789';
    mockLookup.mockResolvedValueOnce({ code: 'XYZ789', inviter: { username: 'veli', displayName: 'Veli', avatarEmoji: '🦊' } });
    act(() => tree.update(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Screen key="same-instance" />
          </ToastProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    ));
    await settle();
    expect(text(tree)).not.toContain('Artık kankasınız');
    expect(text(tree)).toContain('XYZ789');
  });
});

describe('invite screen, fresh install', () => {
  it('adopts the link server after a health check instead of warning about another server', async () => {
    mockAuth.token = null;
    mockAuth.serverUrl = 'http://localhost:4000';
    const tree = render(<Screen />);
    await settle();
    expect(text(tree)).not.toContain('başka bir sunucudan');

    pressButton(tree, 'Kayıt ol');
    await settle();
    expect(mockHealth).toHaveBeenCalled();
    expect(mockAuth.setServerUrl).toHaveBeenCalledWith('http://192.168.1.142:4000');
    expect(mockReplace).toHaveBeenCalledWith('/(auth)/register');
    expect(await readPendingInvite()).toMatchObject({ code: 'ABC234', server: 'http://192.168.1.142:4000' });
  });

  it('still asks before leaving a server the reader chose', async () => {
    mockAuth.token = null;
    mockAuth.serverUrl = 'http://10.0.0.5:4000';
    const tree = render(<Screen />);
    await settle();
    expect(text(tree)).toContain('başka bir sunucudan');
    expect(mockAuth.setServerUrl).not.toHaveBeenCalled();
  });
});
