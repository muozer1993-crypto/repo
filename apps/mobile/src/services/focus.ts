import { AppState, type AppStateStatus } from 'react-native';

import { StorageKeys, getJson, removeItem, setJson } from '@/lib/storage';

/**
 * The focus-session engine behind the "elini telefondan çek" challenge.
 *
 * A session runs while the app stays in the foreground. Leaving the app for
 * longer than the grace period kills it, which is the whole point: you cannot
 * scroll Instagram and collect focus minutes at the same time.
 *
 * The session is persisted so a reload (or a crash) does not silently hand out
 * free minutes: on restore we recompute elapsed time from wall-clock stamps.
 */

export const GRACE_MS = 10_000;

export type FocusStatus = 'idle' | 'running' | 'paused' | 'done' | 'abandoned';

export interface FocusSession {
  /** uuid; also the idempotency key when the entry is posted */
  sessionId: string;
  challengeId: string;
  /** target length in minutes */
  targetMinutes: number;
  startedAt: number;
  /** wall-clock ms accumulated before the current run segment */
  accumulatedMs: number;
  /** when the current segment started, null while paused */
  segmentStartedAt: number | null;
  /** set when the app went to the background, used for the grace window */
  leftAt: number | null;
  status: FocusStatus;
}

export interface FocusSnapshot {
  status: FocusStatus;
  elapsedMs: number;
  remainingMs: number;
  progress: number;
  earnedMinutes: number;
}

export function createSession(
  challengeId: string,
  targetMinutes: number,
  sessionId: string,
  now: number
): FocusSession {
  return {
    sessionId,
    challengeId,
    targetMinutes,
    startedAt: now,
    accumulatedMs: 0,
    segmentStartedAt: now,
    leftAt: null,
    status: 'running',
  };
}

export function elapsedMs(session: FocusSession, now: number): number {
  const segment = session.segmentStartedAt != null ? Math.max(0, now - session.segmentStartedAt) : 0;
  return session.accumulatedMs + segment;
}

export function snapshot(session: FocusSession, now: number): FocusSnapshot {
  const targetMs = session.targetMinutes * 60_000;
  const elapsed = Math.min(elapsedMs(session, now), targetMs);
  const remaining = Math.max(0, targetMs - elapsed);
  return {
    status: session.status,
    elapsedMs: elapsed,
    remainingMs: remaining,
    progress: targetMs > 0 ? elapsed / targetMs : 0,
    // partial sessions still count, but only whole minutes
    earnedMinutes: Math.floor(elapsed / 60_000),
  };
}

/** The app went to the background: start the grace clock. */
export function onBackground(session: FocusSession, now: number): FocusSession {
  if (session.status !== 'running') return session;
  return {
    ...session,
    accumulatedMs: elapsedMs(session, now),
    segmentStartedAt: null,
    leftAt: now,
    status: 'paused',
  };
}

/** The app came back. Within the grace window the session survives. */
export function onForeground(session: FocusSession, now: number): FocusSession {
  if (session.status !== 'paused') return session;
  const away = session.leftAt != null ? now - session.leftAt : 0;
  if (away > GRACE_MS) {
    return { ...session, leftAt: null, status: 'abandoned' };
  }
  return { ...session, leftAt: null, segmentStartedAt: now, status: 'running' };
}

/** Called on every tick; flips to `done` once the target is reached. */
export function tick(session: FocusSession, now: number): FocusSession {
  if (session.status === 'paused' && session.leftAt != null && now - session.leftAt > GRACE_MS) {
    return { ...session, status: 'abandoned' };
  }
  if (session.status !== 'running') return session;
  if (elapsedMs(session, now) >= session.targetMinutes * 60_000) {
    return {
      ...session,
      accumulatedMs: session.targetMinutes * 60_000,
      segmentStartedAt: null,
      status: 'done',
    };
  }
  return session;
}

/** User pressed "vazgeç". */
export function abandon(session: FocusSession, now: number): FocusSession {
  return {
    ...session,
    accumulatedMs: elapsedMs(session, now),
    segmentStartedAt: null,
    status: 'abandoned',
  };
}

export async function saveSession(session: FocusSession | null): Promise<void> {
  if (!session) {
    await removeItem(StorageKeys.focusSession);
    return;
  }
  await setJson(StorageKeys.focusSession, session);
}

export async function loadSession(now: number): Promise<FocusSession | null> {
  const stored = await getJson<FocusSession>(StorageKeys.focusSession);
  if (!stored || typeof stored.sessionId !== 'string') return null;
  // a session that was left running while the app was killed cannot be trusted
  if (stored.status === 'running' && stored.segmentStartedAt != null) {
    return { ...stored, accumulatedMs: stored.accumulatedMs, segmentStartedAt: null, status: 'abandoned', leftAt: null };
  }
  if (stored.status === 'paused') {
    return onForeground(stored, now);
  }
  return stored;
}

/** Subscribe to foreground/background transitions; returns an unsubscribe function. */
export function watchAppState(handler: (state: AppStateStatus) => void): () => void {
  const sub = AppState.addEventListener('change', handler);
  return () => sub.remove();
}

export const FOCUS_PRESETS = [15, 25, 45, 60] as const;
