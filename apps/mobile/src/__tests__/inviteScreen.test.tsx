/**
 * The invite deep link screen, driven the way a phone reaches it:
 * koydum://davet/ABC234?server=... while signed in, and on a fresh install.
 *
 * The two rules that came out of review: a signed-in reader sends (or, when the
 * code's owner already asked, ACCEPTS) only on a tap; and a fresh install on
 * the localhost fallback adopts the link's server instead of warning about a
 * "başka sunucu" it never chose. And since tunnel restarts: a link from the
 * same server at a new address moves the session instead of logging out.
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
const mockHealth = jest.fn(async (): Promise<{ ok: boolean; version: string; time: string; serverId?: string }> => ({
  ok: true,
  version: '1',
  time: '',
}));
const mockMe = jest.fn(async () => ({ id: 'me-1' }));
/** A session token signed the way the server signs one, with the server's secret. */
const MOCK_SECRET = 'sunucunun-gizli-anahtari';
function mockSignedToken(): string {
  const { createHmac } = require('crypto') as typeof import('crypto');
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ sub: 'me-1', iat: 1, exp: 4_000_000_000 })).toString('base64url');
  return `${head}.${claims}.${createHmac('sha256', MOCK_SECRET).update(`${head}.${claims}`).digest('base64url')}`;
}
const TOKEN = mockSignedToken();
/** Our own server answering /auth/prove for the address it was asked at. */
const mockProve = jest.fn(async (origin: string, body: { claims: string; nonce: string }) => {
  const { createHmac } = require('crypto') as typeof import('crypto');
  const { proveMessage } = require('@koydum/shared') as typeof import('@koydum/shared');
  const key = createHmac('sha256', MOCK_SECRET).update(body.claims).digest();
  return { origin, proof: createHmac('sha256', key).update(proveMessage(body.nonce, origin)).digest('base64url') };
});
/** every client the screen (or serverMove) built, and the token it carried */
const mockClients: { baseUrl: string; token: string | null }[] = [];
jest.mock('@/lib/api', () => {
  const actual = jest.requireActual('@/lib/api');
  class FakeClient {
    invite = mockLookup;
    health = mockHealth;
    me = mockMe;
    prove: (body: { claims: string; nonce: string }) => ReturnType<typeof mockProve>;
    constructor(options: { baseUrl: string; token?: string | null }) {
      mockClients.push({ baseUrl: options.baseUrl, token: options.token ?? null });
      this.prove = (body) => mockProve(options.baseUrl, body);
    }
  }
  return { ...actual, ApiClient: FakeClient };
});

const mockRequestFriend = jest.fn(async () => ({ status: 'accepted' as const }));
const mockAuth = {
  token: null as string | null,
  me: { id: 'me-1' },
  serverUrl: 'http://192.168.1.142:4000',
  serverId: null as string | null,
  setServerUrl: jest.fn(async (url: string) => {
    mockAuth.serverUrl = url;
  }),
  rememberServerId: jest.fn(async () => {}),
  setMe: jest.fn(async () => {}),
  logout: jest.fn(async () => {}),
  client: () => ({ invite: mockLookup, requestFriend: mockRequestFriend }),
};
jest.mock('@/store/auth', () => ({
  // serverMove reads the store outside React, the screen through the hook
  useAuth: Object.assign((selector: (state: unknown) => unknown) => selector(mockAuth), {
    getState: () => mockAuth,
  }),
  useLevel: () => 2,
}));

// eslint-disable-next-line import/first
import { queryClient } from '@/lib/query';
// eslint-disable-next-line import/first
import { readPendingInvite } from '@/services/invite';

/** unmounted after each test, so a toast's hide timer dies with its tree */
const mounted: ReactTestRenderer[] = [];

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
  mounted.push(tree);
  return tree;
}

afterEach(() => {
  for (const tree of mounted.splice(0)) {
    act(() => {
      tree.unmount();
    });
  }
});

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

/** Button titles as passed in; the rendered label is upper-cased */
function buttons(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAll((node) => typeof node.props.onPress === 'function' && typeof node.props.title === 'string')
    .map((node) => node.props.title as string);
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
  mockClients.length = 0;
  // a test that made the server name itself must not leak that into the next
  mockHealth.mockResolvedValue({ ok: true, version: '1', time: '' });
  const AsyncStorage = require('@react-native-async-storage/async-storage');
  await AsyncStorage.clear();
  mockAuth.token = TOKEN;
  mockAuth.serverUrl = 'http://192.168.1.142:4000';
  mockAuth.serverId = null;
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

describe('invite screen, signed in, link from a new address', () => {
  const OLD = 'https://eski-adres.trycloudflare.com';
  const NEW = 'https://yeni-adres.trycloudflare.com';

  beforeEach(() => {
    mockAuth.serverUrl = OLD;
    mockAuth.serverId = '0123456789abcdef';
    mockSearchParams.server = NEW;
  });

  it('follows the same server to its new address and keeps the session', async () => {
    mockHealth.mockResolvedValue({ ok: true, version: '1', time: '', serverId: '0123456789abcdef' });
    const tree = render(<Screen />);
    await settle();
    expect(text(tree)).toContain('Sunucunun adresi değişmiş olabilir');
    expect(text(tree)).toContain('yeni-adres.trycloudflare.com');

    pressButton(tree, 'Yeni adrese geç (çıkış yok)');
    await settle();
    expect(mockAuth.setServerUrl).toHaveBeenCalledWith(NEW);
    expect(mockAuth.logout).not.toHaveBeenCalled();
    // the account was checked at the new address with the token it already had
    expect(mockMe).toHaveBeenCalledTimes(1);
    expect(mockClients).toContainEqual({ baseUrl: NEW, token: TOKEN });
    // after it proved, for this very address, that it holds the secret behind that token
    expect(mockProve).toHaveBeenCalledWith(NEW, expect.objectContaining({ claims: TOKEN.split('.').slice(0, 2).join('.') }));
    // same server now: the ordinary card, request still only on a tap
    expect(buttons(tree)).toContain('Kanka isteği gönder');
    expect(text(tree)).toContain('yeni adrese geçtik');
    expect(mockRequestFriend).not.toHaveBeenCalled();
  });

  it('keeps the logout card for a server whose id is another one', async () => {
    mockHealth.mockResolvedValue({ ok: true, version: '1', time: '', serverId: 'ffffffffffffffff' });
    const tree = render(<Screen />);
    await settle();
    expect(text(tree)).toContain('başka bir sunucudan');
    expect(buttons(tree)).not.toContain('Yeni adrese geç (çıkış yok)');
    expect(buttons(tree)).toContain('Çıkış yap, orada giriş yap');
    // nothing was sent with the token
    expect(mockMe).not.toHaveBeenCalled();
    expect(mockClients.every((client) => client.token === null)).toBe(true);
  });

  it('says so when the tap finds another account there, and still offers the way out', async () => {
    mockAuth.serverId = null;
    mockMe.mockResolvedValueOnce({ id: 'baska-biri' });
    const tree = render(<Screen />);
    await settle();

    pressButton(tree, 'Yeni adrese geç (çıkış yok)');
    await settle();
    expect(text(tree)).toContain('Bu başka bir sunucu');
    expect(buttons(tree)).not.toContain('Yeni adrese geç (çıkış yok)');
    expect(buttons(tree)).toContain('Çıkış yap, orada kayıt ol');
    expect(mockAuth.setServerUrl).not.toHaveBeenCalled();
    expect(mockAuth.logout).not.toHaveBeenCalled();
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
