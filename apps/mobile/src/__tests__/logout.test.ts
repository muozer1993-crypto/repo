/* eslint-disable import/first -- the jest.mock call must run before the store is imported */
/**
 * Logging out takes the account's phone-side alarms with it: a phone handed
 * to someone else, or signed into another account, must not keep ringing
 * "30 dakikan kaldı" for the old account's check-ins for two more weeks.
 *
 * And the server's 401 logs out only the session it was about: a password
 * change retires every older token, this phone's included, and a request still
 * out with it must not sign out the phone that just changed it.
 */
const mockClearReminders = jest.fn(async () => {});
jest.mock('@/services/reminders', () => ({ clearReminders: () => mockClearReminders() }));

import type { Me } from '@koydum/shared';

import { ApiClient } from '@/lib/api';
import { StorageKeys, getItem, getJson, removeItem, setItem, setJson } from '@/lib/storage';
import { flushPendingPushClear } from '@/services/pushClear';
import { useAuth } from '@/store/auth';
import { clockSkewMs, noteServerTime } from '@/utils/serverClock';

const ME = { id: 'me-1', username: 'mustafa', displayName: 'Mustafa' } as Me;

describe('logout', () => {
  it("cancels the phone's own reminders", async () => {
    useAuth.setState({ token: 'tok', me: ME });
    global.fetch = jest.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;

    await useAuth.getState().logout();

    expect(useAuth.getState().token).toBeNull();
    expect(mockClearReminders).toHaveBeenCalledTimes(1);
  });

  it('takes the check-in çelıncs kept for a start with no connection with it', async () => {
    // the next account on this phone must never be drawn this one's çelınc
    await setJson(StorageKeys.savedDetails, { ownerId: ME.id, details: [{ challenge: { id: 'c-1' }, participants: [] }] });
    useAuth.setState({ token: 'tok', me: ME });

    await useAuth.getState().logout();

    expect(await getItem(StorageKeys.savedDetails)).toBeNull();
  });

  it("asks the server to clear only this phone's push token", async () => {
    // a friend moved to a new phone and is signing out of the old one: the
    // account's push token may be the new phone's by now
    await setItem(StorageKeys.pushToken, 'ExponentPushToken[x]');
    useAuth.setState({ token: 'tok', me: ME });
    const fetchMock = jest.fn(async () => new Response('{"ok":true,"hasPushToken":true}', { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const clear = jest.spyOn(ApiClient.prototype, 'clearPushToken');

    await useAuth.getState().logout();

    expect(clear).toHaveBeenCalledWith('ExponentPushToken[x]');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/me\/push-token$/);
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(String(init.body))).toEqual({ token: 'ExponentPushToken[x]' });
    // the session's copy is gone all the same
    expect(await getItem(StorageKeys.pushToken)).toBeNull();
    clear.mockRestore();
  });

  it('sends null when this phone never registered a push token', async () => {
    useAuth.setState({ token: 'tok', me: ME });
    const fetchMock = jest.fn(async () => new Response('{"ok":true,"hasPushToken":true}', { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await useAuth.getState().logout();

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // null, never a missing body: that clears whatever the server holds
    expect(JSON.parse(String(init.body))).toEqual({ token: null });
  });

  it('still logs out when cancelling the alarms fails', async () => {
    mockClearReminders.mockRejectedValueOnce(new Error('no module'));
    useAuth.setState({ token: 'tok', me: ME });

    await useAuth.getState().logout();

    expect(useAuth.getState().token).toBeNull();
  });
});

describe("a logout's push clear the server did not hear", () => {
  const TABLET = 'ExponentPushToken[tablet]';
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  beforeEach(async () => {
    await removeItem(StorageKeys.pendingPushClear);
  });

  it('is kept and sent again later, so the slot does not stay with a signed-out tablet', async () => {
    await setItem(StorageKeys.pushToken, TABLET);
    useAuth.setState({ token: 'tok', me: ME });
    const serverUrl = useAuth.getState().serverUrl;
    // the owner's PC is asleep: nothing answers
    global.fetch = jest.fn(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;

    await useAuth.getState().logout();
    await settle();
    expect(await getJson(StorageKeys.pendingPushClear)).toEqual({ serverUrl, sessionToken: 'tok', pushToken: TABLET });

    // the next start, or a foreground while signed out: the PC is up again
    const fetchMock = jest.fn(async () => new Response('{"ok":true,"hasPushToken":true}', { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    await flushPendingPushClear();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/me\/push-token$/);
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(String(init.body))).toEqual({ token: TABLET });
    expect(await getJson(StorageKeys.pendingPushClear)).toBeNull();
  });

  it('goes with a sign-in on this phone, and with the server turning the session down', async () => {
    const entry = { serverUrl: 'http://pc', sessionToken: 'tok', pushToken: TABLET };
    await setJson(StorageKeys.pendingPushClear, entry);
    await useAuth.getState().setSession('yeni', ME);
    await settle();
    expect(await getJson(StorageKeys.pendingPushClear)).toBeNull();

    // signed out again, and the old session is dead by now (a password change)
    await removeItem(StorageKeys.token);
    await setJson(StorageKeys.pendingPushClear, entry);
    global.fetch = jest.fn(
      async () => new Response('{"error":{"code":"unauthorized","message":"Oturum kapandı."}}', { status: 401 })
    ) as unknown as typeof fetch;
    await flushPendingPushClear();
    expect(await getJson(StorageKeys.pendingPushClear)).toBeNull();
  });
});

describe('a 401 from the server', () => {
  const REASON = 'Şifren değişti, bu telefondaki oturum kapandı. Yeni şifreyle gir.';

  function answer401(body: unknown) {
    global.fetch = jest.fn(
      async () => new Response(body === null ? '' : JSON.stringify(body), { status: 401 })
    ) as unknown as typeof fetch;
  }

  beforeEach(() => {
    mockClearReminders.mockClear();
    useAuth.setState({ token: 'eski', me: ME, sessionEnded: false, sessionEndReason: null });
  });

  it('leaves alone the session that replaced the token it was about', async () => {
    const before = useAuth.getState().client();
    // the password sheet's answer landed while this request was out
    useAuth.setState({ token: 'yeni' });
    answer401({ error: { code: 'unauthorized', message: REASON } });

    await expect(before.me()).rejects.toMatchObject({ status: 401 });

    expect(useAuth.getState().token).toBe('yeni');
    expect(useAuth.getState().sessionEnded).toBe(false);
    expect(mockClearReminders).not.toHaveBeenCalled();
  });

  it("signs out the session it was about, keeping the server's reason for the login screen", async () => {
    answer401({ error: { code: 'unauthorized', message: REASON } });

    await expect(useAuth.getState().client().me()).rejects.toMatchObject({ status: 401 });

    expect(useAuth.getState().token).toBeNull();
    expect(useAuth.getState().sessionEnded).toBe(true);
    expect(useAuth.getState().sessionEndReason).toBe(REASON);
    expect(mockClearReminders).toHaveBeenCalledTimes(1);

    useAuth.getState().clearSessionEnded();
    expect(useAuth.getState().sessionEndReason).toBeNull();
  });

  it('keeps the session over a 401 that is not our envelope', async () => {
    answer401(null); // a proxy in the way: it says nothing about our token

    await expect(useAuth.getState().client().me()).rejects.toMatchObject({ status: 401, code: 'not_koydum' });

    expect(useAuth.getState().token).toBe('eski');
    expect(useAuth.getState().sessionEnded).toBe(false);
    expect(mockClearReminders).not.toHaveBeenCalled();
  });

  it('keeps no reason from a 401 of ours that is not about the session', async () => {
    answer401({ error: { code: 'bad_credentials', message: 'Kullanıcı adı ya da şifre yanlış.' } });

    await expect(useAuth.getState().client().me()).rejects.toMatchObject({ status: 401 });

    expect(useAuth.getState().token).toBeNull();
    expect(useAuth.getState().sessionEnded).toBe(true);
    expect(useAuth.getState().sessionEndReason).toBeNull();
  });
});

describe("the server clock's difference", () => {
  const SENT = Date.parse('2026-11-15T09:00:00.000Z');
  // the old server's clock, three hours ahead of the phone
  const measure = () => noteServerTime('2026-11-15T12:00:00.500Z', SENT, SENT + 1_000);

  beforeEach(() => {
    global.fetch = jest.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  });

  it('goes with a sign-out: the next account may be on another server', async () => {
    useAuth.setState({ token: 'tok', me: ME });
    measure();
    expect(clockSkewMs()).toBe(3 * 3_600_000);

    await useAuth.getState().logout();

    expect(clockSkewMs()).toBeNull();
  });

  it('goes with a new address, and stays for the same one', async () => {
    await useAuth.getState().setServerUrl('https://eski.trycloudflare.com');
    measure();
    await useAuth.getState().setServerUrl('https://eski.trycloudflare.com/');
    expect(clockSkewMs()).toBe(3 * 3_600_000);

    await useAuth.getState().setServerUrl('https://yeni.trycloudflare.com');
    expect(clockSkewMs()).toBeNull();
  });
});
