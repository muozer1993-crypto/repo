/* eslint-disable import/first -- the jest.mock calls must run before the module under test */
/**
 * Ayarlar → Arka plan and the home screen's battery card both ask this module
 * first, on every platform. So the contract: where there is nothing to switch
 * (iOS, the web, Expo Go) the answer is null and nothing throws; on an Android
 * build the native values come through as they are.
 */

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
}));

// A Proxy over the real module, as in screenTime.test: jest-expo's own setup
// needs the rest of expo-modules-core.
jest.mock('expo-modules-core', () => {
  const actual = jest.requireActual('expo-modules-core');
  const stub = jest.fn(() => null);
  return new Proxy(actual, {
    get: (target, property) =>
      property === 'requireOptionalNativeModule' ? stub : Reflect.get(target, property),
  });
});

const mockDevice: { manufacturer: string | null; brand: string | null } = { manufacturer: 'samsung', brand: 'samsung' };

jest.mock('expo-device', () => ({
  get manufacturer() {
    return mockDevice.manufacturer;
  },
  get brand() {
    return mockDevice.brand;
  },
}));

import { requireOptionalNativeModule } from 'expo-modules-core';
import { Linking, Platform } from 'react-native';

import {
  getBackgroundHealth,
  openAppSettings,
  openExactAlarmSettings,
  requestBatteryExemption,
  resetDeviceHealthProvider,
} from '@/services/deviceHealth';

const lookup = requireOptionalNativeModule as unknown as jest.Mock;

function provide(overrides: Record<string, unknown>) {
  const native = {
    isIgnoringBatteryOptimizations: jest.fn(async () => false),
    requestIgnoreBatteryOptimizations: jest.fn(async () => true),
    canScheduleExactAlarms: jest.fn(async () => true),
    openExactAlarmSettings: jest.fn(async () => true),
    ...overrides,
  };
  lookup.mockReturnValue(native);
  return native;
}

beforeEach(() => {
  jest.clearAllMocks();
  lookup.mockReturnValue(null);
  resetDeviceHealthProvider();
  (Platform as { OS: string }).OS = 'android';
  mockDevice.manufacturer = 'samsung';
  mockDevice.brand = 'samsung';
});

describe('background health', () => {
  it('has nothing to say without the module (Expo Go, an old APK), and opens nothing', async () => {
    expect(await getBackgroundHealth()).toBeNull();
    expect(await requestBatteryExemption()).toBe(false);
    expect(await openExactAlarmSettings()).toBe(false);
  });

  it.each(['ios', 'web'])('never even looks on %s', async (os) => {
    (Platform as { OS: string }).OS = os;
    provide({});
    expect(await getBackgroundHealth()).toBeNull();
    expect(await requestBatteryExemption()).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('passes the Android answers through as they are', async () => {
    provide({ isIgnoringBatteryOptimizations: jest.fn(async () => false), canScheduleExactAlarms: jest.fn(async () => true) });
    expect(await getBackgroundHealth()).toEqual({ batteryUnrestricted: false, exactAlarms: true, xiaomi: false });

    resetDeviceHealthProvider();
    provide({ isIgnoringBatteryOptimizations: jest.fn(async () => true), canScheduleExactAlarms: jest.fn(async () => false) });
    expect(await getBackgroundHealth()).toEqual({ batteryUnrestricted: true, exactAlarms: false, xiaomi: false });
  });

  it('knows a Xiaomi, a Redmi or a POCO has its own autostart switch', async () => {
    provide({});
    mockDevice.manufacturer = 'Xiaomi';
    expect((await getBackgroundHealth())?.xiaomi).toBe(true);
    mockDevice.manufacturer = null;
    mockDevice.brand = 'POCO';
    expect((await getBackgroundHealth())?.xiaomi).toBe(true);
    mockDevice.brand = 'Redmi';
    expect((await getBackgroundHealth())?.xiaomi).toBe(true);
  });

  it('turns a throwing module into silence, not an exception', async () => {
    provide({
      isIgnoringBatteryOptimizations: jest.fn(async () => {
        throw new Error('ReactContextLost');
      }),
      requestIgnoreBatteryOptimizations: jest.fn(async () => {
        throw new Error('ReactContextLost');
      }),
      openExactAlarmSettings: jest.fn(async () => {
        throw new Error('ReactContextLost');
      }),
    });
    expect(await getBackgroundHealth()).toBeNull();
    expect(await requestBatteryExemption()).toBe(false);
    expect(await openExactAlarmSettings()).toBe(false);
  });

  it('opens the two system pages and says whether they opened', async () => {
    const native = provide({ openExactAlarmSettings: jest.fn(async () => false) });
    expect(await requestBatteryExemption()).toBe(true);
    expect(native.requestIgnoreBatteryOptimizations).toHaveBeenCalledTimes(1);
    expect(await openExactAlarmSettings()).toBe(false);
    expect(native.openExactAlarmSettings).toHaveBeenCalledTimes(1);
  });

  it('looks the module up once and remembers the answer', async () => {
    provide({});
    await getBackgroundHealth();
    await getBackgroundHealth();
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});

describe("KOYDUM's page in the phone's settings", () => {
  let openSettings: jest.SpyInstance;

  beforeEach(() => {
    openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
  });

  afterEach(() => {
    openSettings.mockRestore();
  });

  it.each(['android', 'ios'])('opens it on %s, module or not', async (os) => {
    (Platform as { OS: string }).OS = os;
    expect(await openAppSettings()).toBe(true);
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('says false on the web, which has no such page, and when the page will not open', async () => {
    (Platform as { OS: string }).OS = 'web';
    expect(await openAppSettings()).toBe(false);
    expect(openSettings).not.toHaveBeenCalled();

    (Platform as { OS: string }).OS = 'android';
    openSettings.mockRejectedValueOnce(new Error('No Activity found to handle Intent'));
    expect(await openAppSettings()).toBe(false);
  });
});
