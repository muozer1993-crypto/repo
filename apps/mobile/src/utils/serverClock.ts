import { useSyncExternalStore } from 'react';

/**
 * How far the server's clock is from this phone's, learned from /health.
 *
 * The server judges everything by its own clock: a start more than 5 dk in its
 * past is refused, a check-in counts for the day and the hour IT says it is,
 * and a çelınc ends when its clock gets there. A phone 20 minutes slow could
 * never open a "Hemen" çelınc, and a server PC 3 hours off (Windows next to a
 * Linux install reads the hardware clock as local time until it resyncs) got
 * every one refused, with nobody told which clock was wrong.
 *
 * Every /health answer carries the server's `time`. It was read somewhere
 * between sending and receiving, so the midpoint of the round trip is the best
 * guess, off by half the round trip at most. A slow answer says too little to
 * be worth it: past MAX_ROUND_TRIP_MS the sample is dropped.
 */

const MAX_ROUND_TRIP_MS = 5_000;

/** Past this a card says the clocks differ; below it, the 5 dk grace still covers a "Hemen" start. */
export const CLOCK_SKEW_WARN_MS = 3 * 60_000;

/** Server minus phone, in ms; positive when the phone is behind. Null before the first usable answer. */
let offsetMs: number | null = null;
const listeners = new Set<() => void>();

export function noteServerTime(iso: string, sentAtMs: number, receivedAtMs: number): void {
  const serverMs = Date.parse(iso);
  const roundTrip = receivedAtMs - sentAtMs;
  if (!Number.isFinite(serverMs) || !(roundTrip >= 0 && roundTrip < MAX_ROUND_TRIP_MS)) return;
  const next = Math.round(serverMs - (sentAtMs + receivedAtMs) / 2);
  if (next === offsetMs) return;
  offsetMs = next;
  for (const listener of listeners) listener();
}

export function clockSkewMs(): number | null {
  return offsetMs;
}

/** What the server's clock reads now, as far as the last /health showed; the phone's own before that. */
export function serverNow(): Date {
  return new Date(Date.now() + (offsetMs ?? 0));
}

export function subscribeClockSkew(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The skew as React state, for a screen that shows it or counts with it: a
 * module variable read in render would never repaint when the next probe lands.
 */
export function useClockSkew(): number | null {
  return useSyncExternalStore(subscribeClockSkew, clockSkewMs, clockSkewMs);
}
