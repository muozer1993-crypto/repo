import { ApiClient, ApiError } from '@/lib/api';

const BASE = 'http://127.0.0.1:4000';

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const spy = jest.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init ?? {}))
  );
  (global as unknown as { fetch: unknown }).fetch = spy;
  return spy;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ApiClient', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends the bearer token and parses the body', async () => {
    const spy = mockFetch(() => json({ ok: true, version: '1.0.0', time: 'now' }));
    const client = new ApiClient({ baseUrl: BASE, token: 'abc' });
    await expect(client.health()).resolves.toEqual({ ok: true, version: '1.0.0', time: 'now' });
    const init = spy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer abc');
  });

  it('drops a trailing slash from the base url', async () => {
    const spy = mockFetch(() => json({}));
    await new ApiClient({ baseUrl: `${BASE}/` }).me();
    expect(spy.mock.calls[0][0]).toBe(`${BASE}/me`);
  });

  it('builds query strings and skips empty values', async () => {
    const spy = mockFetch(() => json([]));
    await new ApiClient({ baseUrl: BASE }).challenges('active,pending');
    expect(spy.mock.calls[0][0]).toBe(`${BASE}/challenges?status=active%2Cpending`);
    await new ApiClient({ baseUrl: BASE }).challenges(undefined);
    expect(spy.mock.calls[1][0]).toBe(`${BASE}/challenges`);
  });

  it('turns the error envelope into an ApiError', async () => {
    mockFetch(() => json({ error: { code: 'username_taken', message: 'Bu isim alınmış.' } }, 409));
    const client = new ApiClient({ baseUrl: BASE });
    await expect(
      client.register({ username: 'ali', password: 'koydum123', displayName: 'Ali', timezone: 'Europe/Istanbul' })
    ).rejects.toMatchObject({ code: 'username_taken', status: 409, message: 'Bu isim alınmış.' });
  });

  it('reports a Turkish message when the phone cannot reach the server', async () => {
    mockFetch(() => {
      throw new TypeError('Network request failed');
    });
    const error = await new ApiClient({ baseUrl: BASE }).me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isNetwork).toBe(true);
    expect((error as ApiError).message).toMatch(/ulaşamadım/i);
  });

  it('calls onUnauthorized exactly once for a 401', async () => {
    mockFetch(() => json({ error: { code: 'unauthorized', message: 'Giriş yapmalısın.' } }, 401));
    const onUnauthorized = jest.fn();
    const client = new ApiClient({ baseUrl: BASE, token: 'stale', onUnauthorized });
    await expect(client.me()).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('treats 204 as an empty result', async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    await expect(new ApiClient({ baseUrl: BASE }).clearPushToken()).resolves.toBeUndefined();
  });

  it('survives a body that is not JSON', async () => {
    mockFetch(() => new Response('<html>502</html>', { status: 502 }));
    await expect(new ApiClient({ baseUrl: BASE }).me()).rejects.toMatchObject({ code: 'http_502' });
  });

  it('aborts a request that never answers', async () => {
    mockFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }) as unknown as Response
    );
    const client = new ApiClient({ baseUrl: BASE, timeoutMs: 20 });
    await expect(client.me()).rejects.toMatchObject({ code: 'timeout' });
  });
});
