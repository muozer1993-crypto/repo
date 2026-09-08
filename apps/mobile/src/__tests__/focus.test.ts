import {
  GRACE_MS,
  abandon,
  createSession,
  elapsedMs,
  onBackground,
  onForeground,
  snapshot,
  tick,
} from '@/services/focus';

const T0 = 1_700_000_000_000;

describe('focus session engine', () => {
  it('accumulates elapsed time while running', () => {
    const s = createSession('c1', 25, 'sess-1', T0);
    expect(elapsedMs(s, T0 + 60_000)).toBe(60_000);
    expect(snapshot(s, T0 + 60_000).earnedMinutes).toBe(1);
  });

  it('pauses on background and resumes within the grace window', () => {
    let s = createSession('c1', 25, 'sess-1', T0);
    s = onBackground(s, T0 + 30_000);
    expect(s.status).toBe('paused');
    expect(s.accumulatedMs).toBe(30_000);
    // time spent in the background does not count
    s = onForeground(s, T0 + 30_000 + GRACE_MS - 1);
    expect(s.status).toBe('running');
    expect(elapsedMs(s, T0 + 30_000 + GRACE_MS - 1)).toBe(30_000);
  });

  it('abandons the session when the app is away past the grace window', () => {
    let s = createSession('c1', 25, 'sess-1', T0);
    s = onBackground(s, T0 + 30_000);
    s = onForeground(s, T0 + 30_000 + GRACE_MS + 1);
    expect(s.status).toBe('abandoned');
  });

  it('abandons on tick while still in the background past the grace window', () => {
    let s = createSession('c1', 25, 'sess-1', T0);
    s = onBackground(s, T0 + 10_000);
    s = tick(s, T0 + 10_000 + GRACE_MS + 500);
    expect(s.status).toBe('abandoned');
  });

  it('completes exactly at the target and caps elapsed time', () => {
    let s = createSession('c1', 15, 'sess-1', T0);
    s = tick(s, T0 + 15 * 60_000);
    expect(s.status).toBe('done');
    const snap = snapshot(s, T0 + 20 * 60_000);
    expect(snap.earnedMinutes).toBe(15);
    expect(snap.remainingMs).toBe(0);
    expect(snap.progress).toBe(1);
  });

  it('keeps partial minutes when the user gives up', () => {
    let s = createSession('c1', 60, 'sess-1', T0);
    s = abandon(s, T0 + 7 * 60_000 + 30_000);
    expect(s.status).toBe('abandoned');
    expect(snapshot(s, T0 + 10 * 60_000).earnedMinutes).toBe(7);
  });

  it('ignores foreground events when not paused', () => {
    const s = createSession('c1', 25, 'sess-1', T0);
    expect(onForeground(s, T0 + 1000)).toBe(s);
  });
});
