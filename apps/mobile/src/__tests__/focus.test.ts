import {
  GRACE_MS,
  abandon,
  createSession,
  elapsedMs,
  finishEarly,
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

  it('ends a running session early on whole minutes when the çelınc is about to end', () => {
    const s = finishEarly(createSession('c1', 45, 'sess-1', T0), T0 + 20 * 60_000 + 40_000);
    expect(s.status).toBe('done');
    expect(s.targetMinutes).toBe(20);
    expect(s.segmentStartedAt).toBeNull();
    // the done screen's number and what gets posted agree, however long it is shown
    const snap = snapshot(s, T0 + 60 * 60_000);
    expect(snap.earnedMinutes).toBe(20);
    expect(snap.remainingMs).toBe(0);
  });

  it('ends a paused session early on what it had before the app left', () => {
    let s = createSession('c1', 45, 'sess-1', T0);
    s = onBackground(s, T0 + 12 * 60_000 + 5_000);
    s = finishEarly(s, T0 + 12 * 60_000 + 9_000);
    expect(s.status).toBe('done');
    expect(s.leftAt).toBeNull();
    expect(s.targetMinutes).toBe(12);
    expect(snapshot(s, T0 + 13 * 60_000).earnedMinutes).toBe(12);
  });

  it('leaves idle, done and abandoned sessions alone when ending early', () => {
    const running = createSession('c1', 25, 'sess-1', T0);
    const idle = { ...running, status: 'idle' as const, segmentStartedAt: null };
    expect(finishEarly(idle, T0 + 60_000)).toBe(idle);
    const abandoned = abandon(running, T0 + 5 * 60_000);
    expect(finishEarly(abandoned, T0 + 6 * 60_000)).toBe(abandoned);
    const done = tick(running, T0 + 25 * 60_000);
    expect(finishEarly(done, T0 + 26 * 60_000)).toBe(done);
  });
});
