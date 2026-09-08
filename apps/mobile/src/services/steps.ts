/**
 * Step counting — web / default implementation.
 *
 * The real work happens in `steps.native.ts`, which Metro picks on device.
 * Keeping this file as the TypeScript entry point means every caller sees the
 * same signatures on every platform.
 */

export type StepSource = 'pedometer' | 'health_connect';

export interface DailySteps {
  /** YYYY-MM-DD in the device's local timezone */
  dayKey: string;
  steps: number;
  source: StepSource;
}

export type StepAvailability =
  | { available: true; source: StepSource; /** Android foreground-only counting */ approximate: boolean }
  | { available: false; reason: 'web' | 'no-sensor' | 'denied' | 'health-connect-missing' | 'error'; detail?: string };

export async function getStepAvailability(): Promise<StepAvailability> {
  return { available: false, reason: 'web' };
}

export async function requestStepPermission(): Promise<boolean> {
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function getDailySteps(_days: number): Promise<DailySteps[]> {
  return [];
}

export async function getTodaySteps(): Promise<number | null> {
  return null;
}

/** Android-only: opens the Health Connect app so the user can grant access. */
export async function openHealthConnectSettingsIfPossible(): Promise<boolean> {
  return false;
}

/** Starts the Android foreground step accumulator; a no-op elsewhere. */
export function startForegroundStepTracking(): () => void {
  return () => {};
}
