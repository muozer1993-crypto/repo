/**
 * The same server behind a new tunnel address: the session follows it, and
 * the token only ever goes to an address that has not already said it is
 * another server.
 */
import type { Me } from '@koydum/shared';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { StorageKeys, getJson } from '@/lib/storage';
import { isOtherServer, moveSession } from '@/services/serverMove';
import { useAuth } from '@/store/auth';

const OLD = 'https://eski-adres.trycloudflare.com';
const NEW = 'https://yeni-adres.trycloudflare.com';
const SERVER_ID = '0123456789abcdef';

const ME = { id: 'me-1', username: 'mustafa', displayName: 'Mustafa' } as Me;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Answers /health and /me at NEW; `me` is the account the token belongs to there. */
function mockServer(options: { serverId?: string | null; me?: Response | (() => Response); down?: boolean }) {
  const spy = jest.fn(async (input: RequestInfo | URL) => {
    if (options.down) throw new TypeError('Network request failed');
    const url = String(input);
    if (url === `${NEW}/health`) return json({ ok: true, version: '1', time: '', serverId: options.serverId });
    if (url === `${NEW}/me`) {
      const me = options.me ?? json(ME);
      return typeof me === 'function' ? me() : me;
    }
    return json({ error: { code: 'not_found', message: 'Böyle bir uç yok.' } }, 404);
  });
  (global as unknown as { fetch: unknown }).fetch = spy;
  return spy;
}

function authHeaders(spy: jest.Mock): (string | undefined)[] {
  return spy.mock.calls.map(([, init]) => ((init as RequestInit | undefined)?.headers as Record<string, string>)?.Authorization);
}

const logout = jest.fn(async () => {});

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  useAuth.setState({ token: 'tok', me: ME, serverUrl: OLD, serverId: null, logout });
});

describe('moveSession', () => {
  it('never sends the token to a server whose id is another one', async () => {
    useAuth.setState({ serverId: SERVER_ID });
    const spy = mockServer({ serverId: 'ffffffffffffffff' });

    expect(await moveSession(NEW)).toBe('different');
    expect(spy.mock.calls.map(([url]) => String(url))).toEqual([`${NEW}/health`]);
    expect(authHeaders(spy)).toEqual([undefined]);
    expect(useAuth.getState().serverUrl).toBe(OLD);
  });

  it('treats a server that names nobody as another one once ours is known', async () => {
    useAuth.setState({ serverId: SERVER_ID });
    const spy = mockServer({ serverId: undefined });

    expect(await moveSession(NEW)).toBe('different');
    expect(authHeaders(spy)).toEqual([undefined]);
  });

  it('follows the same account to the new address without logging out', async () => {
    const spy = mockServer({ serverId: SERVER_ID });

    expect(await moveSession(`${NEW}/`)).toBe('moved');
    expect(authHeaders(spy)).toEqual([undefined, 'Bearer tok']);
    const state = useAuth.getState();
    expect(state.serverUrl).toBe(NEW);
    expect(state.token).toBe('tok');
    expect(state.serverId).toBe(SERVER_ID);
    expect(logout).not.toHaveBeenCalled();
    expect(await getJson<string>(StorageKeys.serverUrl)).toBe(NEW);
    expect(await getJson<string>(StorageKeys.serverId)).toBe(SERVER_ID);
  });

  it('moves when the stored id matches', async () => {
    useAuth.setState({ serverId: SERVER_ID });
    mockServer({ serverId: SERVER_ID });

    expect(await moveSession(NEW)).toBe('moved');
    expect(useAuth.getState().serverUrl).toBe(NEW);
  });

  it('calls a server that turns the token down another one, and stays signed in', async () => {
    mockServer({
      serverId: SERVER_ID,
      me: () => json({ error: { code: 'unauthorized', message: 'Giriş yapmalısın.' } }, 401),
    });

    expect(await moveSession(NEW)).toBe('different');
    const state = useAuth.getState();
    expect(state.token).toBe('tok');
    expect(state.sessionEnded).toBe(false);
    expect(state.serverUrl).toBe(OLD);
    expect(logout).not.toHaveBeenCalled();
  });

  it('calls a server where the token is somebody else another one', async () => {
    mockServer({ serverId: SERVER_ID, me: () => json({ ...ME, id: 'baska-biri' }) });

    expect(await moveSession(NEW)).toBe('different');
    expect(useAuth.getState().serverUrl).toBe(OLD);
  });

  it('reports an address that does not answer', async () => {
    mockServer({ down: true });

    expect(await moveSession(NEW)).toBe('unreachable');
    expect(useAuth.getState().serverUrl).toBe(OLD);
  });
});

describe('isOtherServer', () => {
  it('needs a stored id to prove anything', () => {
    expect(isOtherServer(null, 'abc')).toBe(false);
    expect(isOtherServer(null, undefined)).toBe(false);
    expect(isOtherServer('abc', 'abc')).toBe(false);
    expect(isOtherServer('abc', 'def')).toBe(true);
    expect(isOtherServer('abc', null)).toBe(true);
  });
});
