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

  it('renews the token and changes the password on their own paths', async () => {
    const spy = mockFetch(() => json({ token: 'yeni' }));
    const client = new ApiClient({ baseUrl: BASE, token: 'eski' });

    await expect(client.refreshToken()).resolves.toEqual({ token: 'yeni' });
    expect(spy.mock.calls[0][0]).toBe(`${BASE}/auth/refresh`);
    const refresh = spy.mock.calls[0][1] as RequestInit;
    expect(refresh.method).toBe('POST');
    expect(refresh.body).toBeUndefined();

    await client.changePassword({ currentPassword: '123456', newPassword: 'yepyeni42' });
    expect(spy.mock.calls[1][0]).toBe(`${BASE}/me/password`);
    const change = spy.mock.calls[1][1] as RequestInit;
    expect(change.method).toBe('POST');
    expect(JSON.parse(String(change.body))).toEqual({ currentPassword: '123456', newPassword: 'yepyeni42' });
  });

  it('keeps the session when the current password is wrong', async () => {
    mockFetch(() => json({ error: { code: 'wrong_password', message: 'Mevcut şifren tutmadı.' } }, 400));
    const onUnauthorized = jest.fn();
    const client = new ApiClient({ baseUrl: BASE, token: 'abc', onUnauthorized });
    await expect(
      client.changePassword({ currentPassword: 'yanlis', newPassword: 'yepyeni42' })
    ).rejects.toMatchObject({ code: 'wrong_password', status: 400 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('treats 204 as an empty result', async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    await expect(new ApiClient({ baseUrl: BASE }).clearPushToken()).resolves.toBeUndefined();
  });

  it('survives a body that is not JSON', async () => {
    mockFetch(() => new Response('<html>502</html>', { status: 502 }));
    await expect(new ApiClient({ baseUrl: BASE }).me()).rejects.toMatchObject({ code: 'server_down', status: 502 });
  });

  it('still returns an empty 2xx body as it did', async () => {
    mockFetch(() => new Response('', { status: 200 }));
    await expect(new ApiClient({ baseUrl: BASE }).me()).resolves.toBeNull();
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

describe('a reply that is not from our server', () => {
  const html = (status: number, page = '<html><body>Hata</body></html>') =>
    new Response(page, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

  it("reads the tunnel's 530 (the owner's PC asleep) as the server being off, not as no signal", async () => {
    mockFetch(() => html(530, '<title>Cloudflare Tunnel error</title>'));
    const error = (await new ApiClient({ baseUrl: 'https://x.trycloudflare.com' }).me().catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'server_down', status: 530 });
    expect(error.isNetwork).toBe(false);
    expect(error.message).toMatch(/kapalı ya da uyuyor/);
  });

  it("reads a gateway's 502 the same way", async () => {
    mockFetch(() => html(502));
    const error = (await new ApiClient({ baseUrl: BASE }).me().catch((e: unknown) => e)) as ApiError;
    expect(error).toMatchObject({ code: 'server_down', status: 502 });
    expect(error.isNetwork).toBe(false);
  });

  it('calls a 404 page somebody else, and never ends the session over it', async () => {
    mockFetch(() => html(404));
    const onUnauthorized = jest.fn();
    const client = new ApiClient({ baseUrl: BASE, token: 'abc', onUnauthorized });
    await expect(client.me()).rejects.toMatchObject({ code: 'not_koydum', status: 404 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("signs nobody out over a proxy's 401 page; our own 401 still does", async () => {
    const onUnauthorized = jest.fn();
    const client = new ApiClient({ baseUrl: BASE, token: 'abc', onUnauthorized });

    mockFetch(() => html(401, '<h1>401 Authorization Required</h1>'));
    await expect(client.me()).rejects.toMatchObject({ code: 'not_koydum', status: 401 });
    expect(onUnauthorized).not.toHaveBeenCalled();

    mockFetch(() => json({ error: { code: 'unauthorized', message: 'Şifren değişti.' } }, 401));
    await expect(client.me()).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('throws a 200 Wi-Fi login page instead of handing it back as an empty answer', async () => {
    mockFetch(() => html(200, '<html>Misafir Wi-Fi girişi</html>'));
    const error = (await new ApiClient({ baseUrl: BASE })
      .addEntry('c1', { dayKey: '2026-09-08', value: 3, source: 'manual', clientTime: '2026-09-08T10:00:00.000Z' })
      .catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'not_koydum', status: 0 });
    // parked like no signal, wherever an entry is parked
    expect(error.isNetwork).toBe(true);
    expect(error.message).toMatch(/Wi-Fi giriş sayfası/);
  });

  it("keeps a proxy's 413 about the file, not about the address", async () => {
    mockFetch(() => html(413, '<center>nginx</center>'));
    await expect(new ApiClient({ baseUrl: BASE }).me()).rejects.toMatchObject({ code: 'too_large', status: 413 });
  });

  it('keeps our own 5xx envelope as it is', async () => {
    mockFetch(() => json({ error: { code: 'internal', message: 'Sunucuda bir şeyler ters gitti.' } }, 503));
    await expect(new ApiClient({ baseUrl: BASE }).me()).rejects.toMatchObject({ code: 'internal', status: 503 });
  });

  it('asks about the same network only for a home address', async () => {
    mockFetch(() => {
      throw new TypeError('Network request failed');
    });
    const home = (await new ApiClient({ baseUrl: 'http://192.168.1.5:4000' }).me().catch((e: unknown) => e)) as ApiError;
    expect(home.message).toMatch(/Aynı ağda/);

    const tunnel = (await new ApiClient({ baseUrl: 'https://x.trycloudflare.com' }).me().catch((e: unknown) => e)) as ApiError;
    expect(tunnel.isNetwork).toBe(true);
    expect(tunnel.message).not.toMatch(/Aynı ağda/);
    expect(tunnel.message).toMatch(/İnternetin açık mı/);
  });
});
