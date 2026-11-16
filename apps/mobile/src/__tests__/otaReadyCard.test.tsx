/**
 * "Güncelleme hazır": the home card that brings an over-the-air fix in without
 * waiting for a cold start. It looks again whenever the app comes back to the
 * front (once per half hour), offers "Yenile" once a download is in, and never
 * restarts the app by itself.
 */
import { AppState, Platform, type AppStateStatus } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { OtaReadyCard } from '@/components/OtaReadyCard';

/** What the installed expo-updates says; each test sets it up. */
const mockUpdates = {
  enabled: true,
  pending: false,
  check: jest.fn(async (): Promise<{ isAvailable: boolean }> => ({ isAvailable: false })),
  fetch: jest.fn(async () => ({ isNew: true })),
  reload: jest.fn(async () => {}),
};

jest.mock('expo-updates', () => ({
  __esModule: true,
  get isEnabled() {
    return mockUpdates.enabled;
  },
  useUpdates: () => ({ isUpdatePending: mockUpdates.pending }),
  checkForUpdateAsync: () => mockUpdates.check(),
  fetchUpdateAsync: () => mockUpdates.fetch(),
  reloadAsync: () => mockUpdates.reload(),
}));

const mockLevel: { value: 1 | 2 | 3 } = { value: 2 };

jest.mock('@/store/auth', () => ({
  useLevel: () => mockLevel.value,
}));

const MINUTE = 60 * 1000;
const globals = globalThis as unknown as { __DEV__: boolean };
const realDev = globals.__DEV__;

/**
 * The half-hour throttle lives in the module for the whole run, as on a phone;
 * every test starts its clock two hours after the last one so it begins fresh.
 */
let clock = Date.parse('2026-11-16T09:00:00.000Z');
let appStateListeners: ((state: AppStateStatus) => void)[];
let mounted: ReactTestRenderer[];

beforeEach(() => {
  clock += 120 * MINUTE;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  // a release build: a debug one rejects every call, so the card stays away there
  globals.__DEV__ = false;
  mockUpdates.enabled = true;
  mockUpdates.pending = false;
  mockUpdates.check.mockReset().mockResolvedValue({ isAvailable: false });
  mockUpdates.fetch.mockReset().mockResolvedValue({ isNew: true });
  mockUpdates.reload.mockReset().mockResolvedValue(undefined);
  mockLevel.value = 2;
  mounted = [];
  appStateListeners = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((type, listener) => {
    if (type === 'change') appStateListeners.push(listener as (state: AppStateStatus) => void);
    return { remove: () => {} } as ReturnType<typeof AppState.addEventListener>;
  });
});

afterEach(() => {
  for (const tree of mounted.splice(0)) {
    act(() => {
      tree.unmount();
    });
  }
  globals.__DEV__ = realDev;
  jest.restoreAllMocks();
});

function render(): ReactTestRenderer {
  let tree: ReactTestRenderer;
  act(() => {
    tree = create(<OtaReadyCard />);
  });
  mounted.push(tree!);
  return tree!;
}

/** Every string drawn on screen. */
function texts(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAll((node) => typeof node.props.children === 'string')
    .map((node) => node.props.children as string);
}

function button(tree: ReactTestRenderer, title: string): ReactTestInstance {
  return tree.root.find((node) => typeof node.type !== 'string' && node.props.title === title);
}

/** The app comes back to the front (or goes away), and every promise it started settles. */
async function appBecomes(state: AppStateStatus): Promise<void> {
  await act(async () => {
    for (const listener of appStateListeners) listener(state);
    await new Promise((resolve) => setImmediate(resolve));
  });
}

describe('OtaReadyCard', () => {
  it('shows nothing and looks for nothing on web, in a debug build or with updates switched off', async () => {
    mockUpdates.pending = true;
    const os = jest.replaceProperty(Platform, 'OS', 'web');
    const web = render();
    expect(web.toJSON()).toBeNull();
    os.restore();

    globals.__DEV__ = true;
    expect(render().toJSON()).toBeNull();
    globals.__DEV__ = false;

    mockUpdates.enabled = false;
    expect(render().toJSON()).toBeNull();

    await appBecomes('active');
    expect(appStateListeners).toHaveLength(0);
    expect(mockUpdates.check).not.toHaveBeenCalled();
  });

  it('shows nothing while no download is waiting', () => {
    expect(render().toJSON()).toBeNull();
  });

  it('offers "Yenile" once a download is in, and restarts only on the tap', async () => {
    mockUpdates.pending = true;
    const tree = render();
    expect(texts(tree)).toContain('Güncelleme hazır, bir yenile');

    // coming back to the front never restarts the app under the friend
    await appBecomes('active');
    expect(mockUpdates.reload).not.toHaveBeenCalled();

    act(() => {
      button(tree, 'Yenile').props.onPress();
    });
    expect(mockUpdates.reload).toHaveBeenCalledTimes(1);
  });

  it('words the title for the reader’s level', () => {
    mockUpdates.pending = true;
    mockLevel.value = 1;
    expect(texts(render())).toContain('Güncelleme hazır');
    mockLevel.value = 3;
    expect(texts(render())).toContain('Eski sürümle gezme, yenile 🍆');
  });

  it('goes away on "Sonra"', () => {
    mockUpdates.pending = true;
    const tree = render();
    act(() => {
      button(tree, 'Sonra').props.onPress();
    });
    expect(tree.toJSON()).toBeNull();
    expect(mockUpdates.reload).not.toHaveBeenCalled();
  });

  it('survives a refused restart', async () => {
    mockUpdates.pending = true;
    mockUpdates.reload.mockRejectedValue(new Error('ERR_UPDATES_RELOAD'));
    const tree = render();
    await act(async () => {
      button(tree, 'Yenile').props.onPress();
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(texts(tree)).toContain('Güncelleme hazır, bir yenile');
  });

  it('looks once per half hour of returns to the front, not on mount or going away', async () => {
    render();
    // the cold start already looked on its own
    expect(mockUpdates.check).not.toHaveBeenCalled();

    await appBecomes('background');
    expect(mockUpdates.check).not.toHaveBeenCalled();

    await appBecomes('active');
    expect(mockUpdates.check).toHaveBeenCalledTimes(1);

    clock += 29 * MINUTE;
    await appBecomes('active');
    expect(mockUpdates.check).toHaveBeenCalledTimes(1);

    clock += 2 * MINUTE;
    await appBecomes('active');
    expect(mockUpdates.check).toHaveBeenCalledTimes(2);
  });

  it('keeps the half hour across a home screen mounted again', async () => {
    render();
    await appBecomes('active');
    expect(mockUpdates.check).toHaveBeenCalledTimes(1);

    act(() => {
      mounted.shift()!.unmount();
    });
    appStateListeners = [];
    render();
    clock += 5 * MINUTE;
    await appBecomes('active');
    expect(mockUpdates.check).toHaveBeenCalledTimes(1);
  });

  it('downloads only when the server has something', async () => {
    render();
    await appBecomes('active');
    expect(mockUpdates.check).toHaveBeenCalledTimes(1);
    expect(mockUpdates.fetch).not.toHaveBeenCalled();

    mockUpdates.check.mockResolvedValue({ isAvailable: true });
    clock += 31 * MINUTE;
    await appBecomes('active');
    expect(mockUpdates.fetch).toHaveBeenCalledTimes(1);
  });

  it('swallows a failed check and tries again on the next return', async () => {
    const tree = render();
    mockUpdates.check.mockRejectedValueOnce(new Error('Network request failed'));
    await appBecomes('active');
    expect(mockUpdates.check).toHaveBeenCalledTimes(1);
    expect(tree.toJSON()).toBeNull();

    // offline a minute ago does not hold the next look back for half an hour
    clock += 1 * MINUTE;
    mockUpdates.check.mockResolvedValueOnce({ isAvailable: true });
    mockUpdates.fetch.mockRejectedValueOnce(new Error('Network request failed'));
    await appBecomes('active');
    expect(mockUpdates.check).toHaveBeenCalledTimes(2);
    expect(mockUpdates.fetch).toHaveBeenCalledTimes(1);

    clock += 1 * MINUTE;
    await appBecomes('active');
    expect(mockUpdates.check).toHaveBeenCalledTimes(3);
  });
});
