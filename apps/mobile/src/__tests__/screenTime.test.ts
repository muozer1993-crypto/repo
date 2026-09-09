/* eslint-disable import/first -- the jest.mock calls must run before the module under test */
/**
 * Screen time is the one metric the phone will not always give us, so the
 * contract is that asking is always safe: every path returns an answer, none
 * of them throw, and "not available" carries a reason the UI can explain.
 */

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
}));

// A Proxy over the real module: replacing expo-modules-core wholesale breaks
// jest-expo's own setup, which pulls requireNativeModule out of it at boot.
jest.mock('expo-modules-core', () => {
  const actual = jest.requireActual('expo-modules-core');
  const stub = jest.fn(() => null);
  return new Proxy(actual, {
    get: (target, property) =>
      property === 'requireOptionalNativeModule' ? stub : Reflect.get(target, property),
  });
});

import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

import {
  getDailyScreenMinutes,
  getScreenTimeAvailability,
  getTodayScreenMinutes,
  requestScreenTimePermission,
  resetScreenTimeProvider,
} from '@/services/screenTime';

const lookup = requireOptionalNativeModule as unknown as jest.Mock;

function provide(overrides: Record<string, unknown>) {
  lookup.mockReturnValue({
    hasPermission: jest.fn(async () => true),
    requestPermission: jest.fn(async () => true),
    dailyMinutes: jest.fn(async () => []),
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  lookup.mockReturnValue(null);
  resetScreenTimeProvider();
  (Platform as { OS: string }).OS = 'android';
});

describe('screen time', () => {
  it('says a phone with no provider needs one, rather than failing', async () => {
    expect(await getScreenTimeAvailability()).toEqual({
      available: false,
      reason: 'needs-native-module',
    });
    expect(await getDailyScreenMinutes(7)).toEqual([]);
    expect(await getTodayScreenMinutes()).toBeNull();
    expect(await requestScreenTimePermission()).toBe(false);
  });

  it('never even looks on iOS, where no app can read Screen Time', async () => {
    (Platform as { OS: string }).OS = 'ios';
    resetScreenTimeProvider();
    expect(await getScreenTimeAvailability()).toEqual({ available: false, reason: 'ios' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('reports the missing permission apart from the missing module', async () => {
    provide({ hasPermission: jest.fn(async () => false) });
    expect(await getScreenTimeAvailability()).toEqual({ available: false, reason: 'permission' });
  });

  it('is available once a provider says the permission is granted', async () => {
    provide({});
    expect(await getScreenTimeAvailability()).toEqual({ available: true, source: 'usage_stats' });
  });

  it('turns a throwing provider into a reason, not an exception', async () => {
    provide({
      hasPermission: jest.fn(async () => {
        throw new Error('usage access revoked');
      }),
    });
    const answer = await getScreenTimeAvailability();
    expect(answer.available).toBe(false);
    expect(answer).toMatchObject({ reason: 'error', detail: 'usage access revoked' });
  });

  it('cleans up whatever the native side hands back', async () => {
    provide({
      dailyMinutes: jest.fn(async () => [
        { dayKey: '2026-09-09', minutes: 312.6 },
        { dayKey: '2026-09-08', minutes: -5 },
        { dayKey: 42, minutes: 100 },
        null,
        { dayKey: '2026-09-07', minutes: Number.NaN },
      ]),
    });
    expect(await getDailyScreenMinutes(7)).toEqual([
      { dayKey: '2026-09-09', minutes: 313 },
      { dayKey: '2026-09-08', minutes: 0 },
    ]);
  });

  it('reads today off the top of the list', async () => {
    provide({ dailyMinutes: jest.fn(async () => [{ dayKey: '2026-09-09', minutes: 200 }]) });
    expect(await getTodayScreenMinutes()).toBe(200);
  });

  it('asks for at most two weeks, however much is requested', async () => {
    const dailyMinutes = jest.fn(async () => []);
    provide({ dailyMinutes });
    await getDailyScreenMinutes(365);
    expect(dailyMinutes).toHaveBeenCalledWith(14);
    await getDailyScreenMinutes(0);
    expect(dailyMinutes).toHaveBeenLastCalledWith(1);
  });

  it('looks the module up once and remembers the answer', async () => {
    provide({});
    await getScreenTimeAvailability();
    await getScreenTimeAvailability();
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
