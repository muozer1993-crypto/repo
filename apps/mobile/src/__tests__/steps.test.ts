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

// Health Connect starts out missing, as on most phones before Android 14; the
// tests that need it switch it on.
jest.mock('react-native-health-connect', () => ({
  SdkAvailabilityStatus: { SDK_UNAVAILABLE: 1, SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED: 2, SDK_AVAILABLE: 3 },
  getSdkStatus: jest.fn(async () => 1),
  initialize: jest.fn(async () => true),
  getGrantedPermissions: jest.fn(async () => []),
  requestPermission: jest.fn(async () => []),
  aggregateRecord: jest.fn(async () => ({ COUNT_TOTAL: 0, dataOrigins: [] })),
  openHealthConnectSettings: jest.fn(),
}));

// The APK's own version, which decides whether Health Connect may be asked to
// read in the background (1.1.0 runs the same JS without the permission).
jest.mock('expo-application', () => ({ __esModule: true, nativeApplicationVersion: '1.1.1' }));

import * as Application from 'expo-application';
import { Pedometer } from 'expo-sensors';
import * as HealthConnect from 'react-native-health-connect';

import {
  getStepAvailability,
  healthConnectBackgroundMissing,
  requestHealthConnectBackground,
  requestStepPermission,
  startForegroundStepTracking,
} from '@/services/steps.native';

/** Lets the tracker's async permission dance settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type PermissionAnswer = { status: string; canAskAgain: boolean };
const pedometer = Pedometer as unknown as {
  isAvailableAsync: jest.Mock<Promise<boolean>, []>;
  getPermissionsAsync: jest.Mock<Promise<PermissionAnswer>, []>;
  requestPermissionsAsync: jest.Mock<Promise<PermissionAnswer>, []>;
  watchStepCount: jest.Mock<{ remove: jest.Mock }, [unknown]>;
};

type Aggregate = { COUNT_TOTAL: number; dataOrigins: string[] };
const STEPS_READ = [{ recordType: 'Steps', accessType: 'read' }];
const healthConnect = HealthConnect as unknown as {
  getSdkStatus: jest.Mock<Promise<number>, []>;
  getGrantedPermissions: jest.Mock<Promise<typeof STEPS_READ>, []>;
  requestPermission: jest.Mock<Promise<typeof STEPS_READ>, [unknown]>;
  aggregateRecord: jest.Mock<Promise<Aggregate>, [unknown]>;
};
const application = Application as unknown as { nativeApplicationVersion: string | null };

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
  healthConnect.getSdkStatus.mockResolvedValue(1);
  healthConnect.getGrantedPermissions.mockResolvedValue([]);
  healthConnect.requestPermission.mockResolvedValue([]);
  healthConnect.aggregateRecord.mockResolvedValue({ COUNT_TOTAL: 0, dataOrigins: [] });
  application.nativeApplicationVersion = '1.1.1';
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

/* ------------------------------------------------ Play services recording */

describe('Android steps recorded while the app is closed', () => {
  const core = require('expo-modules-core') as { requireOptionalNativeModule: (name: string) => unknown };
  const recording = require('@/services/recordingSteps') as typeof import('@/services/recordingSteps');
  const steps = require('@/services/steps.native') as typeof import('@/services/steps.native');
  const original = core.requireOptionalNativeModule;
  const AsyncStorage = require('@react-native-async-storage/async-storage');

  function withModule(module: unknown) {
    core.requireOptionalNativeModule = (name: string) => (name === 'KoydumSteps' ? module : original(name));
    recording.resetRecordingProvider();
  }

  afterEach(async () => {
    core.requireOptionalNativeModule = original;
    recording.resetRecordingProvider();
    await AsyncStorage.removeItem('koydum.stepRecordingSince');
  });

  /** Recording that has been running on this phone since last week. */
  const recordingSinceLastWeek = () => AsyncStorage.setItem('koydum.stepRecordingSince', JSON.stringify('2020-01-01'));

  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  it('uses the recording, not the foreground count, and says it is not approximate', async () => {
    await recordingSinceLastWeek();
    const subscribe = jest.fn(async () => true);
    withModule({
      status: jest.fn(async () => 'ok'),
      subscribe,
      dailySteps: jest.fn(async () => [{ dayKey: today(), steps: 8123 }]),
    });
    expect(await steps.getStepAvailability()).toEqual({ available: true, source: 'pedometer', approximate: false });
    expect(subscribe).toHaveBeenCalledTimes(1);
    const days = await steps.getDailySteps(1);
    expect(days).toEqual([{ dayKey: today(), steps: 8123, source: 'pedometer' }]);
  });

  it('keeps the larger of recording and foreground count per day, never the sum', async () => {
    await recordingSinceLastWeek();
    await AsyncStorage.setItem('koydum.stepCache', JSON.stringify({ days: { [today()]: 5000 } }));
    withModule({
      status: jest.fn(async () => 'ok'),
      subscribe: jest.fn(async () => true),
      // recording began this afternoon: it saw less than the app did this morning
      dailySteps: jest.fn(async () => [{ dayKey: today(), steps: 1200 }]),
    });
    expect((await steps.getDailySteps(1))[0]).toEqual({ dayKey: today(), steps: 5000, source: 'pedometer' });
    await AsyncStorage.removeItem('koydum.stepCache');
  });

  it('falls back to the foreground count, and names the fix, when Play services is too old', async () => {
    withModule({
      status: jest.fn(async () => 'play-services'),
      subscribe: jest.fn(async () => true),
      dailySteps: jest.fn(async () => []),
    });
    expect(await steps.getStepAvailability()).toEqual({
      available: true,
      source: 'pedometer',
      approximate: true,
      upgrade: 'play-services',
    });
  });

  it('stays approximate, with Beyan et, on the day recording starts', async () => {
    withModule({
      status: jest.fn(async () => 'ok'),
      subscribe: jest.fn(async () => true),
      dailySteps: jest.fn(async () => [{ dayKey: today(), steps: 300 }]),
    });
    expect(await steps.getStepAvailability()).toEqual({ available: true, source: 'pedometer', approximate: true });
    expect(await recording.recordingSince()).toBe(today());
  });

  it('never reports a day from before recording started, so a reinstall cannot sync zeros over real days', async () => {
    const yesterday = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    withModule({
      status: jest.fn(async () => 'ok'),
      subscribe: jest.fn(async () => true),
      // an older module build that zero-fills the whole window
      dailySteps: jest.fn(async () => [
        { dayKey: today(), steps: 150 },
        { dayKey: yesterday, steps: 0 },
      ]),
    });
    await recording.ensureRecording();
    const days = await steps.getDailySteps(7);
    expect(days.map((d) => d.dayKey)).toEqual([today()]);
  });

  it('never trusts a malformed row from the module', async () => {
    await recordingSinceLastWeek();
    withModule({
      status: jest.fn(async () => 'ok'),
      subscribe: jest.fn(async () => true),
      dailySteps: jest.fn(async () => [{ dayKey: 'yesterday', steps: 5 }, { dayKey: today(), steps: Number.NaN }, null]),
    });
    expect(await recording.recordedDailySteps(3)).toEqual([]);
  });

  it('merges newest first and trims to the window', () => {
    const merged = steps.mergeLarger(
      2,
      [
        { dayKey: '2026-09-27', steps: 100 },
        { dayKey: '2026-09-26', steps: 900 },
      ],
      [
        { dayKey: '2026-09-27', steps: 400, source: 'pedometer' },
        { dayKey: '2026-09-25', steps: 50, source: 'pedometer' },
      ]
    );
    expect(merged).toEqual([
      { dayKey: '2026-09-27', steps: 400, source: 'pedometer' },
      { dayKey: '2026-09-26', steps: 900, source: 'pedometer' },
    ]);
  });

  it('names Health Connect only for the days it had the most', () => {
    const merged = steps.mergeLarger(
      7,
      [
        { dayKey: '2026-09-27', steps: 3000, source: 'health_connect' },
        { dayKey: '2026-09-26', steps: 9000, source: 'health_connect' },
      ],
      [
        { dayKey: '2026-09-27', steps: 7000 },
        { dayKey: '2026-09-26', steps: 9000 },
      ]
    );
    expect(merged).toEqual([
      { dayKey: '2026-09-27', steps: 7000, source: 'pedometer' },
      { dayKey: '2026-09-26', steps: 9000, source: 'health_connect' },
    ]);
  });

  /*
   * expo-sensors lets go of the sensor while the app is off screen and keeps
   * its baseline, so the first event after a night left in recents carries the
   * whole night. Put on the morning, Monday's 6.000 came back as Tuesday's too,
   * beat the Recording API's 500 and stayed on the server for good.
   */
  describe('the foreground count after a night in the background', () => {
    const MONDAY = '2026-11-16';
    const TUESDAY = '2026-11-17';
    const at = (day: 16 | 17, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute);

    let stopTracking: (() => void) | undefined;

    beforeEach(() => {
      // only the clock: settle() and the counter's flush still run on real timers
      jest.useFakeTimers({
        doNotFake: [
          'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
          'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval',
          'clearInterval', 'setTimeout', 'clearTimeout',
        ],
      });
    });

    afterEach(async () => {
      stopTracking?.();
      stopTracking = undefined;
      await settle();
      await AsyncStorage.removeItem('koydum.stepCache');
      jest.useRealTimers();
    });

    /** Starts the counter at `time` and hands back the sensor's callback. */
    async function trackFrom(time: Date): Promise<(steps: number) => void> {
      jest.setSystemTime(time);
      stopTracking = startForegroundStepTracking();
      await settle();
      const callback = pedometer.watchStepCount.mock.calls.at(-1)?.[0] as (result: { steps: number }) => void;
      return (steps) => callback({ steps });
    }

    function recordingSays(rows: { dayKey: string; steps: number }[]) {
      withModule({
        status: jest.fn(async () => 'ok'),
        subscribe: jest.fn(async () => true),
        dailySteps: jest.fn(async () => rows),
      });
    }

    it("keeps last evening's count off the morning the app comes back", async () => {
      await recordingSinceLastWeek();
      recordingSays([
        { dayKey: TUESDAY, steps: 500 },
        { dayKey: MONDAY, steps: 6000 },
      ]);
      const sensor = await trackFrom(at(16, 23, 50));
      sensor(1);
      jest.setSystemTime(at(17, 8, 10));
      sensor(6501);

      expect(await steps.getDailySteps(2)).toEqual([
        { dayKey: TUESDAY, steps: 500, source: 'pedometer' },
        { dayKey: MONDAY, steps: 6000, source: 'pedometer' },
      ]);
    });

    it('drops the jump even when no step came before the app was put away', async () => {
      await recordingSinceLastWeek();
      recordingSays([{ dayKey: TUESDAY, steps: 500 }]);
      const sensor = await trackFrom(at(16, 18));
      jest.setSystemTime(at(17, 8, 10));
      sensor(6500);

      expect((await steps.getDailySteps(2))[0]).toEqual({ dayKey: TUESDAY, steps: 500, source: 'pedometer' });
    });

    it('counts again right after the dropped jump on a phone with nothing else to count', async () => {
      // Play services too old to record: this counter is all the phone has
      withModule({
        status: jest.fn(async () => 'play-services'),
        subscribe: jest.fn(async () => false),
        dailySteps: jest.fn(async () => []),
      });
      const sensor = await trackFrom(at(16, 18));
      jest.setSystemTime(at(17, 8, 10));
      sensor(6500);
      jest.setSystemTime(at(17, 8, 20));
      sensor(6700);

      expect(await steps.getDailySteps(2)).toEqual([{ dayKey: TUESDAY, steps: 200, source: 'pedometer' }]);
    });

    it('keeps a jump within the same day: those steps were walked that day', async () => {
      await recordingSinceLastWeek();
      recordingSays([{ dayKey: MONDAY, steps: 1200 }]);
      const sensor = await trackFrom(at(16, 10));
      sensor(1);
      jest.setSystemTime(at(16, 18));
      sensor(3000);

      expect(await steps.getDailySteps(1)).toEqual([{ dayKey: MONDAY, steps: 3000, source: 'pedometer' }]);
    });
  });

  /*
   * Android 14+ ships Health Connect, so İZİN VER grants it on phones where
   * nothing writes steps into it. It used to win outright there: 0 adım every
   * day, shown as exact, no Beyan et, and the phone's own count never started.
   */
  describe('Health Connect present but empty', () => {
    beforeEach(() => {
      healthConnect.getSdkStatus.mockResolvedValue(3);
      healthConnect.getGrantedPermissions.mockResolvedValue(STEPS_READ);
      healthConnect.requestPermission.mockResolvedValue(STEPS_READ);
      healthConnect.aggregateRecord.mockResolvedValue({ COUNT_TOTAL: 0, dataOrigins: [] });
    });

    const recordingToday = (stepsToday: number, subscribe = jest.fn(async () => true)) =>
      withModule({
        status: jest.fn(async () => 'ok'),
        subscribe,
        dailySteps: jest.fn(async () => [{ dayKey: today(), steps: stepsToday }]),
      });

    it("counts the phone's own steps instead of Health Connect's zeros", async () => {
      await recordingSinceLastWeek();
      recordingToday(11000);
      expect(await steps.getDailySteps(1)).toEqual([{ dayKey: today(), steps: 11000, source: 'pedometer' }]);
    });

    it('never sends a 0 just because Health Connect answered one', async () => {
      withModule({
        status: jest.fn(async () => 'no-permission'),
        subscribe: jest.fn(async () => false),
        dailySteps: jest.fn(async () => []),
      });
      expect(await steps.getDailySteps(7)).toEqual([]);
    });

    it('reports the phone as the source and says Health Connect is empty', async () => {
      await recordingSinceLastWeek();
      recordingToday(11000);
      expect(await steps.getStepAvailability()).toEqual({
        available: true,
        source: 'pedometer',
        approximate: false,
        hcEmpty: true,
      });
    });

    it('keeps Beyan et on the first day, when recording has only just started', async () => {
      recordingToday(300);
      expect(await steps.getStepAvailability()).toEqual({
        available: true,
        source: 'pedometer',
        approximate: true,
        hcEmpty: true,
      });
    });

    it('asks for physical activity after the Health Connect yes and starts recording', async () => {
      pedometer.getPermissionsAsync.mockResolvedValue({ status: 'undetermined', canAskAgain: true });
      const subscribe = jest.fn(async () => true);
      recordingToday(0, subscribe);
      expect(await steps.requestStepPermission()).toBe(true);
      expect(healthConnect.requestPermission).toHaveBeenCalledTimes(1);
      expect(pedometer.requestPermissionsAsync).toHaveBeenCalledTimes(1);
      expect(subscribe).toHaveBeenCalledTimes(1);
    });

    it('answers no when only the empty Health Connect was allowed, so the caller shows the way to settings', async () => {
      pedometer.getPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: true });
      pedometer.requestPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: false });
      // without physical activity Play services records nothing either
      withModule({
        status: jest.fn(async () => 'no-permission'),
        subscribe: jest.fn(async () => false),
        dailySteps: jest.fn(async () => []),
      });
      expect(await steps.requestStepPermission()).toBe(false);
      expect(healthConnect.requestPermission).toHaveBeenCalledTimes(1);
      expect(await steps.getStepAvailability()).toMatchObject({ available: false, reason: 'denied' });

      // a Health Connect something writes into counts on its own
      healthConnect.aggregateRecord.mockResolvedValue({ COUNT_TOTAL: 8000, dataOrigins: ['com.sec.android.app.shealth'] });
      expect(await steps.requestStepPermission()).toBe(true);
    });

    it('still takes Health Connect when something writes into it and it has the larger day', async () => {
      await recordingSinceLastWeek();
      healthConnect.aggregateRecord.mockResolvedValue({ COUNT_TOTAL: 8000, dataOrigins: ['com.sec.android.app.shealth'] });
      recordingToday(6000);
      expect(await steps.getDailySteps(1)).toEqual([{ dayKey: today(), steps: 8000, source: 'health_connect' }]);
      expect(await steps.getStepAvailability()).toEqual({
        available: true,
        source: 'health_connect',
        approximate: false,
      });
    });
  });
});

/*
 * Health Connect answers a closed app only with READ_HEALTH_DATA_IN_BACKGROUND,
 * so the 15-minute task read nothing from it: a watch's evening run reached the
 * çelınc only once KOYDUM was opened, sometimes after the deadline.
 */
describe('Health Connect read while the app is closed', () => {
  const BACKGROUND_READ = [{ recordType: 'BackgroundAccessPermission', accessType: 'read' }];

  beforeEach(() => {
    // a watch writes into it, and every dialog says yes
    healthConnect.getSdkStatus.mockResolvedValue(3);
    healthConnect.getGrantedPermissions.mockResolvedValue(STEPS_READ);
    healthConnect.requestPermission.mockImplementation(async (asked) => asked as typeof STEPS_READ);
    healthConnect.aggregateRecord.mockResolvedValue({ COUNT_TOTAL: 8000, dataOrigins: ['com.google.android.apps.fitness'] });
  });

  it('asks for it in a request of its own, after the Steps one', async () => {
    expect(await requestStepPermission()).toBe(true);
    expect(healthConnect.requestPermission.mock.calls).toEqual([[STEPS_READ], [BACKGROUND_READ]]);
  });

  it('keeps the Steps yes when Health Connect throws at the background request', async () => {
    // no physical activity either: the answer rests on Health Connect alone
    pedometer.getPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: false });
    healthConnect.requestPermission
      .mockResolvedValueOnce(STEPS_READ)
      .mockRejectedValueOnce(new Error('Unsupported permission'));
    expect(await requestStepPermission()).toBe(true);
    expect(healthConnect.requestPermission).toHaveBeenCalledTimes(2);
  });

  it('asks only for Steps on a 1.1.0 APK, whose manifest lacks the permission', async () => {
    application.nativeApplicationVersion = '1.1.0';
    expect(await requestStepPermission()).toBe(true);
    expect(healthConnect.requestPermission.mock.calls).toEqual([[STEPS_READ]]);
  });

  it('spares an empty Health Connect the extra dialog', async () => {
    healthConnect.aggregateRecord.mockResolvedValue({ COUNT_TOTAL: 0, dataOrigins: [] });
    await requestStepPermission();
    expect(healthConnect.requestPermission.mock.calls).toEqual([[STEPS_READ]]);
  });

  it('is missing while Health Connect is read for steps alone', async () => {
    expect(await healthConnectBackgroundMissing()).toBe(true);
    healthConnect.getGrantedPermissions.mockResolvedValue([...STEPS_READ, ...BACKGROUND_READ]);
    expect(await healthConnectBackgroundMissing()).toBe(false);
  });

  it('is never missing where it cannot be granted: a 1.1.0 APK, or no Steps grant to go with it', async () => {
    application.nativeApplicationVersion = '1.1.0';
    expect(await healthConnectBackgroundMissing()).toBe(false);
    application.nativeApplicationVersion = null;
    expect(await healthConnectBackgroundMissing()).toBe(false);
    application.nativeApplicationVersion = '1.1.1';
    healthConnect.getGrantedPermissions.mockResolvedValue([]);
    expect(await healthConnectBackgroundMissing()).toBe(false);
  });

  it('asks for the background read alone from Ayarlar and says whether it was granted', async () => {
    expect(await requestHealthConnectBackground()).toBe(true);
    expect(healthConnect.requestPermission.mock.calls).toEqual([[BACKGROUND_READ]]);

    healthConnect.requestPermission.mockResolvedValue([]);
    expect(await requestHealthConnectBackground()).toBe(false);
    application.nativeApplicationVersion = '1.1.0';
    expect(await requestHealthConnectBackground()).toBe(false);
    expect(healthConnect.requestPermission).toHaveBeenCalledTimes(2);
  });
});
