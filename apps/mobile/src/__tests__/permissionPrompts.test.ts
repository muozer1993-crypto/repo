/**
 * One dialog per run. The welcome slide asks for notifications and physical
 * activity with a reason; NotificationBridge, which starts as soon as the
 * slides go away, used to ask for both again right after a no there: the same
 * system dialogs, on the home screen, with nothing to say why, and on Android
 * that second no is the last one the phone allows. A tap (the slide, Ayarlar,
 * the home screen's İZİN VER) still always asks.
 *
 * Each test loads the services fresh: what they remember is per app run.
 */
jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
}));
jest.mock('expo-device', () => ({ isDevice: true })); // a real phone, not an emulator

type Answer = { status: string; canAskAgain: boolean };
const DENIED: Answer = { status: 'denied', canAskAgain: true };

const mockNotifications = {
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => null),
  AndroidImportance: { MAX: 5 },
  AndroidNotificationVisibility: { PUBLIC: 1 },
  getPermissionsAsync: jest.fn(async (): Promise<Answer> => DENIED),
  requestPermissionsAsync: jest.fn(async (): Promise<Answer> => DENIED),
};
jest.mock('@/services/expoNotifications', () => ({
  isExpoGo: () => false,
  localNotifications: () => mockNotifications,
  pushNotifications: () => null,
}));

const mockPedometer = {
  isAvailableAsync: jest.fn(async () => true),
  getPermissionsAsync: jest.fn(async (): Promise<Answer> => DENIED),
  requestPermissionsAsync: jest.fn(async (): Promise<Answer> => DENIED),
  watchStepCount: jest.fn(() => ({ remove: jest.fn() })),
  getStepCountAsync: jest.fn(async () => ({ steps: 0 })),
};
jest.mock('expo-sensors', () => ({ Pedometer: mockPedometer }));

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
});

describe('notification permission', () => {
  const load = () => require('@/services/notifications') as typeof import('@/services/notifications');

  it('is not asked again by the bridge after a no on the slide', async () => {
    const { registerForPush } = load();
    expect((await registerForPush()).reason).toBe('denied'); // the slide's "Bildirim izni"
    expect((await registerForPush({ askAgain: false })).reason).toBe('denied'); // the bridge, on home
    expect(mockNotifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);

    // Ayarlar's "Tekrar dene" is a tap: it may ask
    await registerForPush();
    expect(mockNotifications.requestPermissionsAsync).toHaveBeenCalledTimes(2);
  });

  it('is asked by the bridge once when nothing asked this run, then left alone', async () => {
    const { registerForPush } = load();
    await registerForPush({ askAgain: false });
    await registerForPush({ askAgain: false }); // back to the front
    expect(mockNotifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });
});

describe('physical activity permission', () => {
  const load = () => require('@/services/steps.native') as typeof import('@/services/steps.native');

  it('is not asked again by the bridge after a no on the slide', async () => {
    const { requestStepPermission, startForegroundStepTracking } = load();
    expect(await requestStepPermission()).toBe(false); // the slide's "Adım izni"
    const stop = startForegroundStepTracking(); // the bridge, on home
    await settle();
    stop();
    expect(mockPedometer.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(mockPedometer.watchStepCount).not.toHaveBeenCalled();

    // home's İZİN VER is a tap: it may ask
    await requestStepPermission();
    expect(mockPedometer.requestPermissionsAsync).toHaveBeenCalledTimes(2);
  });

  it('is asked by the bridge once when nothing asked this run, however often it restarts', async () => {
    const { startForegroundStepTracking } = load();
    for (let i = 0; i < 3; i++) {
      const stop = startForegroundStepTracking();
      await settle();
      stop();
    }
    expect(mockPedometer.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });
});
