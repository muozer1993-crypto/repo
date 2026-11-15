/**
 * The server judges every çelınc by its own clock, so the app has to know how
 * far that clock is from the phone's: "Hemen" is built from it, and a card
 * says when the two are minutes or hours apart.
 */

type ServerClock = typeof import('@/utils/serverClock');

/** A fresh module, with no reading from an earlier test. */
function load(): ServerClock {
  let module!: ServerClock;
  jest.isolateModules(() => {
    module = require('@/utils/serverClock') as ServerClock;
  });
  return module;
}

const SENT = Date.parse('2026-11-15T09:00:00.000Z');

describe('serverClock', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('knows nothing before the first answer, and goes by the phone until then', () => {
    const clock = load();
    jest.spyOn(Date, 'now').mockReturnValue(SENT);
    expect(clock.clockSkewMs()).toBeNull();
    expect(clock.serverNow().getTime()).toBe(SENT);
  });

  it('takes the server as having read its clock halfway through the round trip', () => {
    const clock = load();
    // sent at 09:00:00, back at 09:00:02, the server said 12:00:01: three hours ahead
    clock.noteServerTime('2026-11-15T12:00:01.000Z', SENT, SENT + 2_000);
    expect(clock.clockSkewMs()).toBe(3 * 3_600_000);

    jest.spyOn(Date, 'now').mockReturnValue(SENT + 60_000);
    expect(clock.serverNow().toISOString()).toBe('2026-11-15T12:01:00.000Z');
  });

  it('drops an answer that took 5 seconds or more, and one it cannot read', () => {
    const clock = load();
    // the server 20 minutes behind the phone
    clock.noteServerTime('2026-11-15T08:40:00.000Z', SENT, SENT + 1_000);
    const first = clock.clockSkewMs();
    expect(first).toBe(-20 * 60_000 - 500);

    clock.noteServerTime('2026-11-15T12:00:00.000Z', SENT, SENT + 5_000);
    clock.noteServerTime('2026-11-15T12:00:00.000Z', SENT, SENT + 6_000);
    clock.noteServerTime('bozuk', SENT, SENT + 100);
    // a reply received "before" it was sent: the phone's clock jumped in between
    clock.noteServerTime('2026-11-15T12:00:00.000Z', SENT, SENT - 100);
    expect(clock.clockSkewMs()).toBe(first);
  });

  it('tells a subscriber about a new reading, and only about a new one', () => {
    const clock = load();
    const listener = jest.fn();
    const unsubscribe = clock.subscribeClockSkew(listener);

    clock.noteServerTime('2026-11-15T09:00:00.500Z', SENT, SENT + 1_000);
    clock.noteServerTime('2026-11-15T09:00:00.500Z', SENT, SENT + 1_000);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    clock.noteServerTime('2026-11-15T10:00:00.000Z', SENT, SENT + 1_000);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
