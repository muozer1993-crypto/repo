import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

import { StorageKeys, getJson, setJson } from '@/lib/storage';

/**
 * Android steps recorded by Google Play services while KOYDUM is closed.
 *
 * Health Connect needs a separate app the user has to set up; without it the
 * app used to count only while it was open, because since Android 9 a
 * background app gets no step-sensor events at all. The Recording API is Play
 * services itself counting on the phone, always on, keeping ten days — the
 * Android twin of iOS Core Motion. The local module `KoydumSteps`
 * (modules/koydum-steps) is looked up by NAME, so Expo Go, iOS and the web get
 * a clean "not here" instead of a crash.
 *
 * Recording starts at the first successful `subscribe()`; days before it have
 * no data, which is why steps.native.ts still takes the larger of this and
 * what the app counted in the foreground.
 */
interface StepsModule {
  status(): Promise<string>;
  subscribe(): Promise<boolean>;
  dailySteps(days: number): Promise<{ dayKey: string; steps: number }[]>;
}

export type RecordingStatus = 'ok' | 'no-permission' | 'play-services' | 'unsupported' | 'needs-native-module';

const MODULE_NAME = 'KoydumSteps';

let cached: StepsModule | null | undefined;
let subscribed = false;

function provider(): StepsModule | null {
  if (cached !== undefined) return cached;
  if (Platform.OS !== 'android') {
    cached = null;
    return null;
  }
  try {
    cached = requireOptionalNativeModule<StepsModule>(MODULE_NAME) ?? null;
  } catch {
    cached = null;
  }
  return cached;
}

export async function recordingStatus(): Promise<RecordingStatus> {
  const native = provider();
  if (!native) return 'needs-native-module';
  try {
    const status = await native.status();
    return status === 'ok' || status === 'no-permission' || status === 'play-services' || status === 'unsupported'
      ? status
      : 'unsupported';
  } catch {
    return 'unsupported';
  }
}

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Starts recording once per app run; true when the phone is recording steps.
 * The first success on this install is remembered by day: recording has no data
 * before it, so earlier days are never taken from it (see recordingSince).
 */
export async function ensureRecording(): Promise<boolean> {
  if (subscribed) return true;
  const native = provider();
  if (!native) return false;
  if ((await recordingStatus()) !== 'ok') return false;
  try {
    subscribed = (await native.subscribe()) === true;
  } catch {
    subscribed = false;
  }
  if (subscribed) {
    try {
      if (!(await recordingSince())) await setJson(StorageKeys.stepRecordingSince, localDayKey(new Date()));
    } catch {
      // storage trouble only costs the guard below, not the recording
    }
  }
  return subscribed;
}

/** The local day recording started on this install, or null. */
export async function recordingSince(): Promise<string | null> {
  const stored = await getJson<string>(StorageKeys.stepRecordingSince);
  return typeof stored === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(stored) ? stored : null;
}

/** True on the day recording started: part of that day was walked before it. */
export async function recordingStartedToday(now: Date = new Date()): Promise<boolean> {
  return (await recordingSince()) === localDayKey(now);
}

/**
 * Daily totals, newest first; empty when the phone cannot answer. Never throws.
 *
 * Days before recording started on this install are dropped: the phone has no
 * data for them, and a 0 synced for a past day would overwrite what an earlier
 * install (or another source) already reported.
 */
export async function recordedDailySteps(days: number): Promise<{ dayKey: string; steps: number }[]> {
  const native = provider();
  if (!native) return [];
  const window = Math.max(1, Math.min(days, 10));
  try {
    const since = await recordingSince();
    if (!since) return [];
    const rows = await native.dailySteps(window);
    if (!Array.isArray(rows)) return [];
    return rows
      .filter(
        (row): row is { dayKey: string; steps: number } =>
          !!row && typeof row.dayKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.dayKey) && Number.isFinite(row.steps)
      )
      .filter((row) => row.dayKey >= since)
      .map((row) => ({ dayKey: row.dayKey, steps: Math.max(0, Math.round(row.steps)) }));
  } catch {
    return [];
  }
}

/** Test seam. */
export function resetRecordingProvider(): void {
  cached = undefined;
  subscribed = false;
}
