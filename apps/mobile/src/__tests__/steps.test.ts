/* eslint-disable import/first -- the jest.mock calls must run before the module under test */
/**
 * Android hands out its step counter behind ACTIVITY_RECOGNITION, and
 * `Pedometer.isAvailableAsync()` answers a different question — whether the
 * hardware exists. An app that subscribes without asking counts zero forever
 * and looks broken rather than blocked, so the asking is what these cover.
 */

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
}));

// The factory has to own these: `@/services/steps.native` is imported eagerly
// below, so anything declared out here is still uninitialised when jest calls it.
jest.mock('expo-sensors', () => ({
  Pedometer: {
    isAvailableAsync: jest.fn(async () => true),
    getPermissionsAsync: jest.fn(async () => ({ status: 'granted', canAskAgain: true })),
    requestPermissionsAsync: jest.fn(async () => ({ status: 'granted', canAskAgain: true })),
    watchStepCount: jest.fn(() => ({ remove: jest.fn() })),
    getStepCountAsync: jest.fn(async () => ({ steps: 0 })),
  },
}));

import { Pedometer } from 'expo-sensors';

import { getStepAvailability, startForegroundStepTracking } from '@/services/steps.native';

/** Lets the tracker's async permission dance settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type PermissionAnswer = { status: string; canAskAgain: boolean };
const pedometer = Pedometer as unknown as {
  isAvailableAsync: jest.Mock<Promise<boolean>, []>;
  getPermissionsAsync: jest.Mock<Promise<PermissionAnswer>, []>;
  requestPermissionsAsync: jest.Mock<Promise<PermissionAnswer>, []>;
  watchStepCount: jest.Mock<{ remove: jest.Mock }, [unknown]>;
};

/** The subscription handed back by the last watchStepCount call, if any. */
function lastSubscription(): { remove: jest.Mock } | undefined {
  return pedometer.watchStepCount.mock.results.at(-1)?.value;
}

beforeEach(() => {
  jest.clearAllMocks();
  pedometer.isAvailableAsync.mockResolvedValue(true);
  pedometer.getPermissionsAsync.mockResolvedValue({ status: 'granted', canAskAgain: true });
  pedometer.requestPermissionsAsync.mockResolvedValue({ status: 'granted', canAskAgain: true });
  pedometer.watchStepCount.mockImplementation(() => ({ remove: jest.fn() }));
});

describe('Android step tracking', () => {
  it('asks for the permission before it subscribes', async () => {
    pedometer.getPermissionsAsync.mockResolvedValue({ status: 'undetermined', canAskAgain: true });
    const stop = startForegroundStepTracking();
    await settle();

    expect(pedometer.requestPermissionsAsync).toHaveBeenCalled();
    expect(pedometer.watchStepCount).toHaveBeenCalled();
    stop();
  });

  it('does not subscribe when the permission is refused for good', async () => {
    pedometer.getPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: false });
    const stop = startForegroundStepTracking();
    await settle();

    expect(pedometer.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(pedometer.watchStepCount).not.toHaveBeenCalled();
    stop();
  });

  it('subscribes straight away when it already has the permission', async () => {
    const stop = startForegroundStepTracking();
    await settle();

    expect(pedometer.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(pedometer.watchStepCount).toHaveBeenCalledTimes(1);
    const subscription = lastSubscription();
    stop();
    expect(subscription?.remove).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes even when it is stopped before the permission comes back', async () => {
    const stop = startForegroundStepTracking();
    stop(); // the screen unmounted while the dialog was still up
    await settle();

    // either it never subscribed, or it subscribed and immediately let go
    const released =
      pedometer.watchStepCount.mock.calls.length === 0 ||
      (lastSubscription()?.remove.mock.calls.length ?? 0) === 1;
    expect(released).toBe(true);
  });

  it('reports a refused permission instead of pretending the sensor works', async () => {
    pedometer.getPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: false });
    expect(await getStepAvailability()).toEqual({ available: false, reason: 'denied' });
  });

  it('reports the foreground counter as approximate once it is allowed', async () => {
    expect(await getStepAvailability()).toEqual({
      available: true,
      source: 'pedometer',
      approximate: true,
    });
  });
});
