import * as Device from 'expo-device';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

/**
 * What Android does to KOYDUM behind its back, and the two system switches
 * that stop it (Ayarlar → Arka plan, and the one-time card on the home screen).
 *
 *  - **Battery optimisation.** Without Firebase a closed phone hears "KOYDUM
 *    MU?" only through the 15-minute background check (services/background),
 *    and an optimised app is exactly the one Android defers; Xiaomi and Samsung
 *    stretch that to hours.
 *  - **Exact alarms.** The check-in reminder (services/reminders) is an alarm
 *    that expo-notifications sets exactly only when the app may schedule exact
 *    alarms. Otherwise Android is free to move it, and the 06:30 poke for a
 *    07:00 deadline can ring after 07:00.
 *
 * The native side is the local module `KoydumDevice` (modules/koydum-device),
 * looked up by name as services/screenTime does. iOS, the web and Expo Go have
 * no such module and nothing to switch, so every answer there is null / false
 * and the UI simply shows nothing.
 */

/** The shape modules/koydum-device implements. */
interface DeviceModule {
  isIgnoringBatteryOptimizations(): Promise<boolean>;
  /** Opens the system dialog (or the app list) where the exemption is given. */
  requestIgnoreBatteryOptimizations(): Promise<boolean>;
  /** Always true below Android 12, where every alarm may be exact. */
  canScheduleExactAlarms(): Promise<boolean>;
  /** Opens KOYDUM's "Alarms & reminders" page. */
  openExactAlarmSettings(): Promise<boolean>;
}

const NATIVE_MODULE_NAME = 'KoydumDevice';

let cached: DeviceModule | null | undefined;

function provider(): DeviceModule | null {
  if (cached !== undefined) return cached;
  if (Platform.OS !== 'android') {
    cached = null;
    return null;
  }
  try {
    cached = requireOptionalNativeModule<DeviceModule>(NATIVE_MODULE_NAME) ?? null;
  } catch {
    cached = null;
  }
  return cached;
}

export interface BackgroundHealth {
  /** battery optimisation is off for KOYDUM, so the background check is not held back */
  batteryUnrestricted: boolean;
  /** reminders go out as exact alarms */
  exactAlarms: boolean;
  /** MIUI / HyperOS, which stops background work with a switch of its own ("Otomatik başlatma") */
  xiaomi: boolean;
}

/** Null where there is nothing to show: iOS, the web, Expo Go, or a phone that would not say. */
export async function getBackgroundHealth(): Promise<BackgroundHealth | null> {
  const native = provider();
  if (!native) return null;
  try {
    const [battery, exact] = await Promise.all([
      native.isIgnoringBatteryOptimizations(),
      native.canScheduleExactAlarms(),
    ]);
    return { batteryUnrestricted: battery === true, exactAlarms: exact === true, xiaomi: isXiaomi() };
  } catch {
    return null;
  }
}

/** Asks Android to stop optimising KOYDUM; false when no page could be opened. */
export async function requestBatteryExemption(): Promise<boolean> {
  const native = provider();
  if (!native) return false;
  try {
    return (await native.requestIgnoreBatteryOptimizations()) === true;
  } catch {
    return false;
  }
}

/** Sends the user to the page where exact alarms are allowed; false when it would not open. */
export async function openExactAlarmSettings(): Promise<boolean> {
  const native = provider();
  if (!native) return false;
  try {
    return (await native.openExactAlarmSettings()) === true;
  } catch {
    return false;
  }
}

function isXiaomi(): boolean {
  // Redmi and POCO phones usually report Xiaomi as the manufacturer; the brand covers the rest
  return /xiaomi|redmi|poco/i.test(`${Device.manufacturer ?? ''} ${Device.brand ?? ''}`);
}

/** Test seam: forget the lookup so the next call decides again. */
export function resetDeviceHealthProvider(): void {
  cached = undefined;
}
