/**
 * The weekly token renewal: due after a week, quiet inside it, and never
 * writing a token back for somebody who signed out while it was in flight.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { ApiClient } from '@/lib/api';
import { ApiError } from '@/lib/api';
import { StorageKeys, getItem, getJson, removeItem, setItem, setJson } from '@/lib/storage';
import { runBackgroundWork } from '@/services/backgroundWork';
import { RENEW_AFTER_MS, renewTokenIfDue } from '@/services/session';

// the headless run's other chores are not what this file is about
const mockSyncStepsNow = jest.fn(async (_deps: { client: ApiClient }) => {});
jest.mock('@/services/stepSync', () => ({
  syncStepsNow: (deps: { client: ApiClient }) => mockSyncStepsNow(deps),
}));
jest.mock('@/services/screenTimeSync', () => ({ syncScreenTimeNow: jest.fn(async () => {}) }));
jest.mock('@/services/offlineQueue', () => ({ flushQueue: jest.fn(async () => {}) }));
const mockDeliverNewInbox = jest.fn(async () => {});
jest.mock('@/services/inboxNotifier', () => ({ deliverNewInbox: () => mockDeliverNewInbox() }));
const mockRefreshReminders = jest.fn(async (_client: ApiClient, _level: number, _tz: string) => 0);
const mockClearReminders = jest.fn(async () => {});
jest.mock('@/services/reminders', () => ({
  refreshReminders: (client: ApiClient, level: number, tz: string) => mockRefreshReminders(client, level, tz),
  clearReminders: () => mockClearReminders(),
}));

const NOW = new Date('2026-09-27T10:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function client(refreshToken: jest.Mock = jest.fn(async () => ({ token: 'yeni' }))) {
  return { api: { token: 'eski', refreshToken } as unknown as ApiClient, refreshToken };
}

async function renewedDaysAgo(days: number): Promise<void> {
  await setJson(StorageKeys.tokenRenewedAt, new Date(NOW.getTime() - days * DAY_MS).toISOString());
}

beforeEach(async () => {
  await AsyncStorage.clear();
  await setJson(StorageKeys.token, 'eski');
  mockSyncStepsNow.mockClear();
  mockDeliverNewInbox.mockClear();
  mockRefreshReminders.mockClear();
  mockClearReminders.mockClear();
});

afterAll(async () => {
  await removeItem(StorageKeys.token);
});

describe('renewTokenIfDue', () => {
  it('renews and stores a token last renewed eight days ago', async () => {
    await renewedDaysAgo(8);
    const { api, refreshToken } = client();
    const onToken = jest.fn();

    expect(await renewTokenIfDue(api, onToken, NOW)).toBe('yeni');
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(onToken).toHaveBeenCalledWith('yeni');
    expect(await getJson<string>(StorageKeys.token)).toBe('yeni');
    expect(await getJson<string>(StorageKeys.tokenRenewedAt)).toBe(NOW.toISOString());
  });

  it('leaves a token renewed yesterday alone', async () => {
    await renewedDaysAgo(1);
    const { api, refreshToken } = client();
    const onToken = jest.fn();

    expect(await renewTokenIfDue(api, onToken, NOW)).toBeNull();
    expect(refreshToken).not.toHaveBeenCalled();
    expect(onToken).not.toHaveBeenCalled();
    expect(await getJson<string>(StorageKeys.token)).toBe('eski');
  });

  it('renews when it has never renewed, and when the stamp is from the future', async () => {
    const first = client();
    expect(await renewTokenIfDue(first.api, undefined, NOW)).toBe('yeni');

    await setJson(StorageKeys.token, 'eski');
    await setJson(StorageKeys.tokenRenewedAt, new Date(NOW.getTime() + RENEW_AFTER_MS).toISOString());
    const second = client();
    expect(await renewTokenIfDue(second.api, undefined, NOW)).toBe('yeni');
  });

  it('does not sign an account back in after a logout mid-request', async () => {
    await renewedDaysAgo(8);
    const { api } = client(
      jest.fn(async () => {
        await removeItem(StorageKeys.token);
        return { token: 'yeni' };
      })
    );
    const onToken = jest.fn();

    expect(await renewTokenIfDue(api, onToken, NOW)).toBeNull();
    expect(await getJson<string>(StorageKeys.token)).toBeNull();
    expect(onToken).not.toHaveBeenCalled();
  });

  it('swallows a failure and tries again next time', async () => {
    await renewedDaysAgo(8);
    const { api } = client(
      jest.fn(async () => {
        throw new ApiError('network', 'Sunucuya ulaşamadım.', 0);
      })
    );

    await expect(renewTokenIfDue(api, undefined, NOW)).resolves.toBeNull();
    expect(await getJson<string>(StorageKeys.token)).toBe('eski');
    // the stamp did not move, so the next run is still due
    expect(await getJson<string>(StorageKeys.tokenRenewedAt)).toBe(
      new Date(NOW.getTime() - 8 * DAY_MS).toISOString()
    );
  });
});

describe('the headless background task', () => {
  it('renews a week-old token by itself and uses it for the rest of the run', async () => {
    // the task reads the real clock
    await setJson(StorageKeys.tokenRenewedAt, new Date(Date.now() - 8 * DAY_MS).toISOString());
    const fetchSpy = jest.fn(async () =>
      new Response(JSON.stringify({ token: 'yeni' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    (global as unknown as { fetch: unknown }).fetch = fetchSpy;

    await runBackgroundWork();

    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toMatch(/\/auth\/refresh$/);
    expect(await getJson<string>(StorageKeys.token)).toBe('yeni');
    expect(mockSyncStepsNow.mock.calls[0]?.[0].client.token).toBe('yeni');
  });

  it('plans the reminders again at the stored profile\'s level and zone', async () => {
    await setJson(StorageKeys.tokenRenewedAt, new Date().toISOString());
    await setJson(StorageKeys.me, { id: 'me-1', vulgarityMax: 3, timezone: 'Europe/Berlin' });

    await runBackgroundWork();

    expect(mockRefreshReminders).toHaveBeenCalledTimes(1);
    const [usedClient, level, tz] = mockRefreshReminders.mock.calls[0] ?? [];
    expect(usedClient?.token).toBe('eski');
    expect(level).toBe(3);
    expect(tz).toBe('Europe/Berlin');
  });

  it('leaves the reminders alone without a stored profile', async () => {
    await setJson(StorageKeys.tokenRenewedAt, new Date().toISOString());

    await runBackgroundWork();

    expect(mockRefreshReminders).not.toHaveBeenCalled();
    expect(mockDeliverNewInbox).toHaveBeenCalledTimes(1);
  });

  it('signs the phone out on a 401 and stops, as the app would', async () => {
    // the password changed on another phone while this one sat swiped away
    await setJson(StorageKeys.tokenRenewedAt, new Date().toISOString());
    await setJson(StorageKeys.me, { id: 'me-1', vulgarityMax: 2, timezone: 'Europe/Istanbul' });
    await setItem(StorageKeys.pushToken, 'ExponentPushToken[bu-telefon]');
    await setItem(StorageKeys.lastInboxId, 'n-9');
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () =>
      new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'Şifren değişti, bu telefondaki oturum kapandı. Yeni şifreyle gir.' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    mockSyncStepsNow.mockImplementationOnce(async ({ client }) => {
      await client.me();
    });

    await expect(runBackgroundWork()).resolves.toBeUndefined();

    expect(await getJson<string>(StorageKeys.token)).toBeNull();
    expect(await getJson<unknown>(StorageKeys.me)).toBeNull();
    expect(await getItem(StorageKeys.pushToken)).toBeNull();
    expect(await getItem(StorageKeys.lastInboxId)).toBeNull();
    // the old account's check-in alarms go with it
    expect(mockClearReminders).toHaveBeenCalledTimes(1);
    // and nothing else is tried with a dead token
    expect(mockDeliverNewInbox).not.toHaveBeenCalled();
    expect(mockRefreshReminders).not.toHaveBeenCalled();
  });

  it("keeps the session over a proxy's 401 page: it says nothing about the token", async () => {
    await setJson(StorageKeys.tokenRenewedAt, new Date().toISOString());
    await setJson(StorageKeys.me, { id: 'me-1', vulgarityMax: 2, timezone: 'Europe/Istanbul' });
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () =>
      new Response('<h1>401 Authorization Required</h1>', { status: 401, headers: { 'Content-Type': 'text/html' } })
    );
    mockSyncStepsNow.mockImplementationOnce(async ({ client }) => {
      await client.me();
    });

    await expect(runBackgroundWork()).resolves.toBeUndefined();

    expect(await getJson<string>(StorageKeys.token)).toBe('eski');
    expect(await getJson<unknown>(StorageKeys.me)).not.toBeNull();
    expect(mockClearReminders).not.toHaveBeenCalled();
    // the run goes on as it would with no signal
    expect(mockDeliverNewInbox).toHaveBeenCalledTimes(1);
  });

  it('gets through the run when the reminders cannot be planned', async () => {
    await setJson(StorageKeys.tokenRenewedAt, new Date().toISOString());
    await setJson(StorageKeys.me, { id: 'me-1', vulgarityMax: 2, timezone: 'Europe/Istanbul' });
    mockRefreshReminders.mockRejectedValueOnce(new ApiError('network', 'Sunucuya ulaşamadım.', 0));

    await expect(runBackgroundWork()).resolves.toBeUndefined();
    expect(mockSyncStepsNow).toHaveBeenCalledTimes(1);
    expect(mockDeliverNewInbox).toHaveBeenCalledTimes(1);
  });
});
