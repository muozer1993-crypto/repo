import { Pedometer } from 'expo-sensors';
import { Platform } from 'react-native';

import { StorageKeys, getJson, setJson } from '@/lib/storage';
import type { DailySteps, StepAvailability } from '@/services/steps';

/**
 * Step counting on device.
 *
 *  - iOS: Core Motion keeps seven days of history, so `getStepCountAsync` gives
 *    us real per-day totals even if the app was never opened.
 *  - Android: `getStepCountAsync` does not exist. We ask Health Connect for
 *    daily totals (accurate, needs a development build), and when that is not
 *    available we fall back to counting steps while the app is in the
 *    foreground and persisting the running total per day. That fallback is
 *    explicitly surfaced in the UI as "yaklaşık".
 */

export type { DailySteps, StepAvailability, StepSource } from '@/services/steps';

const HC_PERMISSIONS = [{ accessType: 'read' as const, recordType: 'Steps' as const }];

/** Local-midnight boundaries for the day that contains `date`. */
function dayBounds(date: Date): { start: Date; end: Date } {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
  return { start, end };
}

function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/* ------------------------------------------------------------------ iOS */

async function iosDailySteps(days: number): Promise<DailySteps[]> {
  const out: DailySteps[] = [];
  const now = new Date();
  // Core Motion only keeps seven days
  const limit = Math.min(days, 7);
  for (let offset = 0; offset < limit; offset += 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const { start, end } = dayBounds(day);
    const to = offset === 0 ? now : end;
    try {
      const result = await Pedometer.getStepCountAsync(start, to);
      out.push({ dayKey: localDayKey(day), steps: Math.max(0, Math.round(result.steps)), source: 'pedometer' });
    } catch {
      // a single unreadable day should not lose the others
    }
  }
  return out;
}

/* -------------------------------------------------------------- Android */

type HealthConnect = typeof import('react-native-health-connect');

let healthConnect: HealthConnect | null | undefined;

function loadHealthConnect(): HealthConnect | null {
  if (healthConnect !== undefined) return healthConnect;
  if (Platform.OS !== 'android') {
    healthConnect = null;
    return null;
  }
  try {
    // Required lazily on purpose: in Expo Go the native module is missing and a
    // top-level import would throw before the fallback can take over.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    healthConnect = require('react-native-health-connect') as HealthConnect;
  } catch {
    healthConnect = null;
  }
  return healthConnect;
}

async function healthConnectReady(): Promise<HealthConnect | null> {
  const hc = loadHealthConnect();
  if (!hc) return null;
  try {
    const status = await hc.getSdkStatus();
    if (status !== hc.SdkAvailabilityStatus.SDK_AVAILABLE) return null;
    const initialized = await hc.initialize();
    if (!initialized) return null;
    const granted = await hc.getGrantedPermissions();
    const hasSteps = granted.some(
      (p) => 'recordType' in p && p.recordType === 'Steps' && p.accessType === 'read'
    );
    return hasSteps ? hc : null;
  } catch {
    return null;
  }
}

async function healthConnectDailySteps(hc: HealthConnect, days: number): Promise<DailySteps[]> {
  const out: DailySteps[] = [];
  const now = new Date();
  for (let offset = 0; offset < days; offset += 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const { start, end } = dayBounds(day);
    try {
      const result = await hc.aggregateRecord({
        recordType: 'Steps',
        timeRangeFilter: {
          operator: 'between',
          startTime: start.toISOString(),
          endTime: (offset === 0 ? now : end).toISOString(),
        },
      });
      out.push({
        dayKey: localDayKey(day),
        steps: Math.max(0, Math.round(result.COUNT_TOTAL ?? 0)),
        source: 'health_connect',
      });
    } catch {
      // ignore this day
    }
  }
  return out;
}

/* ------------------------------------- Android foreground-only fallback */

interface StepCache {
  /** dayKey -> steps counted while the app was open */
  days: Record<string, number>;
}

async function readCache(): Promise<StepCache> {
  const cached = await getJson<StepCache>(StorageKeys.stepCache);
  if (!cached || typeof cached.days !== 'object' || cached.days === null) return { days: {} };
  return cached;
}

async function addToCache(deltas: Record<string, number>): Promise<void> {
  const cache = await readCache();
  const next = { ...cache.days };
  for (const [dayKey, delta] of Object.entries(deltas)) {
    if (delta <= 0) continue;
    next[dayKey] = (next[dayKey] ?? 0) + delta;
  }
  // keep a fortnight at most
  const keys = Object.keys(next).sort().slice(-14);
  const trimmed: Record<string, number> = {};
  for (const key of keys) trimmed[key] = next[key];
  await setJson(StorageKeys.stepCache, { days: trimmed });
}

/**
 * The Android step sensor fires roughly once per step — far faster than an
 * AsyncStorage round trip — so the deltas are accumulated in memory and written
 * behind a single chained promise. Two concurrent read-modify-writes would
 * otherwise read the same base value and silently drop most of the steps.
 */
const pendingSteps: Record<string, number> = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let cacheWrites: Promise<void> = Promise.resolve();
const STEP_FLUSH_MS = 2000;

function recordSteps(dayKey: string, delta: number): void {
  if (delta <= 0) return;
  pendingSteps[dayKey] = (pendingSteps[dayKey] ?? 0) + delta;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPendingSteps();
  }, STEP_FLUSH_MS);
}

/** Writes whatever the sensor reported since the last flush. */
function flushPendingSteps(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const batch: Record<string, number> = {};
  for (const [dayKey, delta] of Object.entries(pendingSteps)) {
    if (delta > 0) batch[dayKey] = delta;
    delete pendingSteps[dayKey];
  }
  if (Object.keys(batch).length === 0) return cacheWrites;
  cacheWrites = cacheWrites.then(() => addToCache(batch)).catch(() => {});
  return cacheWrites;
}

async function cachedDailySteps(days: number): Promise<DailySteps[]> {
  // whatever the sensor reported in the last couple of seconds counts too
  await flushPendingSteps();
  const cache = await readCache();
  const now = new Date();
  const out: DailySteps[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const key = localDayKey(day);
    const steps = cache.days[key];
    if (steps != null) out.push({ dayKey: key, steps: Math.round(steps), source: 'pedometer' });
  }
  return out;
}

/**
 * Android's step counter needs ACTIVITY_RECOGNITION from API 29 on, and asking
 * for it is on us: `Pedometer.isAvailableAsync()` only reports whether the
 * hardware exists (SensorProxy.kt: `getDefaultSensor(TYPE_STEP_COUNTER) != null`),
 * so an app that never asks subscribes happily and then counts zero forever.
 *
 * Returns true when we may read steps. Never throws; on iOS the permission is
 * handled by CoreMotion at query time.
 */
async function ensureAndroidStepPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  try {
    const existing = await Pedometer.getPermissionsAsync();
    if (existing.status === 'granted') return true;
    if (!existing.canAskAgain) return false;
    const asked = await Pedometer.requestPermissionsAsync();
    return asked.status === 'granted';
  } catch {
    // an older Android with no runtime permission at all answers here
    return true;
  }
}

/**
 * Counts steps while the app is in the foreground (Android fallback).
 * `watchStepCount` reports steps since the subscription started, so we only
 * ever store the delta.
 *
 * The permission check happens first and asynchronously, so the returned
 * unsubscribe function has to survive being called before the subscription
 * exists — hence the `stopped` flag rather than a plain null check.
 */
export function startForegroundStepTracking(): () => void {
  if (Platform.OS !== 'android') return () => {};
  let last = 0;
  let stopped = false;
  let subscription: { remove: () => void } | null = null;

  void (async () => {
    if (!(await ensureAndroidStepPermission())) return;
    if (stopped) return;
    try {
      subscription = Pedometer.watchStepCount((result) => {
        const total = Math.max(0, Math.round(result.steps));
        const delta = total - last;
        last = total;
        recordSteps(localDayKey(new Date()), delta);
      });
      if (stopped) {
        subscription.remove();
        subscription = null;
      }
    } catch {
      subscription = null;
    }
  })();

  return () => {
    stopped = true;
    try {
      subscription?.remove();
    } catch {
      // ignore
    }
    subscription = null;
    void flushPendingSteps();
  };
}

/* ----------------------------------------------------------- public API */

export async function getStepAvailability(): Promise<StepAvailability> {
  try {
    if (Platform.OS === 'ios') {
      const available = await Pedometer.isAvailableAsync();
      if (!available) return { available: false, reason: 'no-sensor' };
      const permission = await Pedometer.getPermissionsAsync();
      if (permission.status === 'denied') return { available: false, reason: 'denied' };
      return { available: true, source: 'pedometer', approximate: false };
    }

    const hc = await healthConnectReady();
    if (hc) return { available: true, source: 'health_connect', approximate: false };

    const available = await Pedometer.isAvailableAsync();
    if (!available) return { available: false, reason: 'no-sensor' };
    // the sensor existing is not the same as being allowed to read it
    const permission = await Pedometer.getPermissionsAsync();
    if (permission.status === 'denied') return { available: false, reason: 'denied' };
    return { available: true, source: 'pedometer', approximate: true };
  } catch (error) {
    return { available: false, reason: 'error', detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function requestStepPermission(): Promise<boolean> {
  try {
    if (Platform.OS === 'android') {
      const hc = loadHealthConnect();
      if (hc) {
        try {
          const status = await hc.getSdkStatus();
          if (status === hc.SdkAvailabilityStatus.SDK_AVAILABLE) {
            await hc.initialize();
            const granted = await hc.requestPermission(HC_PERMISSIONS);
            if (granted.length > 0) return true;
          }
        } catch {
          // fall through to the sensor permission
        }
      }
    }
    return await ensureAndroidStepPermission().then(async (ok) => {
      if (Platform.OS === 'android') return ok;
      const result = await Pedometer.requestPermissionsAsync();
      return result.status === 'granted';
    });
  } catch {
    return false;
  }
}

export async function getDailySteps(days: number): Promise<DailySteps[]> {
  const window = Math.max(1, Math.min(days, 14));
  try {
    if (Platform.OS === 'ios') return await iosDailySteps(window);
    const hc = await healthConnectReady();
    if (hc) {
      const fromHealthConnect = await healthConnectDailySteps(hc, window);
      if (fromHealthConnect.length > 0) return fromHealthConnect;
    }
    return await cachedDailySteps(window);
  } catch {
    return [];
  }
}

export async function getTodaySteps(): Promise<number | null> {
  const days = await getDailySteps(1);
  return days.length > 0 ? days[0].steps : null;
}

export async function openHealthConnectSettingsIfPossible(): Promise<boolean> {
  const hc = loadHealthConnect();
  if (!hc) return false;
  try {
    await hc.openHealthConnectSettings();
    return true;
  } catch {
    return false;
  }
}
