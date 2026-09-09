import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

/**
 * Screen time, read from the phone rather than typed in — where the platform
 * allows it at all.
 *
 * The honest position, because the çelınc depends on it:
 *
 *  - **iOS: impossible.** Screen Time lives behind Apple's Family Controls /
 *    DeviceActivity framework. That needs an entitlement Apple grants to
 *    parental-control apps, and even with it the numbers stay inside a sandboxed
 *    extension that is designed NOT to hand raw usage back to the app, let alone
 *    to a server. No third-party app can read your Screen Time. This is Apple's
 *    design, not a gap in Expo.
 *  - **Android: possible, with a real build.** `UsageStatsManager` gives daily
 *    foreground time once the user grants PACKAGE_USAGE_STATS from system
 *    settings. It needs a native module, so it never works in Expo Go.
 *
 * So the app asks for the number, and uses the device only to fill it in when it
 * honestly can. `available: false` is the normal answer, not an error, and the
 * reason is what the UI shows the user.
 *
 * The native side is looked up by NAME through `requireOptionalNativeModule`,
 * which returns null instead of throwing when nothing provides it. That keeps
 * the seam free of a package dependency: no Metro resolution to satisfy, no
 * third-party native code in the build, and the day a `KoydumScreenTime` module
 * is added this file starts using it with no other change.
 */

/** The shape a provider has to implement to light this up. */
interface ScreenTimeModule {
  hasPermission(): Promise<boolean>;
  /** Opens the system screen where the user grants usage access. */
  requestPermission(): Promise<boolean>;
  /** Foreground minutes per day, newest first, `days` entries at most. */
  dailyMinutes(days: number): Promise<{ dayKey: string; minutes: number }[]>;
}

const NATIVE_MODULE_NAME = 'KoydumScreenTime';

let cached: ScreenTimeModule | null | undefined;

function provider(): ScreenTimeModule | null {
  if (cached !== undefined) return cached;
  if (Platform.OS !== 'android') {
    cached = null;
    return null;
  }
  try {
    cached = requireOptionalNativeModule<ScreenTimeModule>(NATIVE_MODULE_NAME) ?? null;
  } catch {
    cached = null;
  }
  return cached;
}

export type ScreenTimeAvailability =
  | { available: true; source: 'usage_stats' }
  | {
      available: false;
      reason: 'ios' | 'web' | 'needs-native-module' | 'permission' | 'error';
      detail?: string;
    };

export async function getScreenTimeAvailability(): Promise<ScreenTimeAvailability> {
  if (Platform.OS === 'web') return { available: false, reason: 'web' };
  if (Platform.OS === 'ios') return { available: false, reason: 'ios' };

  const native = provider();
  if (!native) return { available: false, reason: 'needs-native-module' };

  try {
    const granted = await native.hasPermission();
    return granted ? { available: true, source: 'usage_stats' } : { available: false, reason: 'permission' };
  } catch (error) {
    return {
      available: false,
      reason: 'error',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Sends the user to the system page where usage access is granted. */
export async function requestScreenTimePermission(): Promise<boolean> {
  const native = provider();
  if (!native) return false;
  try {
    return await native.requestPermission();
  } catch {
    return false;
  }
}

export interface DailyScreenTime {
  /** YYYY-MM-DD in the device's local timezone */
  dayKey: string;
  minutes: number;
}

/**
 * Daily foreground minutes, or an empty list when this phone cannot answer —
 * in which case the entry screen falls back to asking the user.
 */
export async function getDailyScreenMinutes(days: number): Promise<DailyScreenTime[]> {
  const native = provider();
  if (!native) return [];
  const window = Math.max(1, Math.min(days, 14));
  try {
    const rows = await native.dailyMinutes(window);
    if (!Array.isArray(rows)) return [];
    return rows
      .filter(
        (row): row is DailyScreenTime =>
          !!row && typeof row.dayKey === 'string' && Number.isFinite(row.minutes)
      )
      .map((row) => ({ dayKey: row.dayKey, minutes: Math.max(0, Math.round(row.minutes)) }));
  } catch {
    return [];
  }
}

/** Today's foreground minutes, or null when the phone will not say. */
export async function getTodayScreenMinutes(): Promise<number | null> {
  const days = await getDailyScreenMinutes(1);
  return days.length > 0 ? days[0].minutes : null;
}

/** Test seam: forget the lookup so the next call decides again. */
export function resetScreenTimeProvider(): void {
  cached = undefined;
}
