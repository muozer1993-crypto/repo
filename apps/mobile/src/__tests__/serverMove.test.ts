/**
 * The same server behind a new tunnel address: the session follows it, and
 * the token only ever goes to an address that proved it holds the secret that
 * signed it, for that very address.
 */
import { createHmac } from 'crypto';

import { proveMessage, type Me } from '@koydum/shared';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { StorageKeys, getJson } from '@/lib/storage';
import { isOtherServer, moveSession } from '@/services/serverMove';
import { useAuth } from '@/store/auth';

const OLD = 'https://eski-adres.trycloudflare.com';
const NEW = 'https://yeni-adres.trycloudflare.com';
const SERVER_ID = '0123456789abcdef';
const SECRET = 'sunucunun-gizli-anahtari';

const ME = { id: 'me-1', username: 'mustafa', displayName: 'Mustafa' } as Me;

/** A token signed the way the server signs one (HS256 over `header.payload`). */
function signedToken(sub: string): string {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ sub, iat: 1, exp: 4_000_000_000 })).toString('base64url');
  const signature = createHmac('sha256', SECRET).update(`${head}.${claims}`).digest('base64url');
  return `${head}.${claims}.${signature}`;
}
const TOKEN = signedToken(ME.id);

/** What the real server answers on /auth/prove, vouching for `origin`. */
function honestProof(body: { claims: string; nonce: string }, origin: string) {
  const key = createHmac('sha256', SECRET).update(body.claims).digest();
  return { origin, proof: createHmac('sha256', key).update(proveMessage(body.nonce, origin)).digest('base64url') };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type Prove = 'honest' | ((body: { claims: string; nonce: string }) => Response);

/**
 * Answers /health, /auth/prove and /me at NEW; `me` is the account the token
 * belongs to there. `prove: 'honest'` is our own server behind the new address.
 */
function mockServer(options: {
  serverId?: string | null;
  me?: Response | (() => Response);
  down?: boolean;
  prove?: Prove;
}) {
  const prove = options.prove ?? 'honest';
  const spy = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (options.down) throw new TypeError('Network request failed');
    const url = String(input);
    if (url === `${NEW}/health`) return json({ ok: true, version: '1', time: '', serverId: options.serverId });
    if (url === `${NEW}/auth/prove`) {
      const body = JSON.parse(String(init?.body)) as { claims: string; nonce: string };
      return prove === 'honest' ? json(honestProof(body, NEW)) : prove(body);
    }
    if (url === `${NEW}/me`) {
      const me = options.me ?? json(ME);
      return typeof me === 'function' ? me() : me;
    }
    return json({ error: { code: 'not_found', message: 'Böyle bir uç yok.' } }, 404);
  });
  (global as unknown as { fetch: unknown }).fetch = spy;
  return spy;
}

function bodies(spy: jest.Mock): string[] {
  return spy.mock.calls.map(([, init]) => String((init as RequestInit | undefined)?.body ?? ''));
}

function authHeaders(spy: jest.Mock): (string | undefined)[] {
  return spy.mock.calls.map(([, init]) => ((init as RequestInit | undefined)?.headers as Record<string, string>)?.Authorization);
}

const logout = jest.fn(async () => {});

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  useAuth.setState({ token: TOKEN, me: ME, serverUrl: OLD, serverId: null, logout });
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
    expect(authHeaders(spy)).toEqual([undefined, undefined, `Bearer ${TOKEN}`]);
    // the proof request carries the token's first two parts, never its signature
    const signature = TOKEN.split('.')[2];
    expect(bodies(spy)[1]).toContain(TOKEN.split('.').slice(0, 2).join('.'));
    expect(bodies(spy)[1]).not.toContain(signature);
    const state = useAuth.getState();
    expect(state.serverUrl).toBe(NEW);
    expect(state.token).toBe(TOKEN);
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
    expect(state.token).toBe(TOKEN);
    expect(state.sessionEnded).toBe(false);
    expect(state.serverUrl).toBe(OLD);
    expect(logout).not.toHaveBeenCalled();
  });

  it('calls a server where the token is somebody else another one', async () => {
    mockServer({ serverId: SERVER_ID, me: () => json({ ...ME, id: 'baska-biri' }) });

    expect(await moveSession(NEW)).toBe('different');
    expect(useAuth.getState().serverUrl).toBe(OLD);
  });

  it('never sends the token to a copycat that repeats our public serverId but cannot prove the secret', async () => {
    useAuth.setState({ serverId: SERVER_ID });
    // it read /health once, and it echoes whatever /me is asked
    const spy = mockServer({
      serverId: SERVER_ID,
      prove: () => json({ origin: NEW, proof: 'uydurma' }),
    });

    expect(await moveSession(NEW)).toBe('different');
    expect(authHeaders(spy)).toEqual([undefined, undefined]);
    expect(spy.mock.calls.map(([url]) => String(url))).not.toContain(`${NEW}/me`);
    expect(useAuth.getState().serverUrl).toBe(OLD);
  });

  it('never sends the token to an address that relays the question to the real server', async () => {
    useAuth.setState({ serverId: SERVER_ID });
    // the real server answers honestly, for its own address
    const spy = mockServer({ serverId: SERVER_ID, prove: (body) => json(honestProof(body, OLD)) });

    expect(await moveSession(NEW)).toBe('different');
    expect(authHeaders(spy)).toEqual([undefined, undefined]);
    expect(useAuth.getState().serverUrl).toBe(OLD);
  });

  it('calls an older server without /auth/prove another one rather than hand it the token', async () => {
    const spy = mockServer({
      serverId: SERVER_ID,
      prove: () => json({ error: { code: 'not_found', message: 'Böyle bir uç yok.' } }, 404),
    });

    expect(await moveSession(NEW)).toBe('different');
    expect(authHeaders(spy)).toEqual([undefined, undefined]);
  });

  it('reports an address that does not answer', async () => {
    mockServer({ down: true });

    expect(await moveSession(NEW)).toBe('unreachable');
    expect(useAuth.getState().serverUrl).toBe(OLD);
  });

  it('reports a Wi-Fi login page answering in the server’s place, without throwing or sending the token', async () => {
    const spy = jest.fn(
      async () => new Response('<html>Misafir Wi-Fi girişi</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
    );
    (global as unknown as { fetch: unknown }).fetch = spy;

    await expect(moveSession(NEW)).resolves.toBe('unreachable');
    expect(authHeaders(spy)).toEqual([undefined]);
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
