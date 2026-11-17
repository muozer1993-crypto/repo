import type { Entry, Me, ParticipantView } from '@koydum/shared';
import { LIMITS, addDays, todayKey } from '@koydum/shared';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { RefreshControl, ScrollView, StyleSheet, TextInput } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '@/components/Toast';
import { PULL_FLUSH_WAIT_MS } from '@/hooks/usePullRefresh';
import { ApiClient, ApiError } from '@/lib/api';
import { clearPendingInvite, readPendingInvite, savePendingInvite } from '@/services/invite';
import type { ScreenTimeAvailability } from '@/services/screenTime';
import { Colors, Spacing } from '@/theme';

/**
 * Every list screen has to survive the three states the server actually
 * produces: an empty list, a failed request, and a deep link whose route param
 * never arrived. A throw in any of them is a blank app, so they get rendered
 * here rather than trusted.
 */

/* ------------------------------------------------------------------ mocks */

const searchParams: { id?: string; with?: string; show?: string; day?: string; invite?: string } = {};

/** The last focus effect a screen handed over; nothing navigates here, so tests run it by hand. */
const mockFocus: { effect?: () => void } = {};

jest.mock('expo-router', () => ({
  router: {
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    navigate: jest.fn(),
    canGoBack: () => false,
    canDismiss: jest.fn(() => false),
    dismissAll: jest.fn(),
    dismissTo: jest.fn(),
  },
  useLocalSearchParams: () => searchParams,
  useFocusEffect: (effect: () => void) => {
    mockFocus.effect = effect;
  },
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

/** What the focus screen last asked of usePreventRemove (the real one needs a navigator). */
const mockPreventRemove: { prevent?: boolean } = {};

jest.mock('expo-router/react-navigation', () => ({
  usePreventRemove: (prevent: boolean) => {
    mockPreventRemove.prevent = prevent;
  },
  // no navigator here: a Sheet then counts its screen as always in front
  NavigationContext: require('react').createContext(undefined),
}));

const api: Record<string, jest.Mock> = {};

jest.mock('@/hooks/useApi', () => ({
  useApi: () => api,
}));

const ME: Me = {
  id: 'me-1',
  username: 'mustafa',
  displayName: 'Mustafa',
  avatarEmoji: '🔥',
  createdAt: '2026-09-01T00:00:00.000Z',
  vulgarityMax: 2,
  // a zone the runtime cannot resolve: the screens must not throw on it
  timezone: 'Mars/Olympus',
  reminderHour: null,
  nudgesEnabled: true,
  recapEnabled: true,
  inviteCode: 'KOY123',
  hasPushToken: false,
  stats: {
    wins: 0, losses: 0, ties: 0, tauntsSent: 0, tauntsReceived: 0,
    stepsSingleDayMax: 0, focusTotalMinutes: 0, checkinsStreakMax: 0,
    disputesWon: 0, challengesPlayed: 0, pokesSent: 0, revengeWins: 0, stepsToday: 0,
  },
  badges: [],
};

/** the profile as /me reads it again; null is what a failed read gives */
const mockRefreshMe = jest.fn(async (): Promise<Me | null> => null);

/** what a 401 leaves behind for the login screen (see store/auth) */
const mockSession = { ended: false, reason: null as string | null };
const mockClearSessionEnded = jest.fn(() => {
  mockSession.ended = false;
  mockSession.reason = null;
});
const mockSetSession = jest.fn(async () => {});
/** the ApiClient the auth screens build from the store */
const mockLogin = jest.fn(async (_body: { username: string; password: string }) => ({
  token: 'token',
  me: { ...ME, timezone: 'Europe/Istanbul' },
}));
/** a sign-up through the same client; each test says what the server answers */
const mockRegister = jest.fn(async (_body: { username: string; password: string }) => ({
  token: 'token',
  me: { ...ME, timezone: 'Europe/Istanbul' },
}));
const mockSetMe = jest.fn(async () => {});
/** the address the screens see; a fresh install sits on the localhost fallback */
const mockServer = { url: 'http://localhost:4000' };
const mockSetServerUrl = jest.fn(async (url: string) => {
  mockServer.url = url;
});
/** the reader's level, as useLevel answers it; 2 unless a test reads as somebody else */
const mockLevel: { value: 1 | 2 | 3 } = { value: 2 };

jest.mock('@/store/auth', () => ({
  useAuth: (selector: (state: unknown) => unknown) =>
    selector({
      me: ME,
      token: 'token',
      serverUrl: mockServer.url,
      setServerUrl: mockSetServerUrl,
      refreshMe: mockRefreshMe,
      setSession: mockSetSession,
      setMe: mockSetMe,
      client: () => ({ login: mockLogin, register: mockRegister }),
      rememberServerId: jest.fn(async () => {}),
      sessionEnded: mockSession.ended,
      sessionEndReason: mockSession.reason,
      clearSessionEnded: mockClearSessionEnded,
      onboarding: false,
      setOnboarding: jest.fn(),
    }),
  useLevel: () => mockLevel.value,
  deviceTimezone: () => 'Europe/Istanbul',
}));

jest.mock('@/services/steps', () => ({
  getDailySteps: jest.fn(async () => []),
  getTodaySteps: jest.fn(async () => 0),
  getStepAvailability: jest.fn(async () => ({ available: false, reason: 'web' })),
  requestStepPermission: jest.fn(async () => false),
  healthConnectBackgroundMissing: jest.fn(async () => false),
  requestHealthConnectBackground: jest.fn(async () => false),
  openHealthConnectSettingsIfPossible: jest.fn(async () => false),
  startForegroundStepTracking: () => () => {},
}));

/** What the phone says about the notification permission, read without asking (home's card). */
const mockNotifPermission: { status: 'granted' | 'denied' | 'undetermined' | 'unknown' } = { status: 'granted' };

// Ayarlar asks for push on mount; the real module would load expo-notifications
jest.mock('@/services/notifications', () => ({
  registerForPush: jest.fn(async () => ({ token: null, reason: 'web' })),
  pushPermissionStatus: async () => mockNotifPermission.status,
  pushTokenNeedsSending: (deviceToken: string, hasPushToken: boolean | undefined) =>
    jest.requireActual('@/services/notifications').pushTokenNeedsSending(deviceToken, hasPushToken),
}));

/** The phone's own deadline alerts, as Ayarlar sees them (services/reminders has its own test). */
const mockReminders = {
  enabled: true,
  set: jest.fn(async (on: boolean) => {
    mockReminders.enabled = on;
  }),
  refresh: jest.fn(async (..._args: unknown[]) => 0),
  skipToday: jest.fn(async (_challengeId: string, _tz: string) => {}),
};

jest.mock('@/services/reminders', () => ({
  deviceRemindersEnabled: async () => mockReminders.enabled,
  setDeviceRemindersEnabled: (on: boolean) => mockReminders.set(on),
  refreshReminders: (...args: unknown[]) => mockReminders.refresh(...args),
  skipTodayCheckinReminder: (challengeId: string, tz: string) => mockReminders.skipToday(challengeId, tz),
  clearReminders: async () => {},
}));

/** Android's battery and alarm switches (services/deviceHealth has its own test); null = not Android. */
const mockDeviceHealth: {
  state: { batteryUnrestricted: boolean; exactAlarms: boolean; xiaomi: boolean } | null;
  requestBattery: jest.Mock;
  openAlarms: jest.Mock;
  /** KOYDUM's page in the phone's settings (deviceHealth.test checks it really is Linking.openSettings) */
  openSettings: jest.Mock;
} = {
  state: null,
  requestBattery: jest.fn(async () => true),
  openAlarms: jest.fn(async () => true),
  openSettings: jest.fn(async () => true),
};

jest.mock('@/services/deviceHealth', () => ({
  getBackgroundHealth: async () => (mockDeviceHealth.state ? { ...mockDeviceHealth.state } : null),
  requestBatteryExemption: () => mockDeviceHealth.requestBattery(),
  openExactAlarmSettings: () => mockDeviceHealth.openAlarms(),
  openAppSettings: () => mockDeviceHealth.openSettings(),
}));

/**
 * What the phone says about usage access (services/screenTime has its own
 * test); null leaves the answer to the real service, which on this platform
 * has no module to ask. The rest of the service stays real, so the Android
 * version check is the one the screens run.
 */
const mockScreenTime: { availability: ScreenTimeAvailability | null } = { availability: null };

jest.mock('@/services/screenTime', () => {
  const actual = jest.requireActual('@/services/screenTime') as typeof import('@/services/screenTime');
  return {
    ...actual,
    getScreenTimeAvailability: async () => mockScreenTime.availability ?? actual.getScreenTimeAvailability(),
  };
});

/** The photo the picker hands back, from the camera or the gallery alike (its cache file on a phone). */
const mockPickedPhoto: { uri: string; fileSize?: number } = {
  uri: 'file:///data/user/0/com.koydum.app/cache/ImagePicker/kanit-1.jpeg',
};

jest.mock('expo-image-picker', () => {
  const picked = async () => ({
    canceled: false,
    assets: [
      { uri: mockPickedPhoto.uri, fileName: 'kanit-1.jpeg', width: 1200, height: 900, fileSize: mockPickedPhoto.fileSize },
    ],
  });
  return {
    requestCameraPermissionsAsync: async () => ({ granted: true }),
    requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
    launchCameraAsync: picked,
    launchImageLibraryAsync: picked,
  };
});

/* ------------------------------------------------------------------ setup */

const SAFE_AREA = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/** Mounted trees and their clients, torn down after each test so no refetch timer survives. */
const mounted: { tree: ReactTestRenderer; client: QueryClient }[] = [];

function renderScreen(element: ReactElement): ReactTestRenderer {
  const client = new QueryClient({
    defaultOptions: {
      // a test must not wait on retry backoff, and nothing here should poll
      queries: { retry: false, gcTime: 0, refetchInterval: false, refetchOnWindowFocus: false },
      // a finished mutation otherwise sits in the cache on a five-minute timer
      // that keeps jest from exiting
      mutations: { retry: false, gcTime: 0 },
    },
  });
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <SafeAreaProvider initialMetrics={SAFE_AREA}>
        <QueryClientProvider client={client}>
          <ToastProvider>{element}</ToastProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    );
  });
  mounted.push({ tree, client });
  return tree;
}

/** The query client a mounted screen was rendered with. */
function clientOf(tree: ReactTestRenderer): QueryClient {
  const entry = mounted.find((candidate) => candidate.tree === tree);
  if (!entry) throw new Error('screen not mounted');
  return entry.client;
}

afterEach(() => {
  delete mockFocus.effect;
  for (const { tree, client } of mounted.splice(0)) {
    act(() => {
      tree.unmount();
    });
    client.clear();
    client.unmount();
  }
});

/** Lets the query settle so the screen renders its resolved state, not the skeleton. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    // each pass drains one macrotask worth of promise chains
     
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function textIn(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(textIn);
  if (node && typeof node === 'object' && 'children' in node) {
    return textIn((node as { children: unknown }).children);
  }
  return [];
}

function rendered(tree: ReactTestRenderer): string {
  return textIn(tree.toJSON()).join(' ');
}

const NETWORK_ERROR = new ApiError('network', 'Sunucuya ulaşamadım.', 0);

beforeEach(() => {
  mockServer.url = 'http://localhost:4000';
  mockLevel.value = 2;
  mockDeviceHealth.state = null;
  mockNotifPermission.status = 'granted';
  delete searchParams.id;
  delete searchParams.with;
  delete searchParams.show;
  delete searchParams.day;
  delete searchParams.invite;
  for (const key of Object.keys(api)) delete api[key];
  Object.assign(api, {
    challenges: jest.fn(async () => []),
    challenge: jest.fn(async () => { throw new ApiError('not_found', 'Bulunamadı.', 404); }),
    results: jest.fn(async () => { throw new ApiError('not_found', 'Bulunamadı.', 404); }),
    inbox: jest.fn(async () => []),
    unreadCount: jest.fn(async () => ({ count: 0, latestId: null })),
    friends: jest.fn(async () => ({ friends: [], incoming: [], outgoing: [] })),
    leaderboard: jest.fn(async () => []),
    userProfile: jest.fn(async () => { throw new ApiError('not_found', 'Bulunamadı.', 404); }),
    searchUsers: jest.fn(async () => []),
    blockedUsers: jest.fn(async () => []),
    syncSteps: jest.fn(async () => ({ updated: 0 })),
  });
});

/* ------------------------------------------------------------------ tests */

describe('empty lists', () => {
  it('home shows the empty state instead of a blank screen', async () => {
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const tree = renderScreen(<HomeScreen />);
    await settle();
    expect(rendered(tree)).toContain('KOYDUM');
    expect(api.challenges).toHaveBeenCalled();
  });

  it('inbox shows the empty state', async () => {
    const InboxScreen = require('@/app/(app)/(tabs)/inbox').default;
    const tree = renderScreen(<InboxScreen />);
    await settle();
    expect(rendered(tree)).toContain('Gelen Kutusu');
  });

  it('inbox draws the Sunday recap as a card, and survives a malformed one', async () => {
    api.inbox = jest.fn(async () => [
      {
        id: 'recap-1',
        type: 'recap',
        title: '📊 Haftanın hesabı',
        body: 'Bu hafta 2 kere koydun, 1 kere yedin.',
        data: {
          weekKey: '2026-01-11',
          weekStart: '2026-01-05',
          weekEnd: '2026-01-11',
          wins: 2,
          losses: 1,
          ties: 0,
          steps: 22200,
          active: 1,
          highlights: ['👑 Haftanın kralı sensin. Kankalar sana çalışsın.'],
        },
        readAt: null,
        createdAt: new Date().toISOString(),
      },
      {
        id: 'recap-0',
        type: 'recap',
        title: '📊 Eski özet',
        body: 'Eski sunucudan gelen düz metin.',
        data: { wins: 'iki' },
        readAt: new Date().toISOString(),
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      },
    ]);
    const InboxScreen = require('@/app/(app)/(tabs)/inbox').default;
    const tree = renderScreen(<InboxScreen />);
    await settle();
    const text = rendered(tree);
    expect(text).toContain('5 – 11 Ocak');
    expect(text).toContain('KOYDUN');
    expect(text).toContain('YEDİN'); // Turkish capitals, not "YEDIN"
    expect(text).toContain('22.200');
    expect(text).toContain('Haftanın kralı sensin');
    expect(text).toContain('çelınc hâlâ sürüyor');
    // the malformed one falls back to the plain row with its body
    expect(text).toContain('Eski sunucudan gelen düz metin.');
  });

  it('friends shows the empty state and the invite code', async () => {
    const FriendsScreen = require('@/app/(app)/(tabs)/friends').default;
    const tree = renderScreen(<FriendsScreen />);
    await settle();
    const text = rendered(tree);
    expect(text).toContain('Kankalar');
    expect(text).toContain('KOY123');
  });
});

describe('API errors', () => {
  it('home renders a retry card when the list fails', async () => {
    api.challenges = jest.fn(async () => {
      throw NETWORK_ERROR;
    });
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const tree = renderScreen(<HomeScreen />);
    await settle();
    expect(rendered(tree)).toContain('TEKRAR DENE');
  });

  it('inbox renders the error state when the fetch fails', async () => {
    api.inbox = jest.fn(async () => {
      throw NETWORK_ERROR;
    });
    const InboxScreen = require('@/app/(app)/(tabs)/inbox').default;
    const tree = renderScreen(<InboxScreen />);
    await settle();
    expect(rendered(tree)).toContain('Sunucuya ulaşamadım');
  });

  it('friends renders the error card when the fetch fails', async () => {
    api.friends = jest.fn(async () => {
      throw NETWORK_ERROR;
    });
    const FriendsScreen = require('@/app/(app)/(tabs)/friends').default;
    const tree = renderScreen(<FriendsScreen />);
    await settle();
    expect(rendered(tree)).toContain('TEKRAR DENE');
  });
});

describe('missing route params', () => {
  it('the challenge screen says so instead of spinning forever', async () => {
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();
    expect(rendered(tree)).toContain('Çelınc bulunamadı');
    // the query must never have been started for an empty id
    expect(api.challenge).not.toHaveBeenCalled();
  });

  it('the results screen says so instead of spinning forever', async () => {
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();
    expect(rendered(tree)).toContain('Çelınc bulunamadı');
    expect(api.results).not.toHaveBeenCalled();
  });

  it('the user screen says so instead of spinning forever', async () => {
    const UserScreen = require('@/app/(app)/user/[id]').default;
    const tree = renderScreen(<UserScreen />);
    await settle();
    expect(rendered(tree)).toContain('Profil bulunamadı');
    expect(api.userProfile).not.toHaveBeenCalled();
  });

  it('a real id still reaches the API and renders the 404 state', async () => {
    searchParams.id = 'c-1';
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();
    expect(api.challenge).toHaveBeenCalledWith('c-1');
    expect(rendered(tree)).toContain('Bu çelınc sende yok');
  });
});

/** A live challenge that scores days, so the day-key maths actually runs. */
function challengeDetail() {
  const player = {
    user: { id: 'me-1', username: 'mustafa', displayName: 'Mustafa', avatarEmoji: '🔥', createdAt: '2026-09-01T00:00:00.000Z' },
    status: 'accepted' as const,
    score: 12430,
    days: 2,
    rank: 1,
    lastEntryAt: '2026-09-08T09:00:00.000Z',
    isWinner: false,
  };
  return {
    challenge: {
      id: 'c-1',
      creatorId: 'me-1',
      typeKey: 'adim_yarisi',
      metricType: 'auto_steps' as const,
      direction: 'higher' as const,
      unit: 'adım',
      title: 'Haftalık Adım',
      startsAt: '2026-09-07T00:00:00.000Z',
      // still running whenever the suite runs; the settling tests move it back
      endsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      status: 'active' as const,
      rewardText: 'Kaybeden kahve ısmarlar',
      penaltyText: null,
      deadlineTime: null,
      dailyTarget: null,
      proofRequired: false,
      createdAt: '2026-09-07T00:00:00.000Z',
      finalizedAt: null,
      winnerId: null,
      isTie: false,
      rematchOfId: null,
    },
    participants: [player],
    me: player,
    unreadTaunts: 0,
    myEntries: [],
    feed: [],
    disputes: [],
    taunts: [],
    canTaunt: [],
    canPoke: true,
  };
}

describe('unusable server data', () => {
  it('renders an active challenge even when the account timezone is nonsense', async () => {
    // ME.timezone is 'Mars/Olympus'; todayKey() throws on it, which used to
    // take the whole screen down mid-render
    searchParams.id = 'c-1';
    const detail = challengeDetail();
    api.challenge = jest.fn(async () => detail);

    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Haftalık Adım');
    expect(text).toContain('Kaybeden kahve ısmarlar');
  });

  it('renders an active challenge even when the dates are malformed', async () => {
    searchParams.id = 'c-1';
    const detail = challengeDetail();
    detail.challenge.startsAt = 'not-a-date';
    detail.challenge.endsAt = 'not-a-date-either';
    api.challenge = jest.fn(async () => detail);

    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    expect(rendered(tree)).toContain('Haftalık Adım');
  });
});

describe('standings verdict', () => {
  function withRival(score: number, rank: number) {
    const detail = challengeDetail();
    detail.participants = [
      detail.me!,
      {
        user: { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' },
        status: 'accepted' as const,
        score,
        days: 2,
        rank,
        lastEntryAt: '2026-09-08T09:00:00.000Z',
        isWinner: false,
      },
    ];
    return detail;
  }

  it('calls a shared first place "başa baş", never "öndesin"', async () => {
    // both on 12.430 with rank 1: the server shares the rank on equal scores
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => withRival(12430, 1));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Başa baş');
    expect(text).not.toContain('Aferin lan koçum');
  });

  it('says "aferin" only when the lead is real', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => withRival(4201, 2));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Aferin lan koçum');
    expect(text).not.toContain('Başa baş');
  });
});

describe('the "laf sok" note in a group çelınc', () => {
  /** Mustafa (the reader), Ali and Veli at these scores and ranks; the reader may poke whoever is listed. */
  function threeWay(me: [number, number], ali: [number, number], veli: [number, number], targets: string[]) {
    const detail = challengeDetail();
    const rival = (id: string, username: string, displayName: string, [score, rank]: [number, number]) => ({
      user: { id, username, displayName, avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' },
      status: 'accepted' as const,
      score,
      days: 2,
      rank,
      lastEntryAt: '2026-09-08T09:00:00.000Z',
      isWinner: false,
    });
    const mine = { ...detail.me, score: me[0], rank: me[1] };
    return {
      ...detail,
      me: mine,
      participants: [rival('u-2', 'ali', 'Ali', ali), mine, rival('u-3', 'veli', 'Veli', veli)],
      pokeTargets: targets.map((toUserId) => ({ toUserId, done: false })),
    };
  }

  async function noteFor(detail: ReturnType<typeof threeWay>) {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => detail);
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();
    return rendered(tree);
  }

  it('tells the one in the middle whom they are ahead of, not "öndesin"', async () => {
    // second of three: behind Ali, ahead of Veli, so Veli is the only one on the list
    const text = await noteFor(threeWay([12430, 2], [15000, 1], [4201, 3], ['u-3']));
    expect(text).toContain('Geridesin');
    // one name under it: "bunun", not "bunların"
    expect(text).toContain('Bunun önündesin, laf sokma hakkı sende.');
    expect(text).toContain('Veli');
    expect(text).not.toContain('Öndesin');
    expect(text).not.toContain('Bunların');
  });

  it('says "bunların" when there is more than one name under it', async () => {
    // second of four: behind Ali, ahead of Veli and Can
    const four = threeWay([12430, 2], [15000, 1], [4201, 3], ['u-3', 'u-4']);
    const veli = four.participants[2]!;
    four.participants.push({ ...veli, user: { ...veli.user, id: 'u-4', username: 'can', displayName: 'Can' }, score: 3000, rank: 4 });
    let text = await noteFor(four);
    expect(text).toContain('Bunların önündesin, laf sokma hakkı sende.');
    expect(text).not.toContain('Öndesin');

    mockLevel.value = 1;
    text = await noteFor(four);
    expect(text).toContain('Aşağıdakilerin önündesin, onlara bir mesaj gönderebilirsin.');

    mockLevel.value = 3;
    text = await noteFor(four);
    expect(text).toContain('Bunlara koyuyorsun. Laf sokma hakkı senin 🍆');
  });

  it('says it at every level', async () => {
    const middle = threeWay([12430, 2], [15000, 1], [4201, 3], ['u-3']);
    mockLevel.value = 1;
    let text = await noteFor(middle);
    expect(text).toContain('Aşağıdakinin önündesin, ona bir mesaj gönderebilirsin.');
    expect(text).not.toContain('Öndesin');

    mockLevel.value = 3;
    text = await noteFor(middle);
    expect(text).toContain('Buna koyuyorsun. Laf sokma hakkı senin 🍆');
    expect(text).not.toContain('Öndesin');
  });

  it('does not tell a co-leader "öndesin" under "başa baş"', async () => {
    // level with Ali at the top, both ahead of Veli
    const text = await noteFor(threeWay([12430, 1], [12430, 1], [4201, 3], ['u-3']));
    expect(text).toContain('Başa baş');
    expect(text).toContain('Bunun önündesin, laf sokma hakkı sende.');
    expect(text).not.toContain('Öndesin');
  });

  it('keeps "öndesin" for the one in front', async () => {
    const text = await noteFor(threeWay([15000, 1], [12430, 2], [4201, 3], ['u-2', 'u-3']));
    expect(text).toContain('Aferin lan koçum');
    expect(text).toContain('Öndesin, laf sokma hakkı sende.');
    expect(text).not.toContain('önündesin');
  });

  it('asks "… için" over the lines for a rival saved as "Ahmet Y", not "Ahmet Y\'e"', async () => {
    const detail = threeWay([12430, 2], [15000, 1], [4201, 3], ['u-3']);
    const veli = detail.participants[2]!;
    detail.participants[2] = { ...veli, user: { ...veli.user, displayName: 'Ahmet Y' } };
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => detail);
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    press(tree, 'Dürt Bakalım');
    const text = rendered(tree);
    expect(text).toContain('Ahmet Y için ne diyelim?');
    expect(text).not.toContain("Ahmet Y'e");
  });
});

describe('how fresh a phone\'s count is', () => {
  const HOUR = 3_600_000;
  const ALI = { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };
  const CEM = { id: 'u-3', username: 'cem', displayName: 'Cem', avatarEmoji: '🦊', createdAt: '2026-09-01T00:00:00.000Z' };

  /** Me, Ali and Cem in the running steps race, with when each one's phone last reported. */
  function withSyncs(syncs: { me: string | null; ali: string | null; cem: string | null }) {
    const detail = challengeDetail();
    const me = { ...detail.me!, lastSyncAt: syncs.me };
    const ali = { ...detail.me!, user: ALI, score: 4201, rank: 2, lastSyncAt: syncs.ali };
    const cem = { ...detail.me!, user: CEM, score: 900, rank: 3, lastSyncAt: syncs.cem };
    return { ...detail, participants: [me, ali, cem], me };
  }

  it('says under a rival that their phone went quiet hours ago, at the reader\'s level', async () => {
    searchParams.id = 'c-1';
    // a few minutes of slack so the whole hours do not depend on how fast the suite runs
    const ago = (hours: number) => new Date(Date.now() - hours * HOUR - 5 * 60_000).toISOString();
    api.challenge = jest.fn(async () => withSyncs({ me: ago(5), ali: ago(5), cem: ago(1) }));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Telefonu 5 saattir ses vermiyor, sayı eski olabilir');
    // Cem's phone spoke an hour ago, and mine is no rival's: one line, Ali's
    expect(text.match(/ses vermiyor/g)).toHaveLength(1);
  });

  it('says nothing for somebody who types, or once the time is up', async () => {
    searchParams.id = 'c-1';
    const old = new Date(Date.now() - 9 * HOUR).toISOString();
    api.challenge = jest.fn(async () => withSyncs({ me: old, ali: null, cem: null }));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    let tree = renderScreen(<ChallengeScreen />);
    await settle();
    expect(rendered(tree)).not.toContain('ses vermiyor');

    // settling: the last readings are coming in, the hour itself says so
    const settling = withSyncs({ me: old, ali: old, cem: old });
    settling.challenge.endsAt = new Date(Date.now() - 10 * 60_000).toISOString();
    api.challenge = jest.fn(async () => settling);
    tree = renderScreen(<ChallengeScreen />);
    await settle();
    expect(rendered(tree)).toContain('Sonuç birazdan');
    expect(rendered(tree)).not.toContain('ses vermiyor');
  });

  it('times a phone\'s feed row by its last reading, a typed one by when it was typed', async () => {
    searchParams.id = 'c-1';
    const detail = challengeDetail();
    const row = (id: string, source: 'pedometer' | 'manual', createdHoursAgo: number, updatedMinutesAgo: number) => ({
      id,
      userId: ALI.id,
      displayName: ALI.displayName,
      dayKey: '2026-09-08',
      value: 12430,
      source,
      status: 'ok' as const,
      createdAt: new Date(Date.now() - createdHoursAgo * HOUR).toISOString(),
      updatedAt: new Date(Date.now() - updatedMinutesAgo * 60_000).toISOString(),
      proofUrl: null,
    });
    api.challenge = jest.fn(async () => ({
      ...detail,
      participants: [detail.me!, { ...detail.me!, user: ALI, rank: 2 }],
      feed: [row('e-1', 'pedometer', 14, 10), row('e-2', 'manual', 6, 20)],
    }));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    // the phone's 12.430 came ten minutes ago, not just past midnight
    expect(text).toContain('10 dakika önce');
    expect(text).not.toContain('14 saat önce');
    // the typed one keeps its time, whatever an itiraz did to the row since
    expect(text).toContain('6 saat önce');
    expect(text).not.toContain('20 dakika önce');
  });

  it('reads a quiet phone\'s row against the last fetch, as the standings line above it does', async () => {
    searchParams.id = 'c-1';
    const start = new Date('2026-09-08T11:00:00.000Z').getTime();
    // only the clock is faked: the query and settle() still need real timers
    jest.useFakeTimers({
      now: start,
      doNotFake: [
        'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
        'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval',
        'clearInterval', 'setTimeout', 'clearTimeout',
      ],
    });
    try {
      // Ali's phone sent 4.201 five minutes before the screen opened, then went quiet
      const lastReading = new Date(start - 5 * 60_000).toISOString();
      const detail = withSyncs({ me: null, ali: lastReading, cem: null });
      detail.feed = [
        {
          id: 'e-1',
          userId: ALI.id,
          displayName: ALI.displayName,
          dayKey: '2026-09-08',
          value: 4201,
          source: 'pedometer',
          status: 'ok',
          createdAt: new Date(start - 8 * HOUR).toISOString(),
          updatedAt: lastReading,
          proofUrl: null,
        } as (typeof detail.feed)[number],
      ];
      // every fetch hands back the same rows, as the server does for a phone that went quiet
      api.challenge = jest.fn(async () => structuredClone(detail));
      const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
      const tree = renderScreen(<ChallengeScreen />);
      await settle();
      expect(rendered(tree)).toContain('5 dakika önce');

      // Four hours on, nothing fetched yet: the screen still shows that moment, the
      // row included (it used to read the wall clock while the standings did not).
      jest.setSystemTime(start + 4 * HOUR);
      act(() => {
        tree.update(
          <SafeAreaProvider initialMetrics={SAFE_AREA}>
            <QueryClientProvider client={clientOf(tree)}>
              <ToastProvider>
                <ChallengeScreen />
              </ToastProvider>
            </QueryClientProvider>
          </SafeAreaProvider>
        );
      });
      expect(rendered(tree)).toContain('5 dakika önce');
      expect(rendered(tree)).not.toContain('ses vermiyor');

      // the next fetch moves both, though the row itself came back unchanged
      await act(async () => {
        await clientOf(tree).refetchQueries({ queryKey: ['challenge', 'c-1'] });
      });
      await settle();
      const text = rendered(tree);
      expect(text).toContain('Telefonu 4 saattir ses vermiyor, sayı eski olabilir');
      expect(text).toContain('4 saat önce');
      expect(text).not.toContain('5 dakika önce');
    } finally {
      jest.useRealTimers();
    }
  });

  it('dates a feed row and times it by the same calendar', async () => {
    searchParams.id = 'c-1';
    // 08:00 on 2 Ocak in Istanbul, the zone the çelınc is read in
    jest.useFakeTimers({
      now: new Date('2027-01-02T05:00:00.000Z').getTime(),
      doNotFake: [
        'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
        'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval',
        'clearInterval', 'setTimeout', 'clearTimeout',
      ],
    });
    try {
      const detail = { ...challengeDetail(), myTimezone: 'Europe/Istanbul' };
      // typed at 22:00 on 31 Aralık: 34 hours ago, which rounded to "dün"
      const typedAt = '2026-12-31T19:00:00.000Z';
      detail.feed = [
        {
          id: 'e-1',
          userId: ALI.id,
          displayName: ALI.displayName,
          dayKey: '2026-12-31',
          value: 9000,
          source: 'manual',
          status: 'ok',
          createdAt: typedAt,
          updatedAt: typedAt,
          proofUrl: null,
        } as (typeof detail.feed)[number],
      ];
      api.challenge = jest.fn(async () => structuredClone(detail));
      const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
      const tree = renderScreen(<ChallengeScreen />);
      await settle();

      const text = rendered(tree).replace(/\s+/g, ' ');
      expect(text).toContain('31 Aralık · ✍️ beyan · 2 gün önce');
      expect(text).not.toContain('beyan · dün');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('a "Hemen" çelınc nobody else has joined yet', () => {
  it('waits for a rival instead of calling the lone creator "öndesin"', async () => {
    searchParams.id = 'c-1';
    // live since its creation, the invite still unanswered
    const detail = challengeDetail();
    const ali = {
      ...detail.me,
      user: { ...detail.me.user, id: 'u-2', username: 'ali', displayName: 'Ali' },
      status: 'invited' as const,
      score: 0,
      rank: 0,
    };
    api.challenge = jest.fn(async () => ({
      ...detail,
      participants: [detail.me, ali],
      pokeTargets: [{ toUserId: 'u-2', done: false }],
    }));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toMatch(/RAKİP BEKLENİYOR 1 ?\/2 kişi/);
    expect(text).toContain('kimse katılmazsa çelınc bitişte iptal olur');
    // the end still shows, small
    expect(text).toContain('⏳ Bitmesine');
    expect(text).not.toContain('Aferin lan koçum');
    expect(text).not.toContain('laf sokma hakkı');
    // the clock runs, so what the player logs counts
    expect(text).toContain('SENİN SIRAN');
    expect(text).toContain('girişlerin de sayılıyor');
  });

  it('does not tell the invitee their entries count before they are in', async () => {
    searchParams.id = 'c-1';
    const detail = challengeDetail();
    const invited = { ...detail.me, status: 'invited' as const, score: 0, rank: 0 };
    const creator = { ...detail.me, user: { ...detail.me.user, id: 'u-2', username: 'ali', displayName: 'Ali' } };
    detail.challenge.creatorId = 'u-2';
    api.challenge = jest.fn(async () => ({ ...detail, participants: [creator, invited], me: invited }));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toMatch(/RAKİP BEKLENİYOR 1 ?\/2 kişi/);
    expect(text).toMatch(/Süre işliyor\. +Ama tek başına yarış olmaz/);
    expect(text).not.toContain('girişlerin de sayılıyor');
    expect(text).not.toContain('kanka da ekleyebilirsin');
  });

  it('home calls it "RAKİP YOK" rather than "ÖNDESİN"', async () => {
    const { challenge, participants, me } = challengeDetail();
    api.challenges = jest.fn(async () => [{ challenge, participants, me, unreadTaunts: 0 }]);
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const tree = renderScreen(<HomeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('RAKİP YOK');
    expect(text).not.toContain('ÖNDESİN');
    expect(text).not.toContain('Aferin lan koçum');
  });

  it('says a pending çelınc past its start is waiting for a yes, not "Bitti"', async () => {
    const { challenge, participants, me } = challengeDetail();
    const waiting = { ...challenge, status: 'pending' as const, startsAt: new Date(Date.now() - 60 * 60_000).toISOString() };
    api.challenges = jest.fn(async () => [{ challenge: waiting, participants, me, unreadTaunts: 0 }]);
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const tree = renderScreen(<HomeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('🚦 kabul bekleniyor');
    expect(text).not.toContain('Bitti');
  });

  /** The reader's own çelınc, started an hour ago, still waiting for a second yes. */
  function stalled(overrides: Record<string, unknown> = {}) {
    const detail = challengeDetail();
    const ali = {
      ...detail.me,
      user: { ...detail.me.user, id: 'u-2', username: 'ali', displayName: 'Ali' },
      status: 'invited' as const,
      score: 0,
      rank: 0,
    };
    return {
      ...detail,
      challenge: {
        ...detail.challenge,
        status: 'pending' as const,
        startsAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        ...overrides,
      },
      participants: [detail.me, ali],
    };
  }

  it('does not claim the clock of a stalled çelınc is stopped: the end stays, the phones count', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => stalled());
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toMatch(/KABUL BEKLENİYOR 1 ?\/2 kişi/);
    expect(text).toContain('İkinci kişi kabul edince başlar, ama bitiş tarihi kaymaz.');
    expect(text).toContain('Telefonların saydığı adımlar şimdiden yazılıyor.');
    expect(text).toContain('bitişte kendiliğinden iptal olur');
    expect(text).toContain('İstersen aşağıdan şimdi iptal edebilirsin.');
    expect(text).not.toContain('süre işlemiyor');
    expect(text).not.toContain('giriş yapılamaz');
  });

  it('tells a stalled check-in çelınc that nothing goes in before it starts', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () =>
      stalled({
        typeKey: 'erken_kus',
        metricType: 'checkin_deadline',
        unit: 'gün',
        title: 'Sabah Kalkma',
        deadlineTime: '07:00',
      })
    );
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('İkinci kişi kabul edince başlar, ama bitiş tarihi kaymaz.');
    expect(text).toContain('Başlayana kadar giriş yapılamaz.');
    expect(text).not.toContain('şimdiden yazılıyor');
    // and no "Geldim" to press while it waits
    expect(text).not.toContain('GELDİM');
  });
});

describe('saying yes to a çelınc the phone counts', () => {
  it('sends the phone\'s steps right after "Varım"', async () => {
    searchParams.id = 'c-1';
    const detail = challengeDetail();
    const invited = { ...detail.me, status: 'invited' as const, score: 0, rank: 0 };
    const creator = { ...detail.me, user: { ...detail.me.user, id: 'u-2', username: 'ali', displayName: 'Ali' } };
    detail.challenge.creatorId = 'u-2';
    api.challenge = jest.fn(async () => ({ ...detail, participants: [creator, invited], me: invited }));
    api.acceptChallenge = jest.fn(async () => ({ ...detail, participants: [creator, detail.me] }));
    const steps = require('@/services/steps') as { getDailySteps: jest.Mock };
    steps.getDailySteps.mockClear();

    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();
    expect(steps.getDailySteps).not.toHaveBeenCalled();

    press(tree, 'Varım');
    await settle();
    expect(api.acceptChallenge).toHaveBeenCalledWith('c-1');
    expect(steps.getDailySteps).toHaveBeenCalledWith(LIMITS.STEPS_BACKFILL_DAYS);
  });

  // A yes to a "Yarın 04:00" Erken Kalkan Koyar at 23:00 is the last thing done
  // on the phone that night, and the refresh that ran when the app came up saw
  // an invite: the first morning's 06:30 alarm was never set.
  it('plans the phone\'s check-in reminders again right after "Varım"', async () => {
    searchParams.id = 'c-1';
    const detail = challengeDetail();
    const morning = {
      ...detail.challenge,
      creatorId: 'u-2',
      status: 'pending' as const,
      typeKey: 'erken_kus',
      metricType: 'checkin_deadline' as const,
      unit: 'gün',
      title: 'Sabah Kalkma',
      deadlineTime: '07:00',
      startsAt: new Date(Date.now() + 5 * 3_600_000).toISOString(),
    };
    const invited = { ...detail.me, status: 'invited' as const, score: 0, rank: 0 };
    const creator = { ...detail.me, user: { ...detail.me.user, id: 'u-2', username: 'ali', displayName: 'Ali' } };
    api.challenge = jest.fn(async () => ({ ...detail, challenge: morning, participants: [creator, invited], me: invited }));
    api.acceptChallenge = jest.fn(async () => ({ ...detail, challenge: morning, participants: [creator, detail.me] }));

    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();
    mockReminders.refresh.mockClear();

    press(tree, 'Varım');
    await settle();
    expect(api.acceptChallenge).toHaveBeenCalledWith('c-1');
    expect(mockReminders.refresh).toHaveBeenCalledTimes(1);
    expect(mockReminders.refresh).toHaveBeenCalledWith(api, 2, 'Europe/Istanbul');
  });
});

describe('an invite, before and after the door closes', () => {
  const ALI = { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };
  const DAY = 86_400_000;

  /**
   * Ali's screen-time çelınc with a photo on every typed number, the reader
   * still invited. By default it starts tomorrow and runs seven days; `startsIn`
   * and `endsIn` move either end relative to now.
   */
  function screenTimeInvite(
    options: { status?: 'pending' | 'active' | 'finished'; startsIn?: number; endsIn?: number } = {}
  ) {
    const detail = challengeDetail();
    const startsIn = options.startsIn ?? DAY;
    const ali = { ...detail.me, user: ALI };
    const me = { ...detail.me, status: 'invited' as const, score: 0, days: 0, rank: 0, lastEntryAt: null };
    return {
      ...detail,
      challenge: {
        ...detail.challenge,
        creatorId: ALI.id,
        typeKey: 'ekran_suresi_beyani',
        metricType: 'manual_lower_is_better' as const,
        direction: 'lower' as const,
        unit: 'dk',
        title: 'Telefonu Bırak',
        status: options.status ?? ('pending' as const),
        startsAt: new Date(Date.now() + startsIn).toISOString(),
        // the same hour six days on: seven day keys whatever the time of day
        endsAt: new Date(Date.now() + (options.endsIn ?? startsIn + 6 * DAY)).toISOString(),
        proofRequired: true,
        penaltyText: 'Kaybeden bulaşık yıkar',
      },
      participants: [ali, me],
      me,
    };
  }

  /** Ends in half an hour, so the door closed half an hour ago. */
  const closed = () => screenTimeInvite({ status: 'active', startsIn: -2 * DAY, endsIn: 30 * 60_000 });

  it('shows the invitee who wins, for how long, the photo rule and the empty-day cost above "Varım"', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => screenTimeInvite());
    api.acceptChallenge = jest.fn(async () => ({}));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Günlük ekran süresi ortalaması en düşük olan kazanır.');
    expect(text).toContain('📅 7 gün · ');
    expect(text).toContain('📸 Elle girdiğin her sayıya kanıt fotoğrafı lazım');
    expect(text).toContain('⚠️ Girmediğin gün 1.440 dk yazılır');
    // "Nasıl sayılıyor?" is unfolded for somebody about to say yes
    expect(text).toContain('Girmediğin gün 1440 dakika yazılıyor.');
    expect(text).toContain('Kaybeden bulaşık yıkar');
    expect(text.indexOf('KURALLAR')).toBeGreaterThan(-1);
    expect(text.indexOf('KURALLAR')).toBeLessThan(text.indexOf('Davet sende'));

    // a yes to a çelınc that has not started counts nothing yet
    press(tree, 'Varım');
    await settle();
    expect(api.acceptChallenge).toHaveBeenCalledWith('c-1');
    expect(rendered(tree)).toContain('Çelınc başlayınca skorun sayılmaya başlar.');
    expect(rendered(tree)).not.toContain('Skorun sayılmaya başladı.');
  });

  it('puts the days, the photo rule and the stakes on the home card', async () => {
    const { challenge, participants, me } = screenTimeInvite();
    api.challenges = jest.fn(async () => [{ challenge, participants, me, unreadTaunts: 0 }]);
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const tree = renderScreen(<HomeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Ali davet etti');
    expect(text).toMatch(/📅 7 gün · .+ · 📸 Kanıt lazım/);
    expect(text).toContain('🎁 Kaybeden kahve ısmarlar · 💀 Kaybeden bulaşık yıkar');
  });

  // "Kabul edersen başlar" over a çelınc two days in: a newcomer said yes and
  // found everybody else days ahead
  it('tells the invitee on the home card that a running çelınc already started', async () => {
    mockLevel.value = 1;
    const { challenge, participants, me } = screenTimeInvite({ status: 'active', startsIn: -2 * DAY });
    api.challenges = jest.fn(async () => [{ challenge, participants, me, unreadTaunts: 0 }]);
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const tree = renderScreen(<HomeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Bu çelınc başladı bile. Kabul edersen hemen sıralamaya girersin.');
    expect(text).not.toContain('Kabul edersen başlar');
  });

  it('keeps "Kabul edersen başlar" for one that has not started', async () => {
    mockLevel.value = 1;
    const { challenge, participants, me } = screenTimeInvite();
    api.challenges = jest.fn(async () => [{ challenge, participants, me, unreadTaunts: 0 }]);
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const tree = renderScreen(<HomeScreen />);
    await settle();

    expect(rendered(tree)).toContain('Bu çelınc seni bekliyor. Kabul edersen başlar.');
    expect(rendered(tree)).not.toContain('başladı bile');
  });

  it('names the player who called on the home card, not the creator', async () => {
    const VELI = { id: 'u-4', username: 'veli', displayName: 'Veli', avatarEmoji: '🐺', createdAt: '2026-09-01T00:00:00.000Z' };
    const { challenge, participants, me } = screenTimeInvite();
    const called = { ...me, invitedBy: VELI.id };
    const veli = { ...participants[0], user: VELI, invitedBy: ALI.id };
    api.challenges = jest.fn(async () => [
      { challenge, participants: [participants[0], veli, called], me: called, unreadTaunts: 0 },
    ]);
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const tree = renderScreen(<HomeScreen />);
    await settle();

    expect(rendered(tree)).toContain('Veli davet etti');
    expect(rendered(tree)).not.toContain('Ali davet etti');
  });

  it('leaves an invite nobody can accept any more out of Davetler', async () => {
    const late = closed();
    const open = screenTimeInvite();
    api.challenges = jest.fn(async () => [
      { challenge: { ...late.challenge, id: 'c-9', title: 'Kapanan Çelınc' }, participants: late.participants, me: late.me, unreadTaunts: 0 },
      { challenge: open.challenge, participants: open.participants, me: open.me, unreadTaunts: 0 },
    ]);
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const tree = renderScreen(<HomeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Telefonu Bırak');
    expect(text).not.toContain('Kapanan Çelınc');
    expect(tree.root.findAll((node) => node.props.title === 'Kabul' && typeof node.props.onPress === 'function')).toHaveLength(1);
  });

  it('says the door is closed on the çelınc screen instead of offering a "Varım" that can only fail', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => closed());
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Bu çelınca katılım kapandı.');
    expect(() => findWith(tree, 'title', 'Varım', 'onPress')).toThrow();
    expect(text).not.toContain('Davet sende');
    // the rules stay, folded, for somebody only watching
    expect(text).toContain('Nasıl sayılıyor? ▾');
    expect(text).not.toContain('Girmediğin gün 1440 dakika yazılıyor.');
    const [toggle] = tree.root.findAll(
      (node) => node.props.accessibilityState?.expanded === false && typeof node.props.onPress === 'function'
    );
    act(() => {
      toggle!.props.onPress();
    });
    expect(rendered(tree)).toContain('Girmediğin gün 1440 dakika yazılıyor.');
    expect(rendered(tree)).toContain('Nasıl sayılıyor? ▴');
  });

  it('goes by the closing instant the server sends rather than its own sums', async () => {
    searchParams.id = 'c-1';
    // three days to go, yet this server already stopped taking players
    const detail = screenTimeInvite({ status: 'active', startsIn: -DAY, endsIn: 3 * DAY });
    const acceptClosesAt = new Date(Date.now() - 60_000).toISOString();
    api.challenge = jest.fn(async () => ({ ...detail, challenge: { ...detail.challenge, acceptClosesAt } }));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    expect(rendered(tree)).toContain('Bu çelınca katılım kapandı.');
    expect(() => findWith(tree, 'title', 'Varım', 'onPress')).toThrow();
  });

  it('calls a finished çelınc the reader never answered "KAÇIRDIN", with nobody "bekliyor"', async () => {
    const { challenge, participants, me } = screenTimeInvite({ status: 'finished', startsIn: -8 * DAY, endsIn: -DAY });
    api.challenges = jest.fn(async () => [
      { challenge: { ...challenge, finalizedAt: challenge.endsAt, winnerId: ALI.id }, participants, me, unreadTaunts: 0 },
    ]);
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const tree = renderScreen(<HomeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('KAÇIRDIN');
    expect(text).not.toContain('DAVET');
    expect(text).not.toContain('YEDİN');
    expect(text).not.toContain('bekliyor');
  });

  it('leaves an unanswered invite off the final table', async () => {
    searchParams.id = 'c-1';
    const detail = challengeDetail();
    const CEM = { id: 'u-3', username: 'cem', displayName: 'Cem', avatarEmoji: '🦁', createdAt: '2026-09-01T00:00:00.000Z' };
    const finalizedAt = new Date(Date.now() - 3_600_000).toISOString();
    api.results = jest.fn(async () => ({
      challenge: { ...detail.challenge, status: 'finished' as const, endsAt: finalizedAt, finalizedAt, winnerId: 'me-1' },
      standings: [
        { ...detail.me, rank: 1, isWinner: true },
        { ...detail.me, user: ALI, score: 8000, rank: 2 },
        { ...detail.me, user: CEM, status: 'invited' as const, score: 0, rank: 0 },
      ],
      taunts: [],
    }));
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Ali');
    expect(text).not.toContain('Cem');
    expect(text).not.toContain('bekliyor');
  });
});

describe('a çelınc called off', () => {
  it('lists nobody as "bekliyor" for an invite nobody can answer any more', async () => {
    searchParams.id = 'c-1';
    const detail = challengeDetail();
    const CEM = { id: 'u-3', username: 'cem', displayName: 'Cem', avatarEmoji: '🦁', createdAt: '2026-09-01T00:00:00.000Z' };
    const cem = { ...detail.me, user: CEM, status: 'invited' as const, score: 0, days: 0, rank: 0, lastEntryAt: null };
    const cancelled = {
      ...detail,
      challenge: { ...detail.challenge, status: 'cancelled' as const, finalizedAt: new Date().toISOString() },
      participants: [detail.me, cem],
    };
    api.challenge = jest.fn(async () => cancelled);
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();
    expect(rendered(tree)).toContain('Mustafa');
    expect(rendered(tree)).not.toContain('bekliyor');

    api.challenges = jest.fn(async () => [
      { challenge: cancelled.challenge, participants: cancelled.participants, me: cancelled.me, unreadTaunts: 0 },
    ]);
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const home = renderScreen(<HomeScreen />);
    await settle();
    expect(rendered(home)).not.toContain('bekliyor');
  });
});

describe('a step çelınc past its end, still active on the server', () => {
  it('says the last steps are coming in, offers no entry, and sends this phone\'s count', async () => {
    searchParams.id = 'c-1';
    const detail = challengeDetail();
    detail.challenge.endsAt = new Date(Date.now() - 5 * 60_000).toISOString();
    api.challenge = jest.fn(async () => detail);
    const steps = require('@/services/steps') as { getDailySteps: jest.Mock };
    steps.getDailySteps.mockClear();

    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    // labels render in Turkish capitals
    expect(text).toContain('SÜRE BİTTİ');
    expect(text).toContain('Sonuç birazdan');
    expect(text).toContain('son adımlar toplanıyor');
    expect(text).not.toContain('BİTMESİNE');
    expect(text).not.toContain('SENİN SIRAN');
    expect(text).not.toContain('BEYAN ET');
    // no "böyle devam" when there is nothing left to continue
    expect(text).not.toContain('Aferin lan koçum');
    // walking out now would void the result (the server refuses it too)
    expect(text).not.toContain('AYRIL');
    expect(steps.getDailySteps).toHaveBeenCalled();
  });

  it('offers no "laf sok" once the time is up, even if a server still lists a rival', async () => {
    searchParams.id = 'c-1';
    const withRival = () => {
      const detail = challengeDetail();
      const rival = {
        user: { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' },
        status: 'accepted' as const,
        score: 4201,
        days: 2,
        rank: 2,
        lastEntryAt: '2026-09-08T09:00:00.000Z',
        isWinner: false,
      };
      return { ...detail, participants: [detail.me, rival], pokeTargets: [{ toUserId: 'u-2', done: false }] };
    };
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;

    api.challenge = jest.fn(async () => withRival());
    const running = renderScreen(<ChallengeScreen />);
    await settle();
    expect(rendered(running)).toContain('laf sokma hakkı');

    const ended = withRival();
    ended.challenge.endsAt = new Date(Date.now() - 5 * 60_000).toISOString();
    api.challenge = jest.fn(async () => ended);
    const settling = renderScreen(<ChallengeScreen />);
    await settle();
    const text = rendered(settling);
    expect(text).toContain('Sonuç birazdan');
    expect(text).not.toContain('laf sokma hakkı');
  });

  it('counts down and offers the entry while the time is not up', async () => {
    searchParams.id = 'c-1';
    // a race: alone in it, the hero waits for a rival instead
    const detail = challengeDetail();
    const ali = { ...detail.me, user: { ...detail.me.user, id: 'u-2', username: 'ali', displayName: 'Ali' }, score: 4201, rank: 2 };
    detail.participants = [detail.me, ali];
    api.challenge = jest.fn(async () => detail);
    const steps = require('@/services/steps') as { getDailySteps: jest.Mock };
    steps.getDailySteps.mockClear();

    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('BİTMESİNE');
    expect(text).toContain('SENİN SIRAN');
    expect(text).toContain('BEYAN ET');
    expect(text).toContain('AYRIL');
    expect(text).not.toContain('Sonuç birazdan');
    expect(steps.getDailySteps).not.toHaveBeenCalled();
  });

  it('home shows "sonuç bekleniyor" on its card instead of a countdown stuck at zero', async () => {
    const { challenge, participants, me } = challengeDetail();
    const ended = { ...challenge, endsAt: new Date(Date.now() - 5 * 60_000).toISOString() };
    api.challenges = jest.fn(async () => [{ challenge: ended, participants, me, unreadTaunts: 0 }]);
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const tree = renderScreen(<HomeScreen />);
    await settle();
    expect(rendered(tree)).toContain('Sonuç bekleniyor');
  });
});

describe('a typed çelınc past its end, still active on the server', () => {
  /** A page count that ended five minutes ago; `close` is the server's `disputesCloseAt`. */
  function endedPages(close: (endsAt: number) => string | undefined) {
    const detail = challengeDetail();
    const endsAt = Date.now() - 5 * 60_000;
    return {
      ...detail,
      challenge: {
        ...detail.challenge,
        typeKey: 'kitap_sayfa',
        metricType: 'manual_count' as const,
        unit: 'sayfa',
        title: 'Sayfa Avcısı',
        endsAt: new Date(endsAt).toISOString(),
      },
      disputesCloseAt: close(endsAt),
    };
  }

  it('says the result waits an hour for itirazlar when a number came in the last hour', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () =>
      endedPages((endsAt) => new Date(endsAt + LIMITS.DEVICE_SETTLE_MS).toISOString())
    );
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Sonuç birazdan');
    expect(text).toContain('Son saatte yapılan girişler var');
    expect(text).toContain('En geç bir saat içinde kazanan belli olur.');
    expect(text).not.toContain('bir dakikaya kalmaz');
  });

  it('promises the result within a minute when nothing came late, or the server does not say', async () => {
    searchParams.id = 'c-1';
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    for (const close of [(endsAt: number) => new Date(endsAt).toISOString(), () => undefined]) {
      api.challenge = jest.fn(async () => endedPages(close));
      const tree = renderScreen(<ChallengeScreen />);
      await settle();
      const text = rendered(tree);
      expect(text).toContain('Son hesap yapılıyor, bir dakikaya kalmaz.');
      expect(text).not.toContain('Son saatte yapılan');
    }
  });
});

describe('step days the phone never counted', () => {
  // ME.timezone is unusable, so the screens fall back to the device zone
  const today = () => todayKey('Europe/Istanbul');

  function stepEntry(dayKey: string, value: number, status: Entry['status'] = 'ok'): Entry {
    return {
      id: `e-${dayKey}`,
      challengeId: 'c-1',
      userId: 'me-1',
      dayKey,
      value,
      source: status === 'ok' ? 'pedometer' : 'manual',
      note: null,
      proofUrl: null,
      status,
      createdAt: new Date().toISOString(),
    };
  }

  /** Every past day the server still takes a typed number for, each with a number. */
  function everyDayCounted(): Entry[] {
    return Array.from({ length: LIMITS.STEPS_BACKFILL_DAYS }, (_, i) => stepEntry(addDays(today(), -(i + 1)), 8000));
  }

  afterEach(async () => {
    await AsyncStorage.removeItem('koydum.stepRecordingSince');
  });

  it('offers "Eksik günü yaz" for an empty day and opens the entry on the oldest one still allowed', async () => {
    searchParams.id = 'c-1';
    // joined late: the race started weeks ago and nothing is written for this week
    api.challenge = jest.fn(async () => challengeDetail());
    const { router } = require('expo-router') as { router: Record<string, jest.Mock> };
    router.push!.mockClear();

    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    expect(rendered(tree)).toContain('EKSİK GÜNÜ YAZ');
    // the existing "Beyan et" for today stays
    expect(rendered(tree)).toContain('BEYAN ET');
    press(tree, 'Eksik günü yaz');
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/challenge/[id]/entry',
      params: { id: 'c-1', day: addDays(today(), -LIMITS.STEPS_BACKFILL_DAYS), proof: '0' },
    });
  });

  it('says why when the empty days come before this phone started counting', async () => {
    await AsyncStorage.setItem('koydum.stepRecordingSince', JSON.stringify(addDays(today(), -1)));
    searchParams.id = 'c-1';
    const entries = everyDayCounted().filter((entry) => entry.dayKey !== addDays(today(), -3));
    api.challenge = jest.fn(async () => ({ ...challengeDetail(), myEntries: entries }));

    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('EKSİK GÜNÜ YAZ');
    expect(text).toContain('Telefon adım saymaya dün başladı, öncesini bilmiyor.');
  });

  it('offers nothing when every day has a number, or friends threw it out', async () => {
    searchParams.id = 'c-1';
    // the itiraz-ed day is the phone's to bring back, not a typed one's
    const entries = everyDayCounted().map((entry, i) => (i === 2 ? stepEntry(entry.dayKey, 30000, 'rejected') : entry));
    api.challenge = jest.fn(async () => ({ ...challengeDetail(), myEntries: entries }));

    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('SENİN SIRAN');
    expect(text).not.toContain('EKSİK GÜNÜ YAZ');
    expect(text).not.toContain('öncesini bilmiyor');
  });
});

describe('a friend in another zone than the creator', () => {
  const { formatDayKey } = require('@/utils/format') as typeof import('@/utils/format');
  const DAY = 86_400_000;

  /**
   * Three days and a few minutes in Istanbul: four day keys, the last one the
   * sliver of today a creator's end in another zone cut short. The server
   * scores the reader on the first three (`myDays`).
   */
  function slivered(typeKey: string, metricType: 'daily_boolean' | 'manual_lower_is_better') {
    const detail = challengeDetail();
    const endsAt = new Date(Date.now() + 5 * 60_000);
    const today = todayKey('Europe/Istanbul');
    return {
      ...detail,
      challenge: {
        ...detail.challenge,
        typeKey,
        metricType,
        direction: metricType === 'daily_boolean' ? ('higher' as const) : ('lower' as const),
        unit: metricType === 'daily_boolean' ? 'gün' : 'dk',
        startsAt: new Date(endsAt.getTime() - 3 * DAY).toISOString(),
        endsAt: endsAt.toISOString(),
      },
      myTimezone: 'Europe/Istanbul',
      myDays: { first: addDays(today, -3), last: addDays(today, -1) },
    };
  }

  it('reads "3 gün" on the rules card and offers no "Bugün" on a yes/no çelınc', async () => {
    const today = todayKey('Europe/Istanbul');
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => slivered('sigara_yok', 'daily_boolean'));

    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain(`📅 3 gün · ${formatDayKey(addDays(today, -3))} – ${formatDayKey(addDays(today, -1))}`);
    expect(text).toContain('Herkes aynı sayıda gün oynasın diye bugün sende sayılmıyor, son günün dündü.');
    expect(text).toContain('DÜN (BOŞ KALMIŞ)');
    expect(text).not.toContain('📅 4 gün');
  });

  it('opens the entry form on the last day scored, without today', async () => {
    const today = todayKey('Europe/Istanbul');
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => slivered('ekran_suresi_beyani', 'manual_lower_is_better'));

    const EntryScreen = require('@/app/(app)/challenge/[id]/entry').default;
    const tree = renderScreen(<EntryScreen />);
    await settle();

    const picker = tree.root.findAll(
      (node) => Array.isArray(node.props.options) && typeof node.props.onChange === 'function'
    )[0];
    expect(picker?.props.options.map((option: { value: string }) => option.value)).toEqual([
      addDays(today, -1),
      addDays(today, -2),
    ]);
    expect(picker?.props.value).toBe(addDays(today, -1));
  });
});

describe('a rival who plays a check-in çelınc on another zone\'s clock', () => {
  const VELI = { id: 'u-2', username: 'veli', displayName: 'Veli', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };

  /** Me in Istanbul, a morning behind Veli, who said yes with his profile on Tokyo. */
  function tokyoRival() {
    const detail = challengeDetail();
    const me = { ...detail.me!, score: 2, rank: 2, timezone: 'Europe/Istanbul' };
    const veli = { ...detail.me!, user: VELI, score: 3, rank: 1, timezone: 'Asia/Tokyo' };
    return {
      ...detail,
      challenge: {
        ...detail.challenge,
        typeKey: 'erken_kus',
        metricType: 'checkin_deadline' as const,
        unit: 'gün',
        title: 'Sabah Kalkma',
        deadlineTime: '07:00',
      },
      participants: [veli, me],
      me,
      myTimezone: 'Europe/Istanbul',
    };
  }

  /** A "Geldim" in the feed, tapped at `createdAt`. */
  function checkinRow(id: string, user: { id: string; displayName: string }, createdAt: string) {
    return {
      id,
      userId: user.id,
      displayName: user.displayName,
      dayKey: '2026-09-09',
      value: 1,
      source: 'checkin' as const,
      status: 'ok' as const,
      createdAt,
      updatedAt: createdAt,
      proofUrl: null,
    };
  }

  it('names the clock he plays on under his name in the standings, and none by mine', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => tokyoRival());
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    // on a line of its own, where a long name or a 360 dp screen cannot cut it off
    expect(text).toContain('🕐 Tokyo saati');
    expect(text.match(/🕐/g)).toHaveLength(1);
    const label = tree.root.findAll((node) => node.props.children === '🕐 Tokyo saati' && node.props.numberOfLines === 1);
    expect(label.length).toBeGreaterThan(0);
  });

  it('prints the clock of his "Geldim" in his zone and in mine', async () => {
    searchParams.id = 'c-1';
    const detail = tokyoRival();
    // 06:30 in Tokyo is 00:30 in Istanbul
    api.challenge = jest.fn(async () => ({
      ...detail,
      feed: [
        checkinRow('e-1', VELI, '2026-09-08T21:30:00.000Z'),
        checkinRow('e-2', detail.me.user, '2026-09-09T03:40:00.000Z'),
      ],
    }));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Tokyo saatiyle 06:30 (sende 00:30)');
    // never cut: a 360 dp phone at a larger font, with the itiraz chip beside it, needs three lines for it
    const clock = tree.root.findAll((node) => node.props.children === 'Tokyo saatiyle 06:30 (sende 00:30)');
    expect(clock.length).toBeGreaterThan(0);
    expect(clock.every((node) => node.props.numberOfLines === undefined)).toBe(true);
    // mine is on my own clock: nothing to add
    expect(text.match(/saatiyle/g)).toHaveLength(1);
  });

  it('gives the end as the limit on an evening the end cuts before its deadline', async () => {
    searchParams.id = 'c-1';
    // 19:30 in London on the last day of an Istanbul erken_yat that ends at 20:59 there
    const NOW_AT = new Date('2026-11-16T19:30:00.000Z').getTime();
    jest.useFakeTimers({
      now: NOW_AT,
      doNotFake: [
        'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
        'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval',
        'clearInterval', 'setTimeout', 'clearTimeout',
      ],
    });
    try {
      const detail = tokyoRival();
      api.challenge = jest.fn(async () => ({
        ...detail,
        challenge: {
          ...detail.challenge,
          typeKey: 'erken_yat',
          deadlineTime: '23:00',
          startsAt: '2026-11-10T06:00:00.000Z',
          endsAt: '2026-11-16T20:59:59.999Z',
        },
        myTimezone: 'Europe/London',
        myDays: { first: '2026-11-10', last: '2026-11-16' },
      }));
      const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
      const tree = renderScreen(<ChallengeScreen />);
      await settle();

      const text = rendered(tree);
      expect(text).toMatch(/Bugünün sınırı:\s*20:59\s*\.\s*Çelınc saat\s*23:00\s*olmadan bitiyor, ondan önce bas\./);
      expect(text).toContain('GELDİM');
    } finally {
      jest.useRealTimers();
    }
  });

  it('offers no "Geldim" on a morning the server leaves out of my days', async () => {
    const today = todayKey('Europe/Istanbul');
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => ({ ...tokyoRival(), myDays: { first: addDays(today, -3), last: addDays(today, -1) } }));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Herkes aynı sayıda check-in yapsın diye bugün sende sayılmıyor, son check-in günün dündü.');
    expect(text).not.toContain('GELDİM');
  });
});

describe('the entry modal', () => {
  const today = () => todayKey('Europe/Istanbul');
  const { formatDayKey } = require('@/utils/format') as typeof import('@/utils/format');

  /** The day chip with this label, if the modal drew one. */
  function dayChip(tree: ReactTestRenderer, label: string) {
    return tree.root.findAll((node) => node.props.label === label && 'selected' in node.props)[0];
  }

  it('offers a step çelınc a week of days and opens on the one it was asked for', async () => {
    const threeBack = addDays(today(), -3);
    searchParams.id = 'c-1';
    searchParams.day = threeBack;
    api.challenge = jest.fn(async () => challengeDetail());

    const EntryScreen = require('@/app/(app)/challenge/[id]/entry').default;
    const tree = renderScreen(<EntryScreen />);
    await settle();

    expect(dayChip(tree, 'Bugün')?.props.selected).toBe(false);
    expect(dayChip(tree, 'Dün')).toBeDefined();
    expect(dayChip(tree, formatDayKey(threeBack))?.props.selected).toBe(true);
    expect(dayChip(tree, formatDayKey(addDays(today(), -LIMITS.STEPS_BACKFILL_DAYS)))).toBeDefined();
    // one day further back the server says day_too_old
    expect(dayChip(tree, formatDayKey(addDays(today(), -LIMITS.STEPS_BACKFILL_DAYS - 1)))).toBeUndefined();
  });

  it('keeps a typed count to today and yesterday', async () => {
    searchParams.id = 'c-1';
    searchParams.day = addDays(today(), -2);
    const detail = challengeDetail();
    api.challenge = jest.fn(async () => ({
      ...detail,
      challenge: { ...detail.challenge, typeKey: 'su_bardak', metricType: 'manual_count' as const, unit: 'bardak' },
    }));

    const EntryScreen = require('@/app/(app)/challenge/[id]/entry').default;
    const tree = renderScreen(<EntryScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Bugün');
    expect(text).toContain('Dün');
    expect(text).not.toContain(formatDayKey(addDays(today(), -2)));
    expect(dayChip(tree, 'Bugün')).toBeUndefined();
  });

  it('lets screen time go back as far as the server takes a typed number', async () => {
    // a friend who said yes at 23:40 is scored from the day before; that day
    // must still be on offer the morning after
    searchParams.id = 'c-1';
    searchParams.day = addDays(today(), -LIMITS.MANUAL_BACKFILL_DAYS);
    const detail = challengeDetail();
    api.challenge = jest.fn(async () => ({
      ...detail,
      challenge: {
        ...detail.challenge,
        typeKey: 'ekran_suresi_beyani',
        metricType: 'manual_lower_is_better' as const,
        direction: 'lower' as const,
        unit: 'dk',
      },
    }));

    const EntryScreen = require('@/app/(app)/challenge/[id]/entry').default;
    const tree = renderScreen(<EntryScreen />);
    await settle();

    expect(dayChip(tree, 'Bugün')?.props.selected).toBe(false);
    expect(dayChip(tree, 'Dün')).toBeDefined();
    expect(dayChip(tree, formatDayKey(addDays(today(), -LIMITS.MANUAL_BACKFILL_DAYS)))?.props.selected).toBe(true);
    expect(dayChip(tree, formatDayKey(addDays(today(), -LIMITS.MANUAL_BACKFILL_DAYS - 1)))).toBeUndefined();
  });

  it('locks a step day friends threw out: only the phone writes it now', async () => {
    const day = addDays(today(), -1);
    searchParams.id = 'c-1';
    searchParams.day = day;
    const detail = challengeDetail();
    const entry: Entry = {
      id: 'e-1', challengeId: 'c-1', userId: 'me-1', dayKey: day, value: 11800, source: 'pedometer',
      note: null, proofUrl: null, status: 'ok', createdAt: new Date().toISOString(),
    };
    api.challenge = jest.fn(async () => ({
      ...detail,
      myEntries: [entry],
      disputes: [
        { id: 'd-1', entryId: 'e-1', byUserId: 'u-2', reason: 'otuz bin mi', status: 'upheld' as const, createdAt: entry.createdAt },
      ],
    }));

    const EntryScreen = require('@/app/(app)/challenge/[id]/entry').default;
    const tree = renderScreen(<EntryScreen />);
    await settle();

    expect(rendered(tree)).toContain('Dün için yazdığını kankalar itirazla yaktı.');
    expect(findWith(tree, 'title', 'Kaydet', 'onPress').props.disabled).toBe(true);
  });

  it('does not promise the phone back on a phone reading friends threw out', async () => {
    const day = addDays(today(), -1);
    searchParams.id = 'c-1';
    searchParams.day = day;
    const detail = challengeDetail();
    const entry: Entry = {
      id: 'e-1', challengeId: 'c-1', userId: 'me-1', dayKey: day, value: 30000, source: 'pedometer',
      note: null, proofUrl: null, status: 'rejected', createdAt: new Date().toISOString(),
    };
    api.challenge = jest.fn(async () => ({
      ...detail,
      myEntries: [entry],
      disputes: [
        { id: 'd-1', entryId: 'e-1', byUserId: 'u-2', reason: 'otuz bin mi', status: 'upheld' as const, createdAt: entry.createdAt },
      ],
    }));

    const EntryScreen = require('@/app/(app)/challenge/[id]/entry').default;
    const tree = renderScreen(<EntryScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Dün için telefonun saydığını kankalar itirazla yaktı. O güne artık bir şey yazılmaz.');
    expect(text).not.toContain('sadece telefonun saydığı');
    expect(findWith(tree, 'title', 'Kaydet', 'onPress').props.disabled).toBe(true);
  });

  it('prints a run in two decimals like the standings, and never rounds what is left up', async () => {
    searchParams.id = 'c-1';
    const detail = challengeDetail();
    const ran: Entry = {
      id: 'e-1', challengeId: 'c-1', userId: 'me-1', dayKey: today(), value: 5.375, source: 'manual',
      note: null, proofUrl: null, status: 'ok', createdAt: new Date().toISOString(),
    };
    api.challenge = jest.fn(async () => ({
      ...detail,
      challenge: { ...detail.challenge, typeKey: 'kosu_km', metricType: 'manual_count' as const, unit: 'km', title: 'Koşu haftası' },
      myEntries: [ran],
    }));
    api.addEntry = jest.fn(async () => ({ entry: {}, standings: [] }));
    const EntryScreen = require('@/app/(app)/challenge/[id]/entry').default;
    const tree = renderScreen(<EntryScreen />);
    await settle();

    // 100 - 5,375 is 94,625: "94,63" would be refused as over the cap if typed
    const text = rendered(tree);
    expect(text).toContain('Bugün için kalan: 94,62 km.');
    expect(text).not.toContain('94,6 km');
    expect(text).not.toContain('94,63');

    act(() => {
      findWith(tree, 'placeholder', '0', 'onChangeText').props.onChangeText('2,25');
    });
    await act(async () => {
      await findWith(tree, 'title', 'Kaydet', 'onPress').props.onPress();
    });
    await settle();

    expect(api.addEntry).toHaveBeenCalledWith('c-1', expect.objectContaining({ value: 2.25 }));
    expect(rendered(tree)).toContain('2,25 km · bugün');
    expect(rendered(tree)).not.toContain('2,3 km');
  });

  /** The reader's runs today in a 100 km a day koşu çelınc, in the order the server lists them. */
  function runs(...values: number[]) {
    const detail = challengeDetail();
    const myEntries: Entry[] = values.map((value, i) => ({
      id: `e-${i}`, challengeId: 'c-1', userId: 'me-1', dayKey: today(), value, source: 'manual',
      note: null, proofUrl: null, status: 'ok', createdAt: new Date(Date.now() - (values.length - i) * 60_000).toISOString(),
    }));
    return {
      ...detail,
      challenge: { ...detail.challenge, typeKey: 'kosu_km', metricType: 'manual_count' as const, unit: 'km', title: 'Koşu haftası' },
      myEntries,
    };
  }

  it('shows and takes the true remainder after runs whose sum is a hair off in floating point', async () => {
    searchParams.id = 'c-1';
    // 14,4 + 59,7 + 15,9 is 90.00000000000001 in JavaScript; the server's SUM is 90 and takes a 10
    api.challenge = jest.fn(async () => runs(14.4, 59.7, 15.9));
    api.addEntry = jest.fn(async () => ({ entry: {}, standings: [] }));
    const EntryScreen = require('@/app/(app)/challenge/[id]/entry').default;
    const tree = renderScreen(<EntryScreen />);
    await settle();

    expect(rendered(tree)).toContain('Bugün için kalan: 10 km.');
    act(() => {
      findWith(tree, 'placeholder', '0', 'onChangeText').props.onChangeText('10');
    });
    await act(async () => {
      await findWith(tree, 'title', 'Kaydet', 'onPress').props.onPress();
    });
    await settle();

    expect(rendered(tree)).not.toContain('kaldı');
    expect(api.addEntry).toHaveBeenCalledWith('c-1', expect.objectContaining({ value: 10 }));
  });

  it('keeps the card\'s "+10" for the 10 km the day still has, and calls a day with under a cent left full', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => runs(14.4, 59.7, 15.9));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    expect(rendered(tree)).toMatch(/SENİN SIRAN 90 km\s+· bugün/);
    expect(findWith(tree, 'label', '+10', 'onPress')).toBeDefined();
    expect(rendered(tree)).not.toContain('Günlük tavan doldu');

    // 5,375 + 94,62 is 99,995: printed "100 km · bugün", every chip over what is left
    api.challenge = jest.fn(async () => runs(5.375, 94.62));
    const full = renderScreen(<ChallengeScreen />);
    await settle();

    expect(rendered(full)).toMatch(/SENİN SIRAN 100 km\s+· bugün/);
    expect(() => findWith(full, 'label', '+1', 'onPress')).toThrow();
    expect(rendered(full)).toMatch(/Günlük tavan doldu \(\s*100\s+km\s*\)\./);
  });

  it('fills the field from the chips without float noise', async () => {
    searchParams.id = 'c-1';
    // 100 - (50,3 + 7,4) is 42.300000000000004 in JavaScript
    api.challenge = jest.fn(async () => runs(50.3, 7.4));
    const EntryScreen = require('@/app/(app)/challenge/[id]/entry').default;
    const tree = renderScreen(<EntryScreen />);
    await settle();

    expect(rendered(tree)).toContain('Bugün için kalan: 42,3 km.');
    for (let i = 0; i < 5; i++) {
      act(() => {
        findWith(tree, 'label', '+10', 'onPress').props.onPress();
      });
    }
    expect(findWith(tree, 'placeholder', '0', 'onChangeText').props.value).toBe('42,3');
  });

  it('reads steps typed with a thousands dot as thousands, the way the app prints them', async () => {
    // "12.430" went in as 12,43 adım and lost the race to a friend's 9.000
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => challengeDetail());
    api.addEntry = jest.fn(async () => ({ entry: {}, standings: [] }));
    const EntryScreen = require('@/app/(app)/challenge/[id]/entry').default;
    const tree = renderScreen(<EntryScreen />);
    await settle();

    act(() => {
      findWith(tree, 'placeholder', '0', 'onChangeText').props.onChangeText('12.430');
    });
    await act(async () => {
      await findWith(tree, 'title', 'Kaydet', 'onPress').props.onPress();
    });
    await settle();

    expect(api.addEntry).toHaveBeenCalledWith('c-1', expect.objectContaining({ value: 12430 }));
    expect(rendered(tree)).toContain('12.430 adım · bugün');
  });

  it('says a step count has no fraction and sends nothing', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => challengeDetail());
    api.addEntry = jest.fn(async () => ({ entry: {}, standings: [] }));
    const EntryScreen = require('@/app/(app)/challenge/[id]/entry').default;
    const tree = renderScreen(<EntryScreen />);
    await settle();

    act(() => {
      findWith(tree, 'placeholder', '0', 'onChangeText').props.onChangeText('12,5');
    });
    await act(async () => {
      await findWith(tree, 'title', 'Kaydet', 'onPress').props.onPress();
    });
    await settle();

    expect(rendered(tree)).toContain('Küsurat olmaz, tam sayı yaz.');
    expect(api.addEntry).not.toHaveBeenCalled();
  });
});

describe('the screen-time card', () => {
  /** Mustafa in a screen-time çelınc that started `startsAgo` ms ago, nothing typed today. */
  function screenTime(startsAgo: number) {
    const detail = challengeDetail();
    return {
      ...detail,
      challenge: {
        ...detail.challenge,
        typeKey: 'ekran_suresi_beyani',
        metricType: 'manual_lower_is_better' as const,
        direction: 'lower' as const,
        unit: 'dk',
        startsAt: new Date(Date.now() - startsAgo).toISOString(),
      },
    };
  }

  it('says today joins the average once it is over', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => screenTime(2 * 86_400_000));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toMatch(/Girmediğin gün\s+1\.440\s+dk\s+sayılır;\s+bugün ise gün bitince ortalamana katılır\./);
    expect(text).not.toContain('ilk gün');
  });

  it('says a last day the end cuts goes in only before the end', async () => {
    searchParams.id = 'c-1';
    // 12:00 in Istanbul on a last day that ends at 15:59
    const NOW_AT = new Date('2026-09-10T09:00:00.000Z').getTime();
    jest.useFakeTimers({
      now: NOW_AT,
      doNotFake: [
        'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
        'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval',
        'clearInterval', 'setTimeout', 'clearTimeout',
      ],
    });
    try {
      const detail = screenTime(2 * 86_400_000);
      api.challenge = jest.fn(async () => ({
        ...detail,
        challenge: { ...detail.challenge, endsAt: '2026-09-10T12:59:59.999Z' },
      }));
      const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
      const tree = renderScreen(<ChallengeScreen />);
      await settle();

      const text = rendered(tree);
      expect(text).toMatch(/sayılır;\s+çelınc bugün bitiyor: bugünü saat 15:59 olmadan gir, sonra giremezsin\./);
      expect(text).not.toContain('gün bitince');
    } finally {
      jest.useRealTimers();
    }
  });

  it('says on day one that silence shows as the penalty, the way the standings show it', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => screenTime(0));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('bugün ilk gün, değerin gelene kadar 1.440 dk görünürsün.');
    expect(text).not.toContain('gün bitince');
  });
});

describe('a background refetch that fails', () => {
  /** Runs the 45 s poll by hand, now against whatever `api.challenge` does. */
  async function refetch(tree: ReactTestRenderer): Promise<void> {
    await act(async () => {
      await clientOf(tree).refetchQueries({ queryKey: ['challenge', 'c-1'] });
    });
    await settle();
  }

  it('keeps the çelınc on screen with a "son bilinen hali" line', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => challengeDetail());
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();
    expect(rendered(tree)).not.toContain('son bilinen hali');

    api.challenge = jest.fn(async () => {
      throw NETWORK_ERROR;
    });
    await refetch(tree);

    const text = rendered(tree);
    expect(text).toContain('Haftalık Adım');
    expect(text).toContain('SENİN SIRAN');
    expect(text).toContain('Sunucuya ulaşamıyorum, gördüğün son bilinen hali.');
    expect(text).toContain('Girişin sıraya alınır');
    expect(text).not.toContain('Çelınc gelmedi');

    // the line goes once the server answers again
    api.challenge = jest.fn(async () => challengeDetail());
    await refetch(tree);
    expect(rendered(tree)).not.toContain('son bilinen hali');
  });

  it('still says "Bu çelınc sende yok" when the server answers 404', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => challengeDetail());
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    api.challenge = jest.fn(async () => {
      throw new ApiError('not_found', 'Bulunamadı.', 404);
    });
    await refetch(tree);

    const text = rendered(tree);
    expect(text).toContain('Bu çelınc sende yok');
    expect(text).not.toContain('Haftalık Adım');
  });

  it('keeps the entry form and the value being typed', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => challengeDetail());
    const EntryScreen = require('@/app/(app)/challenge/[id]/entry').default;
    const tree = renderScreen(<EntryScreen />);
    await settle();
    act(() => {
      findWith(tree, 'placeholder', '0', 'onChangeText').props.onChangeText('8400');
    });

    api.challenge = jest.fn(async () => {
      throw NETWORK_ERROR;
    });
    await refetch(tree);

    const text = rendered(tree);
    expect(text).not.toContain('Giriş yapılamıyor');
    expect(text).toContain('son bilinen hali. Kaydedersen giriş sıraya alınır');
    expect(findWith(tree, 'placeholder', '0', 'onChangeText').props.value).toBe('8400');
    expect(findWith(tree, 'title', 'Kaydet', 'onPress').props.disabled).toBe(false);
  });
});

describe('a proof photo with no connection', () => {
  const { readQueue, removeFromQueue } = require('@/services/offlineQueue') as typeof import('@/services/offlineQueue');

  /** A run whose photo the creator made compulsory (the catalog's default for it). */
  function runDetail() {
    const detail = challengeDetail();
    return {
      ...detail,
      challenge: {
        ...detail.challenge,
        typeKey: 'kosu_km',
        metricType: 'manual_count' as const,
        unit: 'km',
        title: 'Koşu haftası',
        proofRequired: true,
      },
    };
  }

  afterEach(async () => {
    for (const item of await readQueue()) await removeFromQueue(item.id);
  });

  it('keeps the photo on the phone, lets Kaydet through and parks the entry with it', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => runDetail());
    api.uploadPhoto = jest.fn(async () => {
      throw NETWORK_ERROR;
    });
    api.addEntry = jest.fn(async () => {
      throw NETWORK_ERROR;
    });
    const EntryScreen = require('@/app/(app)/challenge/[id]/entry').default;
    const tree = renderScreen(<EntryScreen />);
    await settle();

    act(() => {
      findWith(tree, 'placeholder', '0', 'onChangeText').props.onChangeText('5,2');
    });
    await act(async () => {
      await findWith(tree, 'title', 'Galeri', 'onPress').props.onPress();
    });
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Fotoğraf telefonda');
    expect(text).toContain('Fotoğraf henüz gitmedi, telefonda bekliyor.');
    expect(text).not.toContain('Fotoğraf gitmedi');
    expect(findWith(tree, 'title', 'Kaydet', 'onPress').props.disabled).toBe(false);

    await act(async () => {
      await findWith(tree, 'title', 'Kaydet', 'onPress').props.onPress();
    });
    await settle();

    // the photo was tried once more on Kaydet; the entry never went without it
    expect(api.uploadPhoto).toHaveBeenCalledTimes(2);
    expect(api.addEntry).not.toHaveBeenCalled();
    const queue = await readQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ challengeId: 'c-1', proofLocalUri: mockPickedPhoto.uri });
    expect(queue[0]?.body).toMatchObject({ value: 5.2, source: 'manual' });
    expect(queue[0]?.body.proofUrl).toBeUndefined();
    expect(rendered(tree)).toContain('Sıraya alındı');
  });

  it("keeps the photo on the phone too while the owner's PC sleeps and the tunnel answers 530", async () => {
    const asleep = new ApiError('server_down', 'Sunucu şu an kapalı, uyuyor ya da adresi değişmiş.', 530);
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => runDetail());
    api.uploadPhoto = jest.fn(async () => {
      throw asleep;
    });
    api.addEntry = jest.fn(async () => {
      throw asleep;
    });
    const EntryScreen = require('@/app/(app)/challenge/[id]/entry').default;
    const tree = renderScreen(<EntryScreen />);
    await settle();

    act(() => {
      findWith(tree, 'placeholder', '0', 'onChangeText').props.onChangeText('5');
    });
    await act(async () => {
      await findWith(tree, 'title', 'Galeri', 'onPress').props.onPress();
    });
    await settle();

    expect(rendered(tree)).toContain('Fotoğraf telefonda');
    expect(rendered(tree)).not.toContain('Fotoğraf gitmedi');
    await act(async () => {
      await findWith(tree, 'title', 'Kaydet', 'onPress').props.onPress();
    });
    await settle();

    const queue = await readQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ challengeId: 'c-1', proofLocalUri: mockPickedPhoto.uri });
  });

  it('sends the photo first when the connection is back by Kaydet', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => runDetail());
    api.uploadPhoto = jest.fn(async () => {
      throw NETWORK_ERROR;
    });
    api.addEntry = jest.fn(async () => ({ entry: {}, standings: [] }));
    const EntryScreen = require('@/app/(app)/challenge/[id]/entry').default;
    const tree = renderScreen(<EntryScreen />);
    await settle();

    act(() => {
      findWith(tree, 'placeholder', '0', 'onChangeText').props.onChangeText('5');
    });
    await act(async () => {
      await findWith(tree, 'title', 'Galeri', 'onPress').props.onPress();
    });
    api.uploadPhoto = jest.fn(async () => ({ url: '/uploads/p1.jpg' }));
    await act(async () => {
      await findWith(tree, 'title', 'Kaydet', 'onPress').props.onPress();
    });
    await settle();

    expect(api.uploadPhoto).toHaveBeenCalledWith(mockPickedPhoto.uri, 'kanit-1.jpeg');
    expect(api.addEntry).toHaveBeenCalledWith('c-1', expect.objectContaining({ value: 5, proofUrl: '/uploads/p1.jpg' }));
    expect(JSON.stringify((api.addEntry as jest.Mock).mock.calls[0])).not.toContain('file://');
    expect(await readQueue()).toEqual([]);
  });

  it("says the server's disk is full when it answers by Kaydet, instead of parking the entry", async () => {
    const diskFull = 'Sunucunun diski dolmak üzere, şimdilik fotoğraf alınmıyor. Sunucuyu açan kankana haber ver.';
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => runDetail());
    api.uploadPhoto = jest.fn(async () => {
      throw NETWORK_ERROR;
    });
    api.addEntry = jest.fn(async () => ({ entry: {}, standings: [] }));
    const EntryScreen = require('@/app/(app)/challenge/[id]/entry').default;
    const tree = renderScreen(<EntryScreen />);
    await settle();

    act(() => {
      findWith(tree, 'placeholder', '0', 'onChangeText').props.onChangeText('5');
    });
    await act(async () => {
      await findWith(tree, 'title', 'Galeri', 'onPress').props.onPress();
    });
    api.uploadPhoto = jest.fn(async () => {
      throw new ApiError('disk_full', diskFull, 507);
    });
    await act(async () => {
      await findWith(tree, 'title', 'Kaydet', 'onPress').props.onPress();
    });
    await settle();

    // the connection is fine: no "bağlantı gelince", and nothing waits in the queue
    expect(rendered(tree)).toContain(diskFull);
    expect(rendered(tree)).not.toContain('Sıraya alındı');
    expect(api.addEntry).not.toHaveBeenCalled();
    expect(await readQueue()).toEqual([]);
  });
});

describe('a proof photo over the upload limit', () => {
  const { Platform } = require('react-native') as typeof import('react-native');
  let os: { restore: () => void } | null = null;

  /** A run with an optional photo. */
  function runDetail() {
    const detail = challengeDetail();
    return {
      ...detail,
      challenge: { ...detail.challenge, typeKey: 'kosu_km', metricType: 'manual_count' as const, unit: 'km', title: 'Koşu haftası' },
    };
  }

  async function pickFromGallery(): Promise<ReactTestRenderer> {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => runDetail());
    api.uploadPhoto = jest.fn(async () => ({ url: '/uploads/p1.jpg' }));
    const EntryScreen = require('@/app/(app)/challenge/[id]/entry').default;
    const tree = renderScreen(<EntryScreen />);
    await settle();
    await act(async () => {
      await findWith(tree, 'title', 'Galeri', 'onPress').props.onPress();
    });
    await settle();
    return tree;
  }

  beforeEach(() => {
    mockPickedPhoto.fileSize = LIMITS.UPLOAD_MAX_BYTES + 1;
  });

  afterEach(() => {
    mockPickedPhoto.fileSize = undefined;
    os?.restore();
    os = null;
  });

  it('is turned away before a long upload the server would refuse anyway', async () => {
    const tree = await pickFromGallery();

    expect(api.uploadPhoto).not.toHaveBeenCalled();
    const text = rendered(tree);
    expect(text).toContain('Fotoğraf çok büyük');
    expect(text).toContain("Bu fotoğraf 5 MB'tan büyük, sunucu almaz.");
    expect(text).not.toContain('Fotoğraf telefonda');
  });

  it("goes up on Android, where the picker reports the original's size from before it shrank the photo", async () => {
    os = jest.replaceProperty(Platform, 'OS', 'android');
    const tree = await pickFromGallery();

    expect(api.uploadPhoto).toHaveBeenCalledWith(mockPickedPhoto.uri, 'kanit-1.jpeg');
    expect(rendered(tree)).not.toContain('Fotoğraf çok büyük');
  });
});

describe('a check-in', () => {
  const { readQueue, removeFromQueue } = require('@/services/offlineQueue') as typeof import('@/services/offlineQueue');

  function checkinDetail() {
    const detail = challengeDetail();
    return {
      ...detail,
      challenge: {
        ...detail.challenge,
        typeKey: 'erken_kus',
        metricType: 'checkin_deadline' as const,
        unit: 'gün',
        title: 'Erken Kalkan Koyar',
        deadlineTime: '07:00',
      },
    };
  }

  beforeEach(() => {
    mockReminders.skipToday.mockClear();
  });

  afterEach(async () => {
    for (const item of await readQueue()) await removeFromQueue(item.id);
  });

  it('takes back today\'s 30-minutes-left poke once the server has it', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => checkinDetail());
    api.addEntry = jest.fn(async () => ({ entry: { value: 1, late: false }, standings: [] }));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    await act(async () => {
      await findWith(tree, 'title', 'Geldim', 'onPress').props.onPress();
    });
    await settle();

    expect(api.addEntry).toHaveBeenCalledWith('c-1', expect.objectContaining({ source: 'checkin' }));
    expect(mockReminders.skipToday).toHaveBeenCalledWith('c-1', expect.any(String));
  });

  it('keeps the poke and says the check-in is waiting when it is parked offline', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => checkinDetail());
    api.addEntry = jest.fn(async () => {
      throw NETWORK_ERROR;
    });
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    await act(async () => {
      await findWith(tree, 'title', 'Geldim', 'onPress').props.onPress();
    });
    await settle();

    expect(await readQueue()).toHaveLength(1);
    // the poke is what brings the app, and the queue, back before the deadline
    expect(mockReminders.skipToday).not.toHaveBeenCalled();
    expect(rendered(tree)).toContain('Check-in gitmedi, sırada');
    expect(rendered(tree)).toContain('Sunucu uyuyorsa bastığın saat sayılır');
    // the open app sends it by itself: the toast and the card both say so, and
    // neither tells someone looking at the app to open it
    expect(rendered(tree).split('Bağlantı gelince kendiliğinden gider').length - 1).toBe(2);
    expect(rendered(tree)).toContain('Geldim’e tekrar bas');
    expect(rendered(tree)).not.toContain('Bağlanınca uygulamayı aç');
    expect(rendered(tree)).not.toContain('Saatinde geldin');
    expect(rendered(tree)).not.toContain('Geldin!');
    // still a button: another try once there is signal
    expect(findWith(tree, 'title', 'Geldim', 'onPress').props.disabled).toBeFalsy();
  });

  it('keeps the first tap\'s time when the parked check-in is tapped again', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => checkinDetail());
    api.addEntry = jest.fn(async () => {
      throw NETWORK_ERROR;
    });
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    await act(async () => {
      await findWith(tree, 'title', 'Geldim', 'onPress').props.onPress();
    });
    await settle();
    const [first] = await readQueue();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await findWith(tree, 'title', 'Geldim', 'onPress').props.onPress();
    });
    await settle();

    const queue = await readQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.body.clientTime).toBe(first?.body.clientTime);
    const calls = (api.addEntry as jest.Mock).mock.calls as [string, { clientTime: string }][];
    expect(calls.map(([, sent]) => sent.clientTime)).toEqual([first?.body.clientTime, first?.body.clientTime]);
  });

  it('takes the parked check-in out of the queue when the next tap gets through', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => checkinDetail());
    let checkedIn = false;
    api.addEntry = jest
      .fn()
      .mockRejectedValueOnce(NETWORK_ERROR)
      .mockImplementation(async () => {
        if (checkedIn) throw new ApiError('already_checked_in', 'Bugün zaten check-in yaptın.', 409);
        checkedIn = true;
        return { entry: { value: 1, late: false }, standings: [] };
      });
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    await act(async () => {
      await findWith(tree, 'title', 'Geldim', 'onPress').props.onPress();
    });
    await settle();
    expect(await readQueue()).toHaveLength(1);

    await act(async () => {
      await findWith(tree, 'title', 'Geldim', 'onPress').props.onPress();
    });
    await settle();

    // replayed after it, the parked copy came back "already checked in" and
    // was told as a refused entry
    expect(api.addEntry).toHaveBeenCalledTimes(2);
    expect(await readQueue()).toEqual([]);
  });

  it('leaves the poke alone when the server turns the check-in down', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => checkinDetail());
    api.addEntry = jest.fn(async () => {
      throw new ApiError('checkin_too_early', 'Bu check-in saat 04:00 olmadan sayılmıyor. Biraz erken geldin.', 400);
    });
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    await act(async () => {
      await findWith(tree, 'title', 'Geldim', 'onPress').props.onPress();
    });
    await settle();

    expect(mockReminders.skipToday).not.toHaveBeenCalled();
  });

  it('drops last night\'s "sırada" once the day turns and the parked one has counted for that night', async () => {
    searchParams.id = 'c-1';
    const evening = new Date('2026-09-08T19:45:00.000Z').getTime(); // 22:45 in Istanbul
    // only the clock is faked: the query and settle() still need real timers
    jest.useFakeTimers({
      now: evening,
      doNotFake: [
        'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
        'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval',
        'clearInterval', 'setTimeout', 'clearTimeout',
      ],
    });
    try {
      api.challenge = jest.fn(async () => checkinDetail());
      api.addEntry = jest.fn(async () => {
        throw NETWORK_ERROR;
      });
      const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
      const tree = renderScreen(<ChallengeScreen />);
      await settle();
      await act(async () => {
        await findWith(tree, 'title', 'Geldim', 'onPress').props.onPress();
      });
      await settle();
      const QUEUED = 'Sunucu uyuyorsa bastığın saat sayılır';
      // under the button and in the toast
      const shown = () => rendered(tree).split(QUEUED).length - 1;
      expect(shown()).toBe(2);

      // The screen stayed open overnight. In the morning the queue sent it, and
      // it counted for last night; nothing waits for today.
      for (const item of await readQueue()) await removeFromQueue(item.id);
      jest.setSystemTime(evening + 10 * 60 * 60_000);
      const lastNight: Entry = {
        id: 'e-1', challengeId: 'c-1', userId: 'me-1', dayKey: '2026-09-08', value: 1, source: 'checkin',
        note: null, proofUrl: null, status: 'ok', createdAt: new Date(evening).toISOString(),
      };
      api.challenge = jest.fn(async () => ({ ...checkinDetail(), myEntries: [lastNight] }));
      await act(async () => {
        await clientOf(tree).invalidateQueries();
      });
      await settle();

      // only the toast of the tap, which goes by itself; not the line under today's button
      expect(shown()).toBe(1);
      expect(rendered(tree)).toContain('Check-in sadece bugün için sayılır.');
      expect(findWith(tree, 'title', 'Geldim', 'onPress').props.disabled).toBeFalsy();
    } finally {
      jest.useRealTimers();
    }
  });
});

/**
 * The morning check-in is pressed in the app the reminder opens, and the
 * owner's PC may be asleep then: the phone has only what it saw last. A
 * çelınc that was still `pending` then, or that the phone only has on disk
 * after a night killed, must still take the tap and park it.
 */
describe('a morning check-in with the server out of reach', () => {
  const { readQueue, removeFromQueue } = require('@/services/offlineQueue') as typeof import('@/services/offlineQueue');
  const { StorageKeys, getJson, setJson } = require('@/lib/storage') as typeof import('@/lib/storage');
  const { saveChallengeDetail } = require('@/services/savedDetails') as typeof import('@/services/savedDetails');

  /** Mustafa and Ali in an Erken Kalkan Koyar; `status` and `startsAt` as the phone last saw them. */
  function morning(options: { status?: 'pending' | 'active'; startsAgo?: number; aliSaidYes?: boolean } = {}) {
    const detail = challengeDetail();
    const yes = options.aliSaidYes ?? true;
    const ali = {
      ...detail.me,
      user: { ...detail.me.user, id: 'u-2', username: 'ali', displayName: 'Ali' },
      status: yes ? ('accepted' as const) : ('invited' as const),
      score: 0,
      rank: yes ? 1 : 0,
    };
    return {
      ...detail,
      challenge: {
        ...detail.challenge,
        typeKey: 'erken_kus',
        metricType: 'checkin_deadline' as const,
        unit: 'gün',
        title: 'Erken Kalkan Koyar',
        deadlineTime: '07:00',
        status: options.status ?? ('pending' as const),
        startsAt: new Date(Date.now() - (options.startsAgo ?? 2 * 3_600_000)).toISOString(),
      },
      participants: [detail.me, ali],
    };
  }

  /** Every "Geldim" a finger could press. */
  function geldim(tree: ReactTestRenderer) {
    return tree.root.findAll((node) => node.props.title === 'Geldim' && typeof node.props.onPress === 'function');
  }

  async function refetch(tree: ReactTestRenderer): Promise<void> {
    await act(async () => {
      await clientOf(tree).refetchQueries({ queryKey: ['challenge', 'c-1'] });
    });
    await settle();
  }

  beforeEach(async () => {
    // the account the phone has stored, as after a sign-in
    await setJson(StorageKeys.me, ME);
  });

  afterEach(async () => {
    for (const item of await readQueue()) await removeFromQueue(item.id);
    await AsyncStorage.multiRemove([StorageKeys.me, StorageKeys.savedDetails]);
  });

  it('parks the "Geldim" of a çelınc the server has not started yet', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => morning());
    api.addEntry = jest.fn(async () => {
      throw NETWORK_ERROR;
    });
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();
    api.challenge = jest.fn(async () => {
      throw NETWORK_ERROR;
    });
    await refetch(tree);

    const text = rendered(tree);
    expect(text).toContain('Sunucuya ulaşamıyorum, gördüğün son bilinen hali.');
    expect(text).toContain('Girişin sıraya alınır');
    expect(text).toContain('Başlamış olmalı, sunucuya ulaşınca burada da görünür.');
    expect(text).not.toContain('KABUL BEKLENİYOR');
    expect(text).not.toContain('Başlayana kadar giriş yapılamaz');
    expect(geldim(tree)).toHaveLength(1);

    await act(async () => {
      await geldim(tree)[0]!.props.onPress();
    });
    await settle();

    const queue = await readQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ challengeId: 'c-1', body: { source: 'checkin', value: 1 } });
    expect(rendered(tree)).toContain('Check-in gitmedi, sırada');
  });

  it('does not blame the server or the signal when its fresh answer was only a few seconds early', async () => {
    searchParams.id = 'c-1';
    // the phone's clock a little ahead of the server's: its "pending" was right when it left
    api.challenge = jest.fn(async () => morning({ startsAgo: 5_000 }));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Başlamış olmalı, birazdan burada da görünür.');
    expect(text).not.toContain('sunucuya ulaşınca');
    expect(text).not.toContain('Sunucuya ulaşamıyorum');
    expect(geldim(tree)).toHaveLength(1);
  });

  it('still waits for a second yes when nobody else said one', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => morning({ aliSaidYes: false }));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();
    api.challenge = jest.fn(async () => {
      throw NETWORK_ERROR;
    });
    await refetch(tree);

    const text = rendered(tree);
    expect(text).toMatch(/KABUL BEKLENİYOR 1 ?\/2 kişi/);
    expect(text).toContain('Başlayana kadar giriş yapılamaz.');
    expect(text).not.toContain('Başlamış olmalı');
    expect(geldim(tree)).toHaveLength(0);
  });

  it('keeps the detail it read on the phone for the next start', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => morning({ status: 'active' }));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    renderScreen(<ChallengeScreen />);
    await settle();

    const stored = await getJson<{ ownerId: string; details: { challenge: { id: string } }[] }>(StorageKeys.savedDetails);
    expect(stored?.ownerId).toBe('me-1');
    expect(stored?.details.map((detail) => detail.challenge.id)).toEqual(['c-1']);
  });

  it('opens cold from the copy on the phone and parks the tap in the çelınc\'s own zone', async () => {
    searchParams.id = 'c-1';
    // 15:00 in Istanbul on the 9th is already 02:00 on the 10th on Kiritimati
    const now = new Date('2026-09-09T12:00:00.000Z').getTime();
    // only the clock is faked: the query and settle() still need real timers
    jest.useFakeTimers({
      now,
      doNotFake: [
        'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
        'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval',
        'clearInterval', 'setTimeout', 'clearTimeout',
      ],
    });
    try {
      // what the phone saw last night, before it killed the app
      await saveChallengeDetail({ ...morning({ status: 'active' }), myTimezone: 'Pacific/Kiritimati' } as never);
      api.challenge = jest.fn(async () => {
        throw NETWORK_ERROR;
      });
      api.addEntry = jest.fn(async () => {
        throw NETWORK_ERROR;
      });
      const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
      const tree = renderScreen(<ChallengeScreen />);
      await settle();

      const text = rendered(tree);
      expect(api.challenge).toHaveBeenCalled();
      expect(text).toContain('Erken Kalkan Koyar');
      expect(text).toContain('Sunucuya ulaşamıyorum, gördüğün son bilinen hali.');
      expect(text).not.toContain('Çelınc gelmedi');
      expect(geldim(tree)).toHaveLength(1);

      await act(async () => {
        await geldim(tree)[0]!.props.onPress();
      });
      await settle();

      const [parked] = await readQueue();
      expect(parked?.body).toMatchObject({
        source: 'checkin',
        dayKey: '2026-09-10',
        clientTime: '2026-09-09T12:00:00.000Z',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it("never draws another account's çelınc from the phone", async () => {
    searchParams.id = 'c-1';
    await saveChallengeDetail(morning({ status: 'active' }) as never);
    // Mustafa signed out, Veli signed in on the same phone
    await setJson(StorageKeys.me, { ...ME, id: 'u-3', username: 'veli' });
    api.challenge = jest.fn(async () => {
      throw NETWORK_ERROR;
    });
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Çelınc gelmedi');
    expect(text).not.toContain('Erken Kalkan Koyar');
  });

  it('keeps a copy of a check-in said yes to on the home card, for the morning it opens cold', async () => {
    const { getJson: readStored } = require('@/lib/storage') as typeof import('@/lib/storage');
    // Mustafa's "Yarın 04:00", Ali already in, the reader still invited
    const later = morning({ startsAgo: -5 * 3_600_000 });
    const invited = { ...later.me, status: 'invited' as const, score: 0, rank: 0 };
    const [, ali] = later.participants;
    api.challenges = jest.fn(async () => [
      { challenge: later.challenge, participants: [invited, ali], me: invited, unreadTaunts: 0 },
    ]);
    // the server answers a yes with the refreshed detail
    api.acceptChallenge = jest.fn(async () => later);
    api.challenge = jest.fn(async () => {
      throw NETWORK_ERROR;
    });
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const home = renderScreen(<HomeScreen />);
    await settle();

    press(home, 'Kabul');
    await settle();
    expect(api.acceptChallenge).toHaveBeenCalledWith('c-1');
    const stored = await readStored<{ details: { challenge: { id: string }; me: { status: string } }[] }>(
      StorageKeys.savedDetails
    );
    expect(stored?.details.map((detail) => [detail.challenge.id, detail.me.status])).toEqual([['c-1', 'accepted']]);

    // the next morning, the app killed in the night and the PC asleep
    searchParams.id = 'c-1';
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const cold = renderScreen(<ChallengeScreen />);
    await settle();
    expect(rendered(cold)).toContain('Erken Kalkan Koyar');
    expect(rendered(cold)).not.toContain('Çelınc gelmedi');
  });

  it('home says a çelınc with its two yeses is starting, not waiting for one', async () => {
    const { challenge, participants, me } = morning();
    api.challenges = jest.fn(async () => [{ challenge, participants, me, unreadTaunts: 0 }]);
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const tree = renderScreen(<HomeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('🚦 başlıyor');
    expect(text).not.toContain('kabul bekleniyor');
  });

  /** Mustafa's running Erken Kalkan Koyar as the phone kept it, under a name no catalog has. */
  function keptCopy() {
    const detail = morning({ status: 'active' });
    return { ...detail, challenge: { ...detail.challenge, title: 'Sabah testi' } };
  }

  const ASLEEP = new ApiError('server_down', 'Sunucu şu an kapalı, uyuyor ya da adresi değişmiş.', 530);

  // opened from the launcher, not the reminder: home was the dead end, and a
  // parked tap counts from when it was pressed, so waiting cost the morning
  it('lists the check-ins kept on the phone when the list does not come, and opens them', async () => {
    const { router } = require('expo-router') as { router: Record<string, jest.Mock> };
    router.push!.mockClear();
    await saveChallengeDetail(keptCopy() as never);
    api.challenges = jest.fn(async () => {
      throw ASLEEP;
    });
    api.challenge = jest.fn(async () => {
      throw ASLEEP;
    });
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const home = renderScreen(<HomeScreen />);
    await settle();

    const text = rendered(home);
    expect(text).toContain('Liste gelmedi');
    expect(text).toContain('SON BİLİNEN HALİ');
    // never passed off as the whole list
    expect(text).toContain('Sadece telefonda saklı check-in çelıncların');
    expect(text).toContain('Sabah testi');

    const [card] = home.root.findAll(
      (node) => node.props.summary?.challenge?.id === 'c-1' && typeof node.props.onPress === 'function'
    );
    act(() => {
      card!.props.onPress();
    });
    expect(router.push).toHaveBeenCalledWith({ pathname: '/challenge/[id]', params: { id: 'c-1' } });

    // where it leads draws the same copy, with a "Geldim" to park
    searchParams.id = 'c-1';
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const screen = renderScreen(<ChallengeScreen />);
    await settle();
    expect(rendered(screen)).toContain('Sabah testi');
    expect(geldim(screen)).toHaveLength(1);
  });

  it('keeps the copies off a home that has its list', async () => {
    await saveChallengeDetail(keptCopy() as never);
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const tree = renderScreen(<HomeScreen />);
    await settle();
    expect(rendered(tree)).not.toContain('SON BİLİNEN HALİ');

    // a refetch that fails keeps the list it had: that is the list, not these
    api.challenges = jest.fn(async () => {
      throw ASLEEP;
    });
    await act(async () => {
      await clientOf(tree).refetchQueries({ queryKey: ['challenges'] });
    });
    await settle();
    expect(api.challenges).toHaveBeenCalled();
    expect(rendered(tree)).toContain('Liste gelmedi');
    expect(rendered(tree)).not.toContain('SON BİLİNEN HALİ');
    expect(rendered(tree)).not.toContain('Sabah testi');
  });

  it("never lists another account's copies on home", async () => {
    // Veli's, left on the phone; Mustafa is the one signed in
    await setJson(StorageKeys.savedDetails, { ownerId: 'u-3', details: [keptCopy()] });
    api.challenges = jest.fn(async () => {
      throw ASLEEP;
    });
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const tree = renderScreen(<HomeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Liste gelmedi');
    expect(text).not.toContain('SON BİLİNEN HALİ');
    expect(text).not.toContain('Sabah testi');
  });

  // the çelınc screen's "+ Giriş" and "Odak seansı" open these: refusing there
  // what the screen just offered left a typed count or a session nowhere to go
  it('takes the entry form and the focus timer for it too, not only the check-in', async () => {
    searchParams.id = 'c-1';
    const counted = (options: { aliSaidYes?: boolean } = {}) => {
      const detail = morning(options);
      return {
        ...detail,
        challenge: {
          ...detail.challenge,
          typeKey: 'su_bardak',
          metricType: 'manual_count' as const,
          unit: 'bardak',
          deadlineTime: null,
          proofRequired: true,
        },
      };
    };
    api.challenge = jest.fn(async () => counted());
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const screen = renderScreen(<ChallengeScreen />);
    await settle();
    expect(findWith(screen, 'title', '+ Giriş', 'onPress')).toBeDefined();

    const EntryScreen = require('@/app/(app)/challenge/[id]/entry').default;
    const entry = renderScreen(<EntryScreen />);
    await settle();
    expect(rendered(entry)).not.toContain('aktif değil');
    expect(findWith(entry, 'title', 'Kaydet', 'onPress').props.disabled).toBe(false);

    api.challenge = jest.fn(async () => counted({ aliSaidYes: false }));
    const waiting = renderScreen(<EntryScreen />);
    await settle();
    expect(rendered(waiting)).toContain('Bu çelınc şu an aktif değil, giriş kabul edilmiyor.');

    const detail = morning();
    api.challenge = jest.fn(async () => ({
      ...detail,
      challenge: { ...detail.challenge, typeKey: 'odak_seansi', metricType: 'focus_minutes' as const, unit: 'dk', deadlineTime: null },
    }));
    const FocusScreen = require('@/app/(app)/focus/[id]').default;
    const focus = renderScreen(<FocusScreen />);
    await settle();
    expect(rendered(focus)).not.toContain('aktif değil');
    expect(findWith(focus, 'title', 'Başlat', 'onPress').props.disabled).toBe(false);
  });
});

describe('a yes/no day', () => {
  // ME.timezone is unusable, so the screens fall back to the device zone
  const today = () => todayKey('Europe/Istanbul');

  function smokeFree(myEntries: Entry[] = []) {
    const detail = challengeDetail();
    return {
      ...detail,
      challenge: {
        ...detail.challenge,
        typeKey: 'sigara_yok',
        metricType: 'daily_boolean' as const,
        unit: 'gün',
        title: 'Dumansız Günler',
      },
      myEntries,
    };
  }

  function mark(dayKey: string, value: 0 | 1): Entry {
    return {
      id: `e-${dayKey}`,
      challengeId: 'c-1',
      userId: 'me-1',
      dayKey,
      value,
      source: 'manual',
      note: null,
      proofUrl: null,
      status: 'ok',
      createdAt: new Date().toISOString(),
    };
  }

  /** Every button with this title, today's row first. */
  function buttons(tree: ReactTestRenderer, title: string) {
    return tree.root.findAll((node) => node.props.title === title && typeof node.props.onPress === 'function');
  }

  it('asks whether the day went smoke-free and answers "İçmedim" / "İçtim", never "Yapmadım"', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => smokeFree());
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Günün dumansız geçti mi?');
    expect(text).toContain('İÇMEDİM ✅');
    expect(text).toContain('İÇTİM ❌');
    expect(text).not.toContain('YAPMADIM');
    expect(text).not.toContain('YAPTIM');
    expect(text).toContain('DÜN (BOŞ KALMIŞ)');
  });

  it('counts "İçmedim" as the clean day: it sends a 1', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => smokeFree());
    api.addEntry = jest.fn(async () => ({ entry: mark(today(), 1), standings: [] }));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    await act(async () => {
      await buttons(tree, 'İçmedim ✅')[0]!.props.onPress();
    });
    await settle();

    expect(api.addEntry).toHaveBeenCalledWith('c-1', expect.objectContaining({ dayKey: today(), value: 1, source: 'manual' }));
    expect(rendered(tree)).toContain('Gün senin lehine yazıldı.');
  });

  it('keeps yesterday on screen once answered, with its answer, so a wrong tap can be put right', async () => {
    searchParams.id = 'c-1';
    const yesterday = addDays(today(), -1);
    api.challenge = jest.fn(async () => smokeFree([mark(yesterday, 0)]));
    api.addEntry = jest.fn(async () => ({ entry: mark(yesterday, 1), standings: [] }));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('DÜN');
    expect(text).not.toContain('BOŞ KALMIŞ');
    // yesterday's chip, and its "İçtim" lit up while today's is not
    expect(tree.root.findAll((node) => node.props.label === 'İÇTİM' && node.props.filled === true)).toHaveLength(1);
    const smoked = buttons(tree, 'İçtim ❌');
    expect(smoked.map((button) => button.props.variant)).toEqual(['secondary', 'danger']);

    await act(async () => {
      await buttons(tree, 'İçmedim ✅')[1]!.props.onPress();
    });
    await settle();

    expect(api.addEntry).toHaveBeenCalledWith('c-1', expect.objectContaining({ dayKey: yesterday, value: 1 }));
  });

  it('shows a day an itiraz threw out as gone, with no buttons to tap', async () => {
    searchParams.id = 'c-1';
    const thrownOut = { ...mark(today(), 1), status: 'rejected' as const };
    api.challenge = jest.fn(async () => smokeFree([thrownOut]));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('İTİRAZLA DÜŞTÜ');
    expect(text).toContain('Kankalar bu güne itiraz etti, gün sayılmıyor.');
    // outlined: filled, the chip wrote white on the faint grey, which white does not read on
    const [dropped] = tree.root.findAll((node) => node.props.label === 'İTİRAZLA DÜŞTÜ');
    expect(dropped!.props.filled).toBeFalsy();
    // the row for today has no answer buttons left; only the empty yesterday row could have any
    expect(buttons(tree, 'İçmedim ✅').length).toBeLessThanOrEqual(1);
  });
});

describe('a çelınc joined in another zone than the account has now', () => {
  // Joined in Istanbul, then a login in Tokyo moved the profile there. 01:30 on
  // the 3rd in Tokyo is 19:30 on the 2nd in Istanbul, and the server reads the
  // çelınc in Istanbul: the 3rd is "Gelecek bir gün" to it.
  const NOW = new Date('2027-01-02T16:30:00.000Z').getTime();
  const PINNED_TODAY = '2027-01-02';

  /** The same çelınc of `challengeDetail`, as the server reads it for this reader. */
  function pinned(challenge: Record<string, unknown>) {
    const detail = challengeDetail();
    return {
      ...detail,
      challenge: { ...detail.challenge, ...challenge },
      myTimezone: 'Europe/Istanbul',
    };
  }

  beforeEach(() => {
    // only the clock is faked: the query and settle() still need real timers
    jest.useFakeTimers({
      now: NOW,
      doNotFake: [
        'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
        'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval',
        'clearInterval', 'setTimeout', 'clearTimeout',
      ],
    });
    ME.timezone = 'Asia/Tokyo';
    mockReminders.skipToday.mockClear();
  });

  afterEach(async () => {
    ME.timezone = 'Mars/Olympus';
    jest.useRealTimers();
    const { saveSession } = require('@/services/focus') as typeof import('@/services/focus');
    await act(async () => {
      await saveSession(null);
    });
  });

  it('checks in for the day the çelınc is on, and takes back that day\'s poke', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () =>
      pinned({ typeKey: 'erken_yat', metricType: 'checkin_deadline', unit: 'gün', deadlineTime: '23:00' })
    );
    api.addEntry = jest.fn(async () => ({ entry: { value: 1, late: false }, standings: [] }));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    await act(async () => {
      await findWith(tree, 'title', 'Geldim', 'onPress').props.onPress();
    });
    await settle();

    expect(api.addEntry).toHaveBeenCalledWith(
      'c-1',
      expect.objectContaining({ dayKey: PINNED_TODAY, source: 'checkin' })
    );
    expect(mockReminders.skipToday).toHaveBeenCalledWith('c-1', 'Europe/Istanbul');
  });

  it('answers "Bugün" of a yes/no çelınc for that day too', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () =>
      pinned({ typeKey: 'sigara_yok', metricType: 'daily_boolean', unit: 'gün', title: 'Dumansız Günler' })
    );
    api.addEntry = jest.fn(async () => ({ entry: null, standings: [] }));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const [todayYes] = tree.root.findAll(
      (node) => node.props.title === 'İçmedim ✅' && typeof node.props.onPress === 'function'
    );
    await act(async () => {
      await todayYes!.props.onPress();
    });
    await settle();

    expect(api.addEntry).toHaveBeenCalledWith('c-1', expect.objectContaining({ dayKey: PINNED_TODAY, value: 1 }));
  });

  it('writes a typed count to that day from the entry modal', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => pinned({ typeKey: 'su_bardak', metricType: 'manual_count', unit: 'bardak' }));
    api.addEntry = jest.fn(async () => ({ entry: null, standings: [] }));
    const EntryScreen = require('@/app/(app)/challenge/[id]/entry').default;
    const tree = renderScreen(<EntryScreen />);
    await settle();

    act(() => {
      findWith(tree, 'placeholder', '0', 'onChangeText').props.onChangeText('3');
    });
    await act(async () => {
      await findWith(tree, 'title', 'Kaydet', 'onPress').props.onPress();
    });
    await settle();

    expect(api.addEntry).toHaveBeenCalledWith('c-1', expect.objectContaining({ dayKey: PINNED_TODAY, value: 3 }));
  });

  it('posts a finished focus session to that day', async () => {
    const { createSession, saveSession, tick } = require('@/services/focus') as typeof import('@/services/focus');
    // 45 minutes that ran out just now, waiting to be posted
    const startedAt = NOW - 45 * 60_000;
    await saveSession(tick(createSession('c-1', 45, 'session-1', startedAt), NOW));
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => pinned({ typeKey: 'odak_seansi', metricType: 'focus_minutes', unit: 'dk' }));
    api.addEntry = jest.fn(async () => ({ entry: null, standings: [] }));
    const FocusScreen = require('@/app/(app)/focus/[id]').default;
    renderScreen(<FocusScreen />);
    await settle();

    expect(api.addEntry).toHaveBeenCalledWith(
      'c-1',
      expect.objectContaining({ dayKey: PINNED_TODAY, value: 45, source: 'focus', sessionId: 'session-1' })
    );
  });
});

describe('a long title on a narrow phone', () => {
  it('gives the title four lines and puts the status chip under it', async () => {
    searchParams.id = 'c-1';
    const detail = challengeDetail();
    // as long as a title may be (LIMITS.CHALLENGE_TITLE_MAX): two lines beside the chip cut it at 360 dp
    detail.challenge.title = 'Sigarayı bırakıyoruz, bu sefer gerçekten';
    expect(detail.challenge.title).toHaveLength(LIMITS.CHALLENGE_TITLE_MAX);
    api.challenge = jest.fn(async () => detail);

    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const [title] = tree.root.findAll(
      (node) => typeof node.type === 'string' && node.props.children === detail.challenge.title
    );
    expect(title!.props.numberOfLines).toBe(4);
    const [chip] = tree.root.findAll((node) => node.props.label === 'AKTİF');
    const body = closestHolding(chip!, detail.challenge.title);
    expect(StyleSheet.flatten(body.props.style)?.flexDirection ?? 'column').toBe('column');
  });
});

describe('an itiraz on the feed', () => {
  const ALI = { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };

  /** Mustafa (the reader) and Ali, one entry each; `disputedBy` disputes the other one's entry. */
  function withDispute(disputedBy: 'me' | 'ali') {
    const detail = challengeDetail();
    const rival = { ...detail.me!, user: ALI, score: 9000, rank: 2 };
    detail.participants = [detail.me!, rival];
    const owner = disputedBy === 'me' ? ALI : detail.me!.user;
    // half a minute of slack so the rendered "5sa 20dk" does not depend on how fast the suite runs
    const answerBy = new Date(Date.now() + 5 * 3_600_000 + 20 * 60_000 + 30_000).toISOString();
    return {
      ...detail,
      feed: [
        {
          id: 'e-1',
          userId: owner.id,
          displayName: owner.displayName,
          dayKey: '2026-09-08',
          value: 25000,
          source: 'manual' as const,
          status: 'disputed' as const,
          createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
          proofUrl: null,
          answerBy,
        },
      ],
      disputes: [
        {
          id: 'd-1',
          entryId: 'e-1',
          byUserId: disputedBy === 'me' ? 'me-1' : ALI.id,
          reason: disputedBy === 'me' ? 'Telefonu köpeğe bağlamış' : 'Bütün gün koltuktaydı',
          status: 'open' as const,
          createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
        },
      ],
    };
  }

  it('shows the disputer the reason, the clock, and a "Geri çek" chip that takes it back', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => withDispute('me'));
    api.withdrawDispute = jest.fn(async () => ({ entry: {}, standings: [] }));
    const { Alert } = require('react-native') as typeof import('react-native');
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.[1]?.onPress?.();
    });

    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Mustafa: “Telefonu köpeğe bağlamış”');
    expect(text).toContain('5sa 20dk içinde kanıt gelmezse yanar');
    expect(text).not.toContain('İtiraz var, bakılıyor');
    expect(text).not.toContain('İtiraz ettin');

    await act(async () => {
      findWith(tree, 'label', 'Geri çek', 'onPress').props.onPress();
    });
    await settle();
    expect(api.withdrawDispute).toHaveBeenCalledWith('c-1', 'e-1');
    alert.mockRestore();
  });

  it('shows the owner who said what, and a "Kanıt ekle" chip that opens the photo sheet', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => withDispute('ali'));

    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Ali: “Bütün gün koltuktaydı”');
    expect(text).toContain('içinde kanıt eklemezsen yanar');
    expect(text).not.toContain('Geri çek');

    act(() => {
      findWith(tree, 'label', 'Kanıt ekle', 'onPress').props.onPress();
    });
    const sheet = rendered(tree);
    expect(sheet).toContain('Fotoğrafı koy, itiraz kapansın');
    expect(sheet).toContain('GALERİ'); // button titles render in Turkish capitals
  });

  it('keeps no photo for later in "Kanıt ekle": an answer to an itiraz has no queue behind it', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => withDispute('ali'));
    api.uploadPhoto = jest.fn(async () => {
      throw NETWORK_ERROR;
    });
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    act(() => {
      findWith(tree, 'label', 'Kanıt ekle', 'onPress').props.onPress();
    });
    await act(async () => {
      await findWith(tree, 'title', 'Galeri', 'onPress').props.onPress();
    });
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Fotoğraf gitmedi');
    expect(text).not.toContain('Fotoğraf telefonda');
    // nothing picked: the sheet still offers the camera and the gallery
    expect(text).toContain('GALERİ');
  });

  it('lets the friend who won the itiraz question the phone reading that took the day back', async () => {
    searchParams.id = 'c-1';
    const detail = withDispute('me');
    detail.feed[0] = { ...detail.feed[0]!, source: 'health_connect' as 'manual', status: 'ok' as 'disputed', answerBy: null as unknown as string };
    detail.disputes[0] = { ...detail.disputes[0]!, status: 'upheld' as 'open' };
    api.challenge = jest.fn(async () => detail);

    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();
    expect(rendered(tree)).not.toContain('İtiraz ettin');
    expect(findWith(tree, 'label', 'Yalan Bu', 'onPress')).toBeTruthy();
  });

  it('says no majority yet instead of a clock when nobody is on one', async () => {
    searchParams.id = 'c-1';
    const detail = withDispute('ali');
    detail.feed[0]!.answerBy = null as unknown as string;
    api.challenge = jest.fn(async () => detail);

    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();
    expect(rendered(tree)).toContain('İtiraz var ama henüz çoğunluk değil.');
  });

  it('counts the itirazlar below the majority when the server sends them', async () => {
    searchParams.id = 'c-1';
    const detail = withDispute('ali');
    detail.feed[0] = { ...detail.feed[0]!, answerBy: null as unknown as string, disputeVotes: { open: 1, needed: 5 } } as typeof detail.feed[0];
    api.challenge = jest.fn(async () => detail);

    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();
    const text = rendered(tree);
    expect(text).toContain('İtiraz 1/5. 4 kişi daha itiraz ederse 12 saatlik kanıt süresi başlar.');
    expect(text).not.toContain('henüz çoğunluk değil');
  });

  it('tells the disputer the others heard of it when one itiraz is not a majority', async () => {
    searchParams.id = 'c-1';
    const detail = withDispute('me');
    detail.feed[0] = { ...detail.feed[0]!, status: 'ok' as 'disputed', answerBy: null as unknown as string };
    detail.disputes = [];
    api.challenge = jest.fn(async () => detail);
    api.disputeEntry = jest.fn(async () => ({ entry: {}, answerBy: null, othersCalled: 3, standings: [] }));

    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();
    act(() => {
      findWith(tree, 'label', 'Yalan Bu', 'onPress').props.onPress();
    });
    typeInto(tree, 'Neden yalan?', 'yirmi beş bin mi');
    await act(async () => {
      await findWith(tree, 'title', 'İtirazı gönder', 'onPress').props.onPress();
    });
    await settle();

    expect(api.disputeEntry).toHaveBeenCalledWith('c-1', 'e-1', 'yirmi beş bin mi');
    const text = rendered(tree);
    expect(text).toContain('3 kankaya haber gitti. Çoğunluk itiraz ederse sahibinin 12 saati başlar.');
    expect(text).not.toContain('Kankalar bakacak.');
  });

  it.each([
    ['the server called nobody', { othersCalled: 0 }],
    // a server from before the call: it told only the owner, and sends no count
    ['an older server sends no count', {}],
  ])('does not claim anybody heard of it when %s', async (_case, count) => {
    searchParams.id = 'c-1';
    const detail = withDispute('me');
    detail.feed[0] = { ...detail.feed[0]!, status: 'ok' as 'disputed', answerBy: null as unknown as string };
    detail.disputes = [];
    api.challenge = jest.fn(async () => detail);
    api.disputeEntry = jest.fn(async () => ({ entry: {}, answerBy: null, standings: [], ...count }));

    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();
    act(() => {
      findWith(tree, 'label', 'Yalan Bu', 'onPress').props.onPress();
    });
    typeInto(tree, 'Neden yalan?', 'yirmi beş bin mi');
    await act(async () => {
      await findWith(tree, 'title', 'İtirazı gönder', 'onPress').props.onPress();
    });
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Çoğunluk itiraz ederse sahibinin 12 saati başlar.');
    expect(text).not.toContain('haber gitti');
  });

  /**
   * Beside the body a chip took 80-100 px of a 360 dp phone, and at a larger
   * font the name before the score shrank to "G…". Jest cannot measure that,
   * so it pins where the chip goes: in the column under the name, not in the
   * row beside it.
   */
  it.each([
    ['the itiraz button', 'Yalan Bu', 'Ali'],
    ['"Geri çek"', 'Geri çek', 'Ali'],
    ['"Kanıt ekle"', 'Kanıt ekle', 'Mustafa (sen)'],
  ])('puts %s under the entry, so the name keeps the row', async (_case, label, name) => {
    searchParams.id = 'c-1';
    const detail = withDispute(label === 'Kanıt ekle' ? 'ali' : 'me');
    if (label === 'Yalan Bu') {
      detail.feed[0] = { ...detail.feed[0]!, status: 'ok' as 'disputed', answerBy: null as unknown as string };
      detail.disputes = [];
    }
    api.challenge = jest.fn(async () => detail);

    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const body = closestHolding(findWith(tree, 'label', label, 'onPress'), name);
    expect(StyleSheet.flatten(body.props.style)?.flexDirection ?? 'column').toBe('column');
  });

  const CAN = { id: 'u-3', username: 'can', displayName: 'Can', avatarEmoji: '🦉', createdAt: '2026-09-01T00:00:00.000Z' };

  /** One plain typed row each from Ali (in), Mustafa (the reader, `mine`) and Can (`his`). */
  function withThreeRows(mine: 'accepted' | 'invited' | 'left', his: 'accepted' | 'left') {
    const detail = challengeDetail();
    const reader = { ...detail.me!, status: mine };
    const rival = { ...detail.me!, user: ALI, score: 9000, rank: 2 };
    const can = { ...detail.me!, user: CAN, status: his, score: 0, rank: 0 };
    const row = (id: string, user: typeof ALI, value: number) => ({
      id,
      userId: user.id,
      displayName: user.displayName,
      dayKey: '2026-09-08',
      value,
      source: 'manual' as const,
      status: 'ok' as const,
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      proofUrl: null,
    });
    return {
      ...detail,
      participants: [reader, rival, can],
      me: reader,
      feed: [row('e-1', ALI, 11111), row('e-2', detail.me!.user, 22222), row('e-3', CAN, 33333)],
    };
  }

  /** The pressable chips labelled `label` ("Yalan Bu" is level 2's itiraz). */
  function chips(tree: ReactTestRenderer, label: string) {
    return tree.root.findAll((node) => node.props.label === label && typeof node.props.onPress === 'function');
  }

  it.each(['invited', 'left'] as const)(
    'offers an "%s" reader neither an itiraz nor "Sil": the server would answer both "Bu çelınca katılmadın."',
    async (mine) => {
      searchParams.id = 'c-1';
      api.challenge = jest.fn(async () => withThreeRows(mine, 'accepted'));
      const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
      const tree = renderScreen(<ChallengeScreen />);
      await settle();

      // the rows are all there to look at
      const text = rendered(tree);
      expect(text).toContain('11.111 adım');
      expect(text).toContain('22.222 adım');
      expect(chips(tree, 'Yalan Bu')).toHaveLength(0);
      expect(chips(tree, 'Sil')).toHaveLength(0);
    }
  );

  it('offers no itiraz on the row of a player who left, and still one on a rival\'s', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => withThreeRows('accepted', 'left'));
    api.disputeEntry = jest.fn(async () => ({ entry: {}, answerBy: null, othersCalled: 0, standings: [] }));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    expect(rendered(tree)).toContain('33.333 adım');
    expect(chips(tree, 'Yalan Bu')).toHaveLength(1);
    expect(chips(tree, 'Sil')).toHaveLength(1);
    act(() => {
      chips(tree, 'Yalan Bu')[0]!.props.onPress();
    });
    typeInto(tree, 'Neden yalan?', 'on bir bin mi');
    await act(async () => {
      await findWith(tree, 'title', 'İtirazı gönder', 'onPress').props.onPress();
    });
    expect(api.disputeEntry).toHaveBeenCalledWith('c-1', 'e-1', 'on bir bin mi');
  });

  it('keeps a player\'s chips on every rival still in', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => withThreeRows('accepted', 'accepted'));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    expect(chips(tree, 'Yalan Bu')).toHaveLength(2);
    expect(chips(tree, 'Sil')).toHaveLength(1);
  });

  /** A detail whose feed stops at two rows with older ones on the server, Ali's and mine taking turns. */
  function withOlderEntries() {
    const detail = challengeDetail();
    const rival = { ...detail.me!, user: ALI, score: 9000, rank: 2 };
    detail.participants = [detail.me!, rival];
    const row = (id: string, hoursAgo: number, value: number) => {
      const user = value % 2 === 1 ? ALI : detail.me!.user;
      return {
        id,
        userId: user.id,
        displayName: user.displayName,
        dayKey: '2026-09-08',
        value,
        source: 'manual' as const,
        status: 'ok' as const,
        createdAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
        proofUrl: null,
        answerBy: null,
        disputeVotes: null,
      };
    };
    const feed = [row('e-1', 1, 11111), row('e-2', 2, 22222)];
    const older = [row('e-3', 50, 33333), row('e-4', 51, 44444), row('e-5', 52, 55555)];
    return {
      detail: { ...detail, feed, feedCursor: { before: feed[1]!.createdAt, beforeId: 'e-2' } },
      feed,
      older,
    };
  }

  /** The itiraz chips on screen; "Yalan Bu" is the level-2 label. */
  function disputeChips(tree: ReactTestRenderer) {
    return tree.root.findAll((node) => node.props.label === 'Yalan Bu' && typeof node.props.onPress === 'function');
  }

  it('reaches the entries past the newest 40 with "Daha eski girişler", each with its itiraz chip, none twice', async () => {
    searchParams.id = 'c-1';
    const { detail, feed, older } = withOlderEntries();
    api.challenge = jest.fn(async () => detail);
    const cursor = { before: older[1]!.createdAt, beforeId: 'e-4' };
    api.challengeFeed = jest
      .fn()
      // the first page runs from the newest, so it repeats the detail's rows
      .mockResolvedValueOnce({ items: [...feed, older[0], older[1]], next: cursor })
      .mockResolvedValueOnce({ items: [older[2]], next: null });

    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();
    expect(api.challengeFeed).not.toHaveBeenCalled();
    expect(rendered(tree)).not.toContain('33.333');
    expect(disputeChips(tree)).toHaveLength(1);

    press(tree, 'Daha eski girişler');
    await settle();
    expect(api.challengeFeed).toHaveBeenCalledWith('c-1', { limit: 2 * LIMITS.FEED_PAGE });
    let text = rendered(tree);
    expect(text).toContain('33.333 adım');
    expect(text).toContain('44.444 adım');
    expect(text.split('11.111 adım')).toHaveLength(2);
    expect(text.split('22.222 adım')).toHaveLength(2);
    // Ali's older row can be disputed like any other while the çelınc runs
    expect(disputeChips(tree)).toHaveLength(2);

    press(tree, 'Daha eski girişler');
    await settle();
    expect(api.challengeFeed).toHaveBeenLastCalledWith('c-1', cursor);
    text = rendered(tree);
    expect(text).toContain('55.555 adım');
    expect(disputeChips(tree)).toHaveLength(3);
    // newest first, and nothing left to ask for
    expect(text.indexOf('22.222 adım')).toBeLessThan(text.indexOf('33.333 adım'));
    expect(text.indexOf('44.444 adım')).toBeLessThan(text.indexOf('55.555 adım'));
    expect(text).not.toContain('DAHA ESKİ GİRİŞLER');

    // the oldest row's chip files the itiraz on that entry
    api.disputeEntry = jest.fn(async () => ({ entry: {}, answerBy: null, standings: [] }));
    act(() => {
      disputeChips(tree)[2]!.props.onPress();
    });
    typeInto(tree, 'Neden yalan?', 'iki gün önce evdeydi');
    await act(async () => {
      await findWith(tree, 'title', 'İtirazı gönder', 'onPress').props.onPress();
    });
    expect(api.disputeEntry).toHaveBeenCalledWith('c-1', 'e-5', 'iki gün önce evdeydi');
  });

  it('shows no "Daha eski girişler" when the feed already holds every entry', async () => {
    searchParams.id = 'c-1';
    const { detail } = withOlderEntries();
    api.challenge = jest.fn(async () => ({ ...detail, feedCursor: null }));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();
    expect(rendered(tree)).toContain('22.222 adım');
    expect(rendered(tree)).not.toContain('DAHA ESKİ GİRİŞLER');
  });

  it('says so when the older entries do not come, and the button asks again', async () => {
    searchParams.id = 'c-1';
    const { detail, older } = withOlderEntries();
    api.challenge = jest.fn(async () => detail);
    api.challengeFeed = jest
      .fn()
      .mockRejectedValueOnce(NETWORK_ERROR)
      .mockResolvedValueOnce({ items: older, next: null });
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    press(tree, 'Daha eski girişler');
    await settle();
    expect(rendered(tree)).toContain('Eski girişler gelmedi. Bir daha dene.');
    press(tree, 'Daha eski girişler');
    await settle();
    expect(api.challengeFeed).toHaveBeenCalledTimes(2);
    expect(rendered(tree)).toContain('55.555 adım');
    expect(rendered(tree)).not.toContain('gelmedi');
  });

  it('does not greet a reopened çelınc with the last visit\'s failed page', async () => {
    searchParams.id = 'c-1';
    const { detail } = withOlderEntries();
    api.challenge = jest.fn(async () => detail);
    api.challengeFeed = jest.fn().mockRejectedValue(NETWORK_ERROR);
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen key="first" />);
    await settle();
    press(tree, 'Daha eski girişler');
    await settle();
    expect(rendered(tree)).toContain('Eski girişler gelmedi. Bir daha dene.');

    // back on the screen while the cache still holds that failure: nobody has asked yet
    const client = clientOf(tree);
    act(() => {
      tree.update(
        <SafeAreaProvider initialMetrics={SAFE_AREA}>
          <QueryClientProvider client={client}>
            <ToastProvider>
              <ChallengeScreen key="again" />
            </ToastProvider>
          </QueryClientProvider>
        </SafeAreaProvider>
      );
    });
    await settle();
    expect(rendered(tree)).toContain('DAHA ESKİ GİRİŞLER');
    expect(rendered(tree)).not.toContain('gelmedi');
  });

  it('lets a row deleted since the older pages came go with the detail\'s next refresh', async () => {
    searchParams.id = 'c-1';
    const { detail, feed, older } = withOlderEntries();
    let current = detail;
    api.challenge = jest.fn(async () => current);
    api.challengeFeed = jest.fn().mockResolvedValue({ items: [...feed, ...older], next: null });
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();
    press(tree, 'Daha eski girişler');
    await settle();
    expect(rendered(tree)).toContain('11.111 adım');

    // Ali deletes his newest row; the detail refetches on its own timer and its
    // window moves down one, while the loaded pages still hold the old copy
    current = { ...detail, feed: [feed[1]!, older[0]!], feedCursor: { before: older[0]!.createdAt, beforeId: 'e-3' } };
    await act(async () => {
      await clientOf(tree).refetchQueries({ queryKey: ['challenge', 'c-1'], exact: true });
    });
    await settle();
    const text = rendered(tree);
    expect(text).not.toContain('11.111 adım');
    expect(text.split('22.222 adım')).toHaveLength(2);
    expect(text.split('33.333 adım')).toHaveLength(2);
    expect(text).toContain('55.555 adım');
  });
});

describe('the note an entry was written with', () => {
  const ALI = { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };

  /** Ali's typed row and mine, each with the note given (`undefined`: a row from an older server). */
  function withNotes(his: string | null | undefined, mine: string | null | undefined) {
    const detail = challengeDetail();
    const row = (id: string, user: typeof ALI, value: number, note: string | null | undefined) => ({
      id,
      userId: user.id,
      displayName: user.displayName,
      dayKey: '2026-09-08',
      value,
      source: 'manual' as const,
      status: 'ok' as const,
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      proofUrl: null,
      ...(note === undefined ? {} : { note }),
    });
    return {
      ...detail,
      participants: [detail.me!, { ...detail.me!, user: ALI, score: 11111, rank: 2 }],
      feed: [row('e-1', ALI, 11111, his), row('e-2', detail.me!.user, 22222, mine)],
    };
  }

  it('shows it in quotes under the row, to a friend and on the author\'s own row', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => withNotes('Kütüphanede bitirdim', 'Sabah sahilde,\nakşam da parkta'));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('“Kütüphanede bitirdim”');
    expect(text).toContain('“Sabah sahilde,\nakşam da parkta”');
    // a note keeps its line breaks, so the row bounds it rather than growing with it
    const lines = tree.root.findAll(
      (node) => node.props.children === '“Sabah sahilde,\nakşam da parkta”' && node.props.numberOfLines === 2
    );
    expect(lines.length).toBeGreaterThan(0);
  });

  it('adds nothing under a row without one, or from a server that does not send it', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => withNotes(null, undefined));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('11.111 adım');
    expect(text).toContain('22.222 adım');
    expect(text).not.toContain('“');
  });
});

describe('a loser still waiting for the winner to talk', () => {
  const ALI = { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };

  /** Ali beat the reader `ago` ms ago and has not sent a thing. */
  function lostTo(ago: number) {
    const detail = challengeDetail();
    const finalizedAt = new Date(Date.now() - ago).toISOString();
    return {
      challenge: { ...detail.challenge, status: 'finished' as const, endsAt: finalizedAt, finalizedAt, winnerId: ALI.id },
      standings: [
        { ...detail.me!, user: ALI, score: 12430, rank: 1, isWinner: true },
        { ...detail.me!, score: 8000, rank: 2 },
      ],
      taunts: [],
    };
  }

  it('tells them to hang on while the winner may still get round to it', async () => {
    searchParams.id = 'c-1';
    api.results = jest.fn(async () => lostTo(3 * 3_600_000));
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Ali daha ağzını açmadı. Beklemede kal.');
    expect(text).not.toContain('unuttu galiba');
    // the header does not point at a laf that is not there
    expect(text).toContain('Laf gelirse aşağıda görürsün, şimdilik ses yok.');
    expect(text).not.toContain('Kazanan sana laf soktu, aşağıda.');
    // nothing to answer yet
    expect(() => findWith(tree, 'title', 'Cevap ver', 'onPress')).toThrow();
  });

  it('says the laf is below once it is', async () => {
    searchParams.id = 'c-1';
    const results = lostTo(3 * 3_600_000);
    api.results = jest.fn(async () => ({
      ...results,
      taunts: [
        {
          id: 't-1',
          challengeId: 'c-1',
          fromUserId: ALI.id,
          toUserId: 'me-1',
          level: 2 as const,
          title: 'Koydum',
          body: 'Ali koydu, Mustafa yedi.',
          createdAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    }));
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Kazanan sana laf soktu, aşağıda.');
    expect(text).toContain('Ali koydu, Mustafa yedi.');
    expect(text).not.toContain('Laf gelirse aşağıda');
  });

  it('goes back down to the çelınc from "Çelınca dön", not a second copy of it', async () => {
    searchParams.id = 'c-1';
    api.results = jest.fn(async () => lostTo(3 * 3_600_000));
    const { router } = require('expo-router') as { router: Record<string, jest.Mock> };
    router.navigate!.mockClear();
    router.dismissTo!.mockClear();
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    press(tree, 'Çelınca dön');
    expect(router.dismissTo).toHaveBeenCalledWith({ pathname: '/challenge/[id]', params: { id: 'c-1' } });
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('stops promising a laf after a day without one', async () => {
    searchParams.id = 'c-1';
    api.results = jest.fn(async () => lostTo(30 * 3_600_000));
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Ali unuttu galiba. Rövanş aç, bu sefer sen koy.');
    expect(text).not.toContain('Beklemede kal');
  });
});

describe('answering back, and a tie', () => {
  const ALI = { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };
  const VELI = { id: 'u-3', username: 'veli', displayName: 'Veli', avatarEmoji: '🦊', createdAt: '2026-09-01T00:00:00.000Z' };
  const at = new Date(Date.now() - 60_000).toISOString();
  const aliToMe = {
    id: 't-1', challengeId: 'c-1', fromUserId: ALI.id, toUserId: 'me-1', level: 2 as const,
    title: 'Koydu', body: 'Ali koydu: 12.430 adım karşısında 8.000. Afiyet olsun Mustafa.', createdAt: at,
  };
  const meToAli = {
    id: 't-2', challengeId: 'c-1', fromUserId: 'me-1', toUserId: ALI.id, level: 2 as const,
    title: 'Mustafa boş durmadı', body: 'Tamam Ali, 4.430 adım için bu kadar konuşma. Rövanş geliyor.', createdAt: at,
  };

  /** Ali beat the reader an hour ago; `taunts` is what went back and forth. */
  function lostToAli(taunts: unknown[]) {
    const detail = challengeDetail();
    const finalizedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    return {
      challenge: { ...detail.challenge, status: 'finished' as const, endsAt: finalizedAt, finalizedAt, winnerId: ALI.id },
      standings: [
        { ...detail.me!, user: ALI, score: 12430, rank: 1, isWinner: true },
        { ...detail.me!, score: 8000, rank: 2 },
      ],
      taunts,
    };
  }

  /** The reader and Ali tied at the top, Veli behind; `meRank` 3 puts the reader behind instead. */
  function tied(meRank: 1 | 3 = 1, taunts: unknown[] = []) {
    const detail = challengeDetail();
    const finalizedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const third = meRank === 1 ? VELI : detail.me!.user;
    const leader = meRank === 1 ? detail.me!.user : VELI;
    return {
      challenge: { ...detail.challenge, status: 'finished' as const, endsAt: finalizedAt, finalizedAt, isTie: true },
      standings: [
        { ...detail.me!, user: leader, score: 9000, rank: 1 },
        { ...detail.me!, user: ALI, score: 9000, rank: 1 },
        { ...detail.me!, user: third, score: 3000, rank: 3 },
      ],
      taunts,
    };
  }

  beforeEach(() => {
    const { router } = require('expo-router') as { router: Record<string, jest.Mock> };
    router.push!.mockClear();
  });

  it('offers the loser one answer under the winner\'s laf', async () => {
    searchParams.id = 'c-1';
    api.results = jest.fn(async () => lostToAli([aliToMe]));
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    expect(rendered(tree)).toContain('Afiyet olsun Mustafa.');
    press(tree, 'Cevap ver');
    const { router } = require('expo-router') as { router: Record<string, jest.Mock> };
    expect(router.push).toHaveBeenCalledWith({ pathname: '/challenge/[id]/taunt', params: { id: 'c-1', to: ALI.id } });
  });

  it('shows the answer once it went, and no second button', async () => {
    searchParams.id = 'c-1';
    api.results = jest.fn(async () => lostToAli([aliToMe, meToAli]));
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Afiyet olsun Mustafa.');
    expect(text).toContain('Rövanş geliyor.');
    expect(() => findWith(tree, 'title', 'Cevap ver', 'onPress')).toThrow();
  });

  it('shows the winner each loser\'s answer under their name', async () => {
    searchParams.id = 'c-1';
    const detail = challengeDetail();
    const finalizedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    api.results = jest.fn(async () => ({
      challenge: { ...detail.challenge, status: 'finished' as const, endsAt: finalizedAt, finalizedAt, winnerId: 'me-1' },
      standings: [
        { ...detail.me!, isWinner: true },
        { ...detail.me!, user: ALI, score: 8000, rank: 2 },
      ],
      taunts: [
        { ...aliToMe, fromUserId: 'me-1', toUserId: ALI.id },
        { ...meToAli, fromUserId: ALI.id, toUserId: 'me-1', body: 'Yedim, kabul Mustafa. Rövanşta o lafı sana yediririm lan.' },
      ],
    }));
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    expect(rendered(tree)).toContain('Yedim, kabul Mustafa. Rövanşta o lafı sana yediririm lan.');
  });

  it('lets a co-leader of a tie have a go at the other, and nobody behind them', async () => {
    searchParams.id = 'c-1';
    api.results = jest.fn(async () => tied());
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    press(tree, 'Laf at');
    const { router } = require('expo-router') as { router: Record<string, jest.Mock> };
    expect(router.push).toHaveBeenCalledWith({ pathname: '/challenge/[id]/taunt', params: { id: 'c-1', to: ALI.id } });

    api.results = jest.fn(async () => tied(3));
    const behind = renderScreen(<ResultsScreen />);
    await settle();
    expect(rendered(behind)).toContain('Laf hakkı berabere kalanlarda, sen arkada kaldın. Rövanş aç.');
    expect(() => findWith(behind, 'title', 'Laf at', 'onPress')).toThrow();
  });

  it('tells whoever finished behind a tie they lost, penalty and all, and the co-leaders they drew', async () => {
    searchParams.id = 'c-1';
    api.results = jest.fn(async () => tied(3));
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const behind = renderScreen(<ResultsScreen />);
    await settle();

    const text = rendered(behind);
    expect(text).toContain('YEDİN');
    expect(text).not.toContain('BERABERE LAN');
    // section labels are drawn in capitals
    expect(text).toContain('CEZA');
    expect(text).not.toContain('ORTADA KALAN HESAP');
    expect(text).toMatch(/Öndekilerin ödülü\s*:\s+Kaybeden kahve ısmarlar/);
    // measured against the shared top score
    expect(text).toMatch(/Öndekilerle\s+aranda\s+6\.000 adım\s+fark var\./);
    // no co-leader may send him a laf, so nothing waits for one
    expect(text).not.toContain('Daha sesi çıkmadı');
    expect(text).not.toContain('Kazanan ağzını açarsa');
    expect(() => findWith(behind, 'title', 'Rövanş İstiyorum', 'onPress')).not.toThrow();

    api.results = jest.fn(async () => tied());
    const leader = renderScreen(<ResultsScreen />);
    await settle();
    const leaderText = rendered(leader);
    expect(leaderText).toContain('BERABERE LAN');
    expect(leaderText).toContain('ORTADA KALAN HESAP');
    expect(leaderText).not.toContain('CEZA');
    expect(leaderText).not.toContain('Öndekilerle');
  });

  it('draws third place on the podium in bronze, not in a maroon the dark card swallows', async () => {
    searchParams.id = 'c-1';
    api.results = jest.fn(async () => tied());
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    // Veli's score and the number on his pedestal
    const bronze = tree.root.findAll((node) => node.props.color === Colors.bronze);
    expect(bronze.map((node) => textIn(node.props.children).join(''))).toEqual(['3.000 adım', '3']);
  });

  it('shows a co-leader the laf the other one threw, and that theirs went', async () => {
    searchParams.id = 'c-1';
    const fromAli = { ...aliToMe, title: 'Ali bırakmıyor', body: 'Eşit bitti ama bu iş bitmedi Mustafa. Rövanşı aç da kim koyuyor görelim lan.' };
    const fromMe = { ...meToAli, title: 'Mustafa laf attı', body: '9.000 - 9.000, berabere Ali. Rövanşta ayırırız bu işi.' };
    api.results = jest.fn(async () => tied(1, [fromMe]));
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const first = renderScreen(<ResultsScreen />);
    await settle();
    // mine went first: now it is his turn
    expect(rendered(first)).toContain('Lafını attın, sıra onda.');

    api.results = jest.fn(async () => tied(1, [fromAli, fromMe]));
    const tree = renderScreen(<ResultsScreen />);
    await settle();
    const text = rendered(tree);
    expect(text).toContain('Rövanşı aç da kim koyuyor görelim lan.');
    // he had already written: nobody's turn, his one row is used
    expect(text).toContain('Lafını attın, ödeştiniz.');
    expect(text).not.toContain('sıra onda');
    expect(() => findWith(tree, 'title', 'Laf at', 'onPress')).toThrow();
  });

  it('the picker offers answer lines addressed to the winner, once the winner spoke', async () => {
    searchParams.id = 'c-1';
    api.results = jest.fn(async () => lostToAli([]));
    const TauntScreen = require('@/app/(app)/challenge/[id]/taunt').default;
    const early = renderScreen(<TauntScreen />);
    await settle();
    expect(rendered(early)).toContain('Önce o konuşsun');

    api.results = jest.fn(async () => lostToAli([aliToMe]));
    const tree = renderScreen(<TauntScreen />);
    await settle();
    const text = rendered(tree);
    expect(text).toContain('Ne cevap verelim?');
    expect(text).toContain('CEVAP');
    // {winner} is Ali, {loser} is me: "Mustafa boş durmadı"
    expect(text).toContain('Mustafa boş durmadı');
    expect(text).toContain('Tamam Ali, 4.430 adım için bu kadar konuşma. Rövanş geliyor.');
    expect(text).not.toContain('Afiyet olsun Ali');
  });

  it('the picker offers the tie lines to a co-leader', async () => {
    searchParams.id = 'c-1';
    api.results = jest.fn(async () => tied());
    const TauntScreen = require('@/app/(app)/challenge/[id]/taunt').default;
    const tree = renderScreen(<TauntScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('BERABERE');
    // a line from me to him, signed by me
    expect(text).toContain('Mustafa laf attı');
    expect(text).toContain('9.000 - 9.000, berabere Ali.');
    expect(text).not.toContain('Kazanan olmadığı için');
  });

  it('the inbox puts the sender\'s face on an answer, not the winner\'s', async () => {
    const detail = challengeDetail();
    const finalizedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    api.challenges = jest.fn(async () => [
      {
        challenge: { ...detail.challenge, status: 'finished' as const, endsAt: finalizedAt, finalizedAt, winnerId: 'me-1' },
        participants: [{ ...detail.me!, isWinner: true }, { ...detail.me!, user: ALI, score: 8000, rank: 2 }],
        me: { ...detail.me!, isWinner: true },
        unreadTaunts: 1,
      },
    ]);
    api.inbox = jest.fn(async () => [
      {
        id: 'n-1',
        type: 'taunt',
        title: 'Ali boş durmadı',
        body: 'Tamam Mustafa, bu kadar konuşma.',
        data: { challengeId: 'c-1', tauntId: 't-2', fromUserId: ALI.id },
        readAt: null,
        createdAt: at,
      },
    ]);
    const InboxScreen = require('@/app/(app)/(tabs)/inbox').default;
    const tree = renderScreen(<InboxScreen />);
    await settle();

    const bubble = tree.root.findAll((node) => node.props.title === 'Ali boş durmadı' && node.props.fromName !== undefined);
    expect(bubble[0]?.props.fromName).toBe('Ali');
  });
});

describe('the winner\'s taunt picker', () => {
  const ALI = { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };

  /** The reader beat Ali 12.430 to 4.201: a big margin on its own. */
  function wonAgainstAli(contexts?: Record<string, string>) {
    const detail = challengeDetail();
    const finalizedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    return {
      challenge: { ...detail.challenge, status: 'finished' as const, endsAt: finalizedAt, finalizedAt, winnerId: 'me-1' },
      standings: [
        { ...detail.me!, isWinner: true },
        { ...detail.me!, user: ALI, score: 4201, rank: 2 },
      ],
      taunts: [],
      ...(contexts ? { tauntContexts: contexts } : {}),
    };
  }

  it('offers the rövanş lines when the server says this one was won back', async () => {
    searchParams.id = 'c-1';
    api.results = jest.fn(async () => wonAgainstAli({ [ALI.id]: 'revenge' }));
    const TauntScreen = require('@/app/(app)/challenge/[id]/taunt').default;
    const tree = renderScreen(<TauntScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('RÖVANŞ');
    expect(text).toContain('Rövanşı aldı');
    expect(text).not.toContain('EZİCİ FARK');
  });

  it('offers the seri lines for a third win in a row', async () => {
    searchParams.id = 'c-1';
    api.results = jest.fn(async () => wonAgainstAli({ [ALI.id]: 'streak' }));
    const TauntScreen = require('@/app/(app)/challenge/[id]/taunt').default;
    const tree = renderScreen(<TauntScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('SERİ');
    expect(text).toContain('Yine koydu');
  });

  it('falls back to the margin when an older server sends no contexts', async () => {
    searchParams.id = 'c-1';
    api.results = jest.fn(async () => wonAgainstAli());
    const TauntScreen = require('@/app/(app)/challenge/[id]/taunt').default;
    const tree = renderScreen(<TauntScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('EZİCİ FARK');
    expect(text).not.toContain('RÖVANŞ');
  });
});

describe('a loser the winner has a block with', () => {
  const ALI = { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };
  const VELI = { id: 'u-3', username: 'veli', displayName: 'Veli', avatarEmoji: '🦊', createdAt: '2026-09-01T00:00:00.000Z' };

  /**
   * The reader beat Ali and Veli; Veli has a block with the reader, so the
   * server's `canTaunt` names Ali only (a laf at Veli is 403 `blocked`).
   */
  function wonOverBoth() {
    const detail = challengeDetail();
    const finalizedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const challenge = { ...detail.challenge, status: 'finished' as const, endsAt: finalizedAt, finalizedAt, winnerId: 'me-1' };
    const standings = [
      { ...detail.me!, isWinner: true },
      { ...detail.me!, user: ALI, score: 9000, rank: 2 },
      { ...detail.me!, user: VELI, score: 4000, rank: 3 },
    ];
    api.challenge = jest.fn(async () => ({
      ...detail,
      challenge,
      participants: standings,
      me: standings[0],
      canTaunt: [{ toUserId: ALI.id, done: false }],
    }));
    api.results = jest.fn(async () => ({ challenge, standings, taunts: [] }));
  }

  it('offers the results screen\'s "KOYDUM MU?" only to the loser it can reach', async () => {
    searchParams.id = 'c-1';
    wonOverBoth();
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    const text = rendered(tree);
    // Veli still stands on the podium and in the list, with nothing to press
    expect(text).toContain('Veli');
    expect(tree.root.findAll((node) => node.props.title === 'KOYDUM MU?' && typeof node.props.onPress === 'function')).toHaveLength(1);
    expect(text).not.toContain('HEPSİNE KOY');
    expect(text).not.toContain('Hepsine koydun');
  });

  it('leaves him out of the picker, so "HEPSİ" never sends one the server refuses', async () => {
    searchParams.id = 'c-1';
    wonOverBoth();
    const TauntScreen = require('@/app/(app)/challenge/[id]/taunt').default;
    const tree = renderScreen(<TauntScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Ali');
    expect(text).not.toContain('Veli');
    expect(text).not.toContain('HEPSİ (');
  });

  // "Kaybedene bir laf gönder." and "Kime koyacağını seç" over a row with nothing to press
  it('tells a 1v1 winner the laf cannot go, instead of asking whom to send it to', async () => {
    searchParams.id = 'c-1';
    const detail = challengeDetail();
    const finalizedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const challenge = { ...detail.challenge, status: 'finished' as const, endsAt: finalizedAt, finalizedAt, winnerId: 'me-1' };
    const standings = [
      { ...detail.me!, isWinner: true },
      { ...detail.me!, user: VELI, score: 4000, rank: 2 },
    ];
    api.challenge = jest.fn(async () => ({ ...detail, challenge, participants: standings, me: standings[0], canTaunt: [] }));
    api.results = jest.fn(async () => ({ challenge, standings, taunts: [] }));
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Aranızda engel var, laf gitmez.');
    expect(text).toContain('Bu çelınc senin, keyfini çıkar.');
    expect(text).not.toContain('Kime koyacağını seç');
    expect(text).not.toContain('Kaybedene bir laf gönder.');
    expect(tree.root.findAll((node) => node.props.title === 'KOYDUM MU?' && typeof node.props.onPress === 'function')).toHaveLength(0);
  });

  it('still asks whom to send it to while one loser can be reached', async () => {
    searchParams.id = 'c-1';
    wonOverBoth();
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Kime koyacağını seç');
    expect(text).toContain('Kaybedene bir laf gönder.');
    expect(text).not.toContain('Aranızda engel var');
  });
});

describe('a tie shared with somebody across a block', () => {
  const VELI = { id: 'u-3', username: 'veli', displayName: 'Veli', avatarEmoji: '🦊', createdAt: '2026-09-01T00:00:00.000Z' };

  /** The reader and Veli both finished first; `canTaunt` from a server that lists a tie's co-leaders. */
  function tiedWithVeli(canTaunt: { toUserId: string; done: boolean }[], coversTie: boolean | undefined) {
    const detail = challengeDetail();
    const finalizedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const challenge = { ...detail.challenge, status: 'finished' as const, endsAt: finalizedAt, finalizedAt, winnerId: null, isTie: true };
    const standings = [
      { ...detail.me!, score: 5000, rank: 1, isWinner: false },
      { ...detail.me!, user: VELI, score: 5000, rank: 1, isWinner: false },
    ];
    api.challenge = jest.fn(async () => ({
      ...detail,
      challenge,
      participants: standings,
      me: standings[0],
      canTaunt,
      ...(coversTie === undefined ? {} : { canTauntCoversTie: coversTie }),
    }));
    api.results = jest.fn(async () => ({ challenge, standings, taunts: [] }));
  }

  const lafAt = (tree: ReactTestRenderer) =>
    tree.root.findAll((node) => node.props.title === 'Laf at' && typeof node.props.onPress === 'function');

  it('offers no "Laf at" when the server leaves the co-leader out', async () => {
    searchParams.id = 'c-1';
    tiedWithVeli([], true);
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    expect(rendered(tree)).toContain('BERABERE LAN');
    expect(lafAt(tree)).toHaveLength(0);
  });

  it('keeps him out of the picker, which then has nobody to offer', async () => {
    searchParams.id = 'c-1';
    tiedWithVeli([], true);
    const TauntScreen = require('@/app/(app)/challenge/[id]/taunt').default;
    const tree = renderScreen(<TauntScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Berabere kalan yok');
    expect(text).not.toContain('Veli');
  });

  it('offers "Laf at" to a co-leader the server lists, and to every one from an older server', async () => {
    searchParams.id = 'c-1';
    tiedWithVeli([{ toUserId: VELI.id, done: false }], true);
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const listed = renderScreen(<ResultsScreen />);
    await settle();
    expect(lafAt(listed)).toHaveLength(1);

    // an older server lists nobody for a tie and says nothing about it
    tiedWithVeli([], undefined);
    const older = renderScreen(<ResultsScreen />);
    await settle();
    expect(lafAt(older)).toHaveLength(1);
  });
});

describe('a group rival who is not a friend', () => {
  const ALI = { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };
  const VELI = { id: 'u-3', username: 'veli', displayName: 'Veli', avatarEmoji: '🦊', createdAt: '2026-09-01T00:00:00.000Z' };

  /** Ali won a three-way çelınc; the reader came second, Veli (not a friend) third. */
  function groupResults(leftOut?: string[]) {
    const detail = challengeDetail();
    const finalizedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    return {
      challenge: { ...detail.challenge, status: 'finished' as const, endsAt: finalizedAt, finalizedAt, winnerId: ALI.id },
      standings: [
        { ...detail.me!, user: ALI, score: 15000, rank: 1, isWinner: true },
        { ...detail.me!, score: 12430, rank: 2 },
        { ...detail.me!, user: VELI, score: 3000, rank: 3 },
      ],
      taunts: [],
      ...(leftOut ? { rematchLeftOut: leftOut } : {}),
    };
  }

  beforeEach(() => {
    const { router } = require('expo-router') as { router: Record<string, jest.Mock> };
    router.push!.mockClear();
  });

  it('says under the rematch button that they will not be invited, and how to fix it', async () => {
    searchParams.id = 'c-1';
    api.results = jest.fn(async () => groupResults([VELI.id]));
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    expect(rendered(tree)).toContain('Veli kankan değil, rövanşa çağrılmaz. Tablodan adına dokun, ekle.');
  });

  it('claims nothing when the server does not say', async () => {
    searchParams.id = 'c-1';
    api.results = jest.fn(async () => groupResults());
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    expect(rendered(tree)).not.toContain('rövanşa çağrılmaz');
  });

  it('opens a rival\'s profile from the final table, but never my own row', async () => {
    searchParams.id = 'c-1';
    api.results = jest.fn(async () => groupResults([VELI.id]));
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    act(() => {
      findWith(tree, 'accessibilityLabel', 'Veli profili', 'onPress').props.onPress();
    });
    const { router } = require('expo-router') as { router: Record<string, jest.Mock> };
    expect(router.push).toHaveBeenCalledWith({ pathname: '/user/[id]', params: { id: VELI.id } });
    expect(() => findWith(tree, 'accessibilityLabel', 'Mustafa profili', 'onPress')).toThrow();
  });

  it('names only the players the rematch really invited', async () => {
    searchParams.id = 'c-1';
    api.results = jest.fn(async () => groupResults([VELI.id]));
    const rematch = { ...challengeDetail().challenge, id: 'c-2', status: 'pending' as const, rematchOfId: 'c-1' };
    api.rematch = jest.fn(async () => rematch);
    api.challenge = jest.fn(async (id: string) => {
      if (id !== 'c-2') throw new ApiError('not_found', 'Bulunamadı.', 404);
      const detail = challengeDetail();
      return {
        ...detail,
        challenge: rematch,
        participants: [detail.me!, { ...detail.me!, user: ALI, status: 'invited' as const, score: 0, rank: 0 }],
      };
    });
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    await act(async () => {
      findWith(tree, 'title', 'Rövanş İstiyorum', 'onPress').props.onPress();
    });
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Davet gitti: Ali.');
    expect(text).not.toContain('kankalar davet edildi');
    const { router } = require('expo-router') as { router: Record<string, jest.Mock> };
    expect(router.replace).toHaveBeenCalledWith({ pathname: '/challenge/[id]', params: { id: 'c-2' } });
  });
});

describe('a rematch somebody already opened', () => {
  const ALI = { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };
  const VELI = { id: 'u-3', username: 'veli', displayName: 'Veli', avatarEmoji: '🦊', createdAt: '2026-09-01T00:00:00.000Z' };
  const OPEN = { id: 'c-2', status: 'pending' as const, creatorId: ALI.id, creatorName: 'Ali', myStatus: 'invited' as const };

  /** Ali beat me (level 2: "Rövanş İstiyorum") with Veli, not a friend, third. */
  function lost(extra: Record<string, unknown> = {}) {
    const detail = challengeDetail();
    const finalizedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    return {
      challenge: { ...detail.challenge, status: 'finished' as const, endsAt: finalizedAt, finalizedAt, winnerId: ALI.id },
      standings: [
        { ...detail.me!, user: ALI, score: 15000, rank: 1, isWinner: true },
        { ...detail.me!, score: 12430, rank: 2 },
        { ...detail.me!, user: VELI, score: 3000, rank: 3 },
      ],
      taunts: [],
      rematchLeftOut: [VELI.id],
      rematchInvitable: 1,
      rematch: null,
      ...extra,
    };
  }

  let router: Record<string, jest.Mock>;
  beforeEach(() => {
    ({ router } = require('expo-router') as { router: Record<string, jest.Mock> });
    router.push!.mockClear();
    router.replace!.mockClear();
    searchParams.id = 'c-1';
    api.rematch = jest.fn(async () => {
      throw new Error('no second rematch should be asked for');
    });
  });

  it('turns the button into a link to the invite instead of opening a second one', async () => {
    api.results = jest.fn(async () => lost({ rematch: OPEN }));
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Ali rövanş açtı, davet sende.');
    expect(text).not.toContain('Rövanş İstiyorum');
    // the note is about a rematch I would open, and there will not be one
    expect(text).not.toContain('rövanşa çağrılmaz');
    press(tree, 'Rövanş daveti sende');
    expect(router.push).toHaveBeenCalledWith({ pathname: '/challenge/[id]', params: { id: 'c-2' } });
    expect(api.rematch).not.toHaveBeenCalled();
  });

  it('says whose it is once I am in, and leads to its result once it is over', async () => {
    api.results = jest.fn(async () => lost({ rematch: { ...OPEN, myStatus: 'accepted' } }));
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const joined = renderScreen(<ResultsScreen />);
    await settle();
    expect(rendered(joined)).toContain('Ali rövanş açtı, sen de içindesin.');
    expect(() => findWith(joined, 'title', 'Rövanşa git', 'onPress')).not.toThrow();

    api.results = jest.fn(async () => lost({ rematch: { ...OPEN, status: 'finished', myStatus: 'accepted' } }));
    const over = renderScreen(<ResultsScreen />);
    await settle();
    expect(rendered(over)).toContain('Rövanş da oynandı, sonucu orada.');
    press(over, 'Rövanşın sonucu');
    expect(router.push).toHaveBeenCalledWith({ pathname: '/challenge/[id]/results', params: { id: 'c-2' } });
  });

  it('follows a rematch the other side opened while the button was still up', async () => {
    let opened = false;
    api.results = jest.fn(async () => lost(opened ? { rematch: OPEN } : {}));
    api.rematch = jest.fn(async () => {
      opened = true;
      throw new ApiError('rematch_exists', 'Ali rövanşı zaten açtı, davet sende.', 409);
    });
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    await act(async () => {
      findWith(tree, 'title', 'Rövanş İstiyorum', 'onPress').props.onPress();
    });
    await settle();

    expect(api.results).toHaveBeenCalledTimes(2);
    expect(router.push).toHaveBeenCalledWith({ pathname: '/challenge/[id]', params: { id: 'c-2' } });
    const text = rendered(tree);
    expect(text).toContain('Ali rövanşı zaten açtı, davet sende.');
    expect(text).not.toContain('Olmadı');
  });

  it('points every "rövanş aç" line to the one that is open', async () => {
    const base = lost({ rematch: OPEN });
    const tie = {
      ...base,
      challenge: { ...base.challenge, winnerId: null, isTie: true },
      standings: [
        { ...base.standings[0]!, rank: 1, isWinner: false },
        { ...base.standings[1]!, score: 15000, rank: 1 },
        base.standings[2]!,
      ],
    };
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;

    api.results = jest.fn(async () => tie);
    const even = renderScreen(<ResultsScreen />);
    await settle();
    expect(rendered(even)).toContain('Kimse öne geçemedi. Rövanşı aşağıda, oraya bak.');
    expect(rendered(even)).not.toContain('Rövanş aç');

    // third behind Ali and Veli's shared first place
    api.results = jest.fn(async () => ({
      ...tie,
      standings: [
        { ...tie.standings[0]!, rank: 1 },
        { ...tie.standings[2]!, score: 15000, rank: 1 },
        { ...tie.standings[1]!, score: 3000, rank: 3 },
      ],
    }));
    const behind = renderScreen(<ResultsScreen />);
    await settle();
    expect(rendered(behind)).toContain('sen arkada kaldın. Rövanşı aşağıda, oraya bak.');
    expect(rendered(behind)).not.toContain('Rövanş aç');

    // a day and more without Ali's laf
    const longAgo = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    api.results = jest.fn(async () => ({ ...base, challenge: { ...base.challenge, endsAt: longAgo, finalizedAt: longAgo } }));
    const silent = renderScreen(<ResultsScreen />);
    await settle();
    expect(rendered(silent)).toContain('Ali unuttu galiba. Rövanşı aşağıda, oraya bak.');
    expect(rendered(silent)).not.toContain('Rövanş aç');
  });

  it('keeps the button but greys it out when nobody is left to invite', async () => {
    api.results = jest.fn(async () => lost({ rematchInvitable: 0 }));
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    expect(findWith(tree, 'title', 'Rövanş İstiyorum', 'onPress').props.disabled).toBe(true);
    // Veli is named, so the note already says why
    expect(rendered(tree)).toContain('Veli kankan değil, rövanşa çağrılmaz.');
    expect(rendered(tree)).not.toContain('Rövanşa çağrılacak kimse kalmadı.');

    api.results = jest.fn(async () => lost({ rematchInvitable: 0, rematchLeftOut: [] }));
    const nobody = renderScreen(<ResultsScreen />);
    await settle();
    expect(rendered(nobody)).toContain('Rövanşa çağrılacak kimse kalmadı.');
  });

  it('names a friend the clock difference keeps out of a rematch opened now, and who can open it', async () => {
    api.results = jest.fn(async () => lost({ rematchInvitable: 0, rematchLeftOut: [], rematchZoneShort: [ALI.id] }));
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    expect(findWith(tree, 'title', 'Rövanş İstiyorum', 'onPress').props.disabled).toBe(true);
    expect(rendered(tree)).toContain('Saat farkından Ali bu rövanşta eksik günle kalır, çağrılmaz. Rövanşı o açsın.');
    expect(rendered(tree)).not.toContain('Rövanşa çağrılacak kimse kalmadı.');
  });
});

describe('a result sent to the WhatsApp group', () => {
  const ALI = { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };
  const VELI = { id: 'u-3', username: 'veli', displayName: 'Veli', avatarEmoji: '🦊', createdAt: '2026-09-01T00:00:00.000Z' };

  /** Ali won a three-way çelınc over Veli; the reader came second, or only watched (`watching`). */
  function finished(watching = false) {
    const detail = challengeDetail();
    const finalizedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    return {
      challenge: { ...detail.challenge, status: 'finished' as const, endsAt: finalizedAt, finalizedAt, winnerId: ALI.id },
      standings: [
        { ...detail.me!, user: ALI, score: 15000, rank: 1, isWinner: true },
        ...(watching ? [] : [{ ...detail.me!, score: 12430, rank: 2 }]),
        { ...detail.me!, user: VELI, score: 3000, rank: watching ? 2 : 3 },
      ],
      taunts: [],
    };
  }

  let share: jest.SpyInstance;
  beforeEach(() => {
    const { Share } = require('react-native') as typeof import('react-native');
    share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    api.health = jest.fn(async () => ({
      ok: true,
      version: '1',
      time: '',
      app: null,
      publicUrl: 'https://tatli-koydum.trycloudflare.com',
    }));
  });
  afterEach(() => share.mockRestore());

  it('hands the podium and my invite link to the share sheet', async () => {
    searchParams.id = 'c-1';
    api.results = jest.fn(async () => finished());
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    await act(async () => {
      findWith(tree, 'title', 'Gruba at', 'onPress').props.onPress();
    });

    expect(share).toHaveBeenCalledTimes(1);
    const { message } = share.mock.calls[0][0] as { message: string };
    expect(message).toContain('🥇 Ali · 15.000 adım');
    expect(message).toContain('🥈 Mustafa · 12.430 adım');
    expect(message).toContain('Bu sefer Ali koydu, yedik.');
    expect(message).toContain('https://tatli-koydum.trycloudflare.com/davet/KOY123');
  });

  it('is not offered to somebody who only watched', async () => {
    searchParams.id = 'c-1';
    api.results = jest.fn(async () => finished(true));
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    expect(rendered(tree)).toContain('ÇELINC BİTTİ');
    expect(() => findWith(tree, 'title', 'Gruba at', 'onPress')).toThrow();
  });
});

describe('the results of a çelınc the reader walked out of', () => {
  const ALI = { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };
  const VELI = { id: 'u-3', username: 'veli', displayName: 'Veli', avatarEmoji: '🦊', createdAt: '2026-09-01T00:00:00.000Z' };
  const LEFT = {
    1: 'Bu çelınctan ayrılmıştın, sonuç aşağıda.',
    2: 'Sen ayrılmıştın zaten, sonuç bu.',
    3: 'Sen kaçmıştın, iş bitti 🍆',
  } as const;
  const WATCHED = {
    1: 'Bu çelıncta yarışmadın, sonuç aşağıda.',
    2: 'Sen bu çelınca girmedin, sadece izledin.',
    3: 'Sen kenardan izledin, iş bitti 🍆',
  } as const;

  /**
   * Ali beat Veli; the reader's row is what the server sends for them, as
   * captured: a player who left keeps `lastEntryAt` but drops to rank 0.
   * `null` leaves them out of the standings altogether.
   */
  function finished(reader: { status: 'left' | 'declined'; lastEntryAt: string | null } | null) {
    const detail = challengeDetail();
    const finalizedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    return {
      challenge: { ...detail.challenge, status: 'finished' as const, endsAt: finalizedAt, finalizedAt, winnerId: ALI.id },
      standings: [
        { ...detail.me!, user: ALI, score: 15000, rank: 1, isWinner: true },
        { ...detail.me!, user: VELI, score: 3000, rank: 2 },
        ...(reader ? [{ ...detail.me!, ...reader, score: 0, days: 0, rank: 0 }] : []),
      ],
      taunts: [],
    };
  }

  it.each([1, 2, 3] as const)('tells a player who left at level %s that they left, not that they only watched', async (level) => {
    mockLevel.value = level;
    searchParams.id = 'c-1';
    api.results = jest.fn(async () => finished({ status: 'left', lastEntryAt: '2026-09-08T09:00:00.000Z' }));
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('ÇELINC BİTTİ');
    expect(text).toContain(LEFT[level]);
    expect(text).not.toContain('yarışmadın');
    expect(text).not.toContain('sadece izledin');
    expect(text).not.toContain('kenardan izledin');
  });

  it('says the same to an invitee whose "Ayrıl" left nothing played', async () => {
    searchParams.id = 'c-1';
    api.results = jest.fn(async () => finished({ status: 'left', lastEntryAt: null }));
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const tree = renderScreen(<ResultsScreen />);
    await settle();

    expect(rendered(tree)).toContain(LEFT[2]);
  });

  it('still tells somebody who said no, or was never in it, that they watched', async () => {
    searchParams.id = 'c-1';
    api.results = jest.fn(async () => finished({ status: 'declined', lastEntryAt: null }));
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const declined = renderScreen(<ResultsScreen />);
    await settle();
    expect(rendered(declined)).toContain(WATCHED[2]);
    expect(rendered(declined)).not.toContain(LEFT[2]);

    api.results = jest.fn(async () => finished(null));
    const outsider = renderScreen(<ResultsScreen />);
    await settle();
    expect(rendered(outsider)).toContain(WATCHED[2]);
  });
});

describe('a tie at the top, read by somebody who was not in it', () => {
  const ALI = { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };
  const VELI = { id: 'u-3', username: 'veli', displayName: 'Veli', avatarEmoji: '🦊', createdAt: '2026-09-01T00:00:00.000Z' };

  /** Ali and Veli tied for first; the reader `left` or was never in it. */
  function tied(reader: 'left' | null) {
    const detail = challengeDetail();
    const finalizedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    return {
      challenge: { ...detail.challenge, status: 'finished' as const, endsAt: finalizedAt, finalizedAt, winnerId: null, isTie: true },
      standings: [
        { ...detail.me!, user: ALI, score: 15000, rank: 1 },
        { ...detail.me!, user: VELI, score: 15000, rank: 1 },
        ...(reader ? [{ ...detail.me!, status: reader, score: 0, days: 0, rank: 0 }] : []),
      ],
      taunts: [],
    };
  }

  it('shows the tie without offering a rematch they cannot open', async () => {
    searchParams.id = 'c-1';
    api.results = jest.fn(async () => tied('left'));
    const ResultsScreen = require('@/app/(app)/challenge/[id]/results').default;
    const left = renderScreen(<ResultsScreen />);
    await settle();
    expect(rendered(left)).toContain('BERABERE');
    expect(rendered(left)).toContain('Sen ayrılmıştın zaten, sonuç bu.');
    expect(rendered(left)).not.toContain('Rövanş aç');

    api.results = jest.fn(async () => tied(null));
    const outsider = renderScreen(<ResultsScreen />);
    await settle();
    expect(rendered(outsider)).toContain('Sen bu çelınca girmedin, sadece izledin.');
    expect(rendered(outsider)).not.toContain('Rövanş aç');
  });
});

describe('the itiraz chip once the çelınc is over', () => {
  const ALI = { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };

  /** Ali has one plain entry nobody has disputed; the step çelınc ended `endedAgo` ms ago. */
  function withAliEntry(status: 'active' | 'finished', endedAgo: number | null) {
    const detail = challengeDetail();
    const rival = { ...detail.me!, user: ALI, score: 25000, rank: 1 };
    const endsAt = endedAgo === null ? detail.challenge.endsAt : new Date(Date.now() - endedAgo).toISOString();
    return {
      ...detail,
      challenge: { ...detail.challenge, status, endsAt, finalizedAt: status === 'finished' ? endsAt : null },
      participants: [detail.me!, rival],
      feed: [
        {
          id: 'e-1',
          userId: ALI.id,
          displayName: 'Ali',
          dayKey: '2026-09-08',
          value: 25000,
          source: 'manual' as const,
          status: 'ok' as const,
          createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
          proofUrl: null,
        },
      ],
    };
  }

  async function chipShown(detail: ReturnType<typeof withAliEntry>): Promise<boolean> {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => detail);
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();
    // level 2's "itiraz et"
    const chips = tree.root.findAll(
      (node) => node.props.label === 'Yalan Bu' && typeof node.props.onPress === 'function'
    );
    return chips.length > 0;
  }

  it('is there while the çelınc runs', async () => {
    expect(await chipShown(withAliEntry('active', null))).toBe(true);
  });

  it('stays through the hour a step çelınc waits for the phones', async () => {
    expect(await chipShown(withAliEntry('active', 5 * 60_000))).toBe(true);
  });

  it('goes once the server stops taking one', async () => {
    expect(await chipShown(withAliEntry('active', 2 * 3_600_000))).toBe(false);
  });

  it('is gone on a finished çelınc', async () => {
    expect(await chipShown(withAliEntry('finished', 3 * 3_600_000))).toBe(false);
  });
});

describe('new notifications reach the tabs that stay mounted', () => {
  const poke = {
    id: 'n-1',
    type: 'poke',
    title: '👉 Dürtüldün',
    body: 'Veli seni dürttü.',
    data: { challengeId: 'c-9' },
    readAt: new Date().toISOString(),
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  };

  it('the inbox refetches when the badge hears of a newer row, and counts what it has not loaded', async () => {
    api.inbox = jest.fn(async () => [poke]);
    // unread rows further down than the loaded page still count
    api.unreadCount = jest.fn(async () => ({ count: 3, latestId: 'n-1' }));
    const InboxScreen = require('@/app/(app)/(tabs)/inbox').default;
    const tree = renderScreen(<InboxScreen />);
    await settle();
    expect(rendered(tree)).toContain('3 yeni');
    expect(rendered(tree)).not.toContain('Okunmamış bildirim yok');
    expect(api.inbox).toHaveBeenCalledTimes(1);

    const taunt = {
      id: 'n-2',
      type: 'taunt',
      title: 'KOYDUM MU?',
      body: 'Veli sana sapır sapır koydu.',
      data: { challengeId: 'c-9', tauntId: 't-1' },
      readAt: null,
      createdAt: new Date().toISOString(),
    };
    api.inbox = jest.fn(async () => [taunt, poke]);
    api.unreadCount = jest.fn(async () => ({ count: 4, latestId: 'n-2' }));
    // what the 30 s poll behind the tab badge does
    await act(async () => {
      await clientOf(tree).invalidateQueries({ queryKey: ['unread'] });
    });
    await settle();
    expect(api.inbox).toHaveBeenCalledTimes(1);
    expect(rendered(tree)).toContain('Veli sana sapır sapır koydu.');
    expect(rendered(tree)).toContain('4 yeni');

    // the same newest row again: nothing to fetch
    await act(async () => {
      await clientOf(tree).invalidateQueries({ queryKey: ['unread'] });
    });
    await settle();
    expect(api.inbox).toHaveBeenCalledTimes(1);
  });

  it('the friends tab refetches a list older than 20 s when it comes back into focus', async () => {
    const FriendsScreen = require('@/app/(app)/(tabs)/friends').default;
    const tree = renderScreen(<FriendsScreen />);
    await settle();
    expect(api.friends).toHaveBeenCalledTimes(1);

    // straight back from another tab: the list is fresh
    act(() => mockFocus.effect?.());
    await settle();
    expect(api.friends).toHaveBeenCalledTimes(1);

    api.friends = jest.fn(async () => ({
      friends: [],
      incoming: [
        {
          id: 'f-1',
          user: { id: 'u-2', username: 'veli', displayName: 'Veli', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' },
        },
      ],
      outgoing: [],
    }));
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 21_000);
    try {
      act(() => mockFocus.effect?.());
      await settle();
    } finally {
      clock.mockRestore();
    }
    expect(api.friends).toHaveBeenCalledTimes(1);
    expect(rendered(tree)).toContain('GELEN İSTEKLER'); // the label variant capitalises
  });
});

describe('invite link on the friends tab', () => {
  it('warns that a localhost link opens nowhere else', async () => {
    api.health = jest.fn(async () => ({ ok: true, version: '1', time: '', app: null, publicUrl: null }));
    const FriendsScreen = require('@/app/(app)/(tabs)/friends').default;
    const tree = renderScreen(<FriendsScreen />);
    await settle();
    expect(rendered(tree)).toContain('başka hiçbir telefonda açılmaz');
  });

  it('uses the public address the server reports, and drops the warning', async () => {
    api.health = jest.fn(async () => ({
      ok: true,
      version: '1',
      time: '',
      app: null,
      publicUrl: 'https://tatli-koydum.trycloudflare.com',
    }));
    const FriendsScreen = require('@/app/(app)/(tabs)/friends').default;
    const tree = renderScreen(<FriendsScreen />);
    await settle();
    const text = rendered(tree);
    expect(text).not.toContain('başka hiçbir telefonda açılmaz');
    expect(text).not.toContain('aynı Wi-Fi');
    // half the card holds no "Bağlantıyı kopyala"; a screen reader still hears what it copies
    expect(findWith(tree, 'title', 'Kopyala', 'onPress').props.accessibilityLabel).toBe('Davet bağlantısını kopyala');
  });

  describe('once the tunnel opens under a running app', () => {
    // npm run internet: the first tunnel did not open, the server ran for the
    // home Wi-Fi, the owner looked at Kankalar, and the tunnel opened a minute
    // later. The window then says Paylaş sends the new address.
    const TUNNEL = 'https://yeni-tunel.trycloudflare.com';
    let share: jest.SpyInstance;
    beforeEach(() => {
      const { Share } = require('react-native') as typeof import('react-native');
      share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
      mockServer.url = 'http://192.168.1.20:4000';
      api.health = jest.fn(async () => ({ ok: true, version: '1', time: '', app: null, publicUrl: null }));
    });
    afterEach(() => share.mockRestore());

    const tunnelOpened = () => {
      api.health = jest.fn(async () => ({ ok: true, version: '1', time: '', app: null, publicUrl: TUNNEL }));
    };

    it('shares the tunnel address, not the home Wi-Fi one the screen read', async () => {
      const FriendsScreen = require('@/app/(app)/(tabs)/friends').default;
      const tree = renderScreen(<FriendsScreen />);
      await settle();
      expect(rendered(tree)).toContain('sadece aynı Wi-Fi');

      tunnelOpened();
      await act(async () => {
        findWith(tree, 'title', 'Paylaş', 'onPress').props.onPress();
      });
      await settle();

      expect(share).toHaveBeenCalledTimes(1);
      const { message } = share.mock.calls[0][0] as { message: string };
      expect(message).toContain(`${TUNNEL}/davet/KOY123`);
      expect(message).not.toContain('192.168.1.20');
      expect(rendered(tree)).not.toContain('sadece aynı Wi-Fi');
    });

    it('shares the address it had when the server does not answer', async () => {
      const FriendsScreen = require('@/app/(app)/(tabs)/friends').default;
      const tree = renderScreen(<FriendsScreen />);
      await settle();

      api.health = jest.fn(async () => {
        throw NETWORK_ERROR;
      });
      await act(async () => {
        findWith(tree, 'title', 'Paylaş', 'onPress').props.onPress();
      });
      await settle();

      const { message } = share.mock.calls[0][0] as { message: string };
      expect(message).toContain('http://192.168.1.20:4000/davet/KOY123');
    });

    it('reads the address again on a pull and on coming back to the tab', async () => {
      const FriendsScreen = require('@/app/(app)/(tabs)/friends').default;
      const tree = renderScreen(<FriendsScreen />);
      await settle();
      expect(api.health).toHaveBeenCalledTimes(1);

      tunnelOpened();
      act(() => {
        (tree.root.findByType(RefreshControl).props as { onRefresh: () => void }).onRefresh();
      });
      await settle();
      expect(api.health).toHaveBeenCalledTimes(1);
      expect(rendered(tree)).not.toContain('sadece aynı Wi-Fi');

      // the tunnel dropped and came back under a new name while I was on another tab
      const moved = 'https://baska-tunel.trycloudflare.com';
      api.health = jest.fn(async () => ({ ok: true, version: '1', time: '', app: null, publicUrl: moved }));
      const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 21_000);
      try {
        act(() => mockFocus.effect?.());
        await settle();
      } finally {
        clock.mockRestore();
      }
      expect(api.health).toHaveBeenCalledTimes(1);
      await act(async () => {
        findWith(tree, 'title', 'Paylaş', 'onPress').props.onPress();
      });
      await settle();
      expect((share.mock.calls[0][0] as { message: string }).message).toContain(`${moved}/davet/KOY123`);
    });
  });

  it('says whether a typed code made us kankas at once or only sent a request', async () => {
    api.health = jest.fn(async () => ({ ok: true, version: '1', time: '', app: null, publicUrl: null }));
    api.requestFriend = jest.fn(async () => ({ status: 'accepted', friendshipId: 'f-1' }));
    const FriendsScreen = require('@/app/(app)/(tabs)/friends').default;
    const tree = renderScreen(<FriendsScreen />);
    await settle();

    const addByCode = async (code: string) => {
      typeInto(tree, 'Kanka ara', code);
      // past the search box's debounce, so nobody is found and "Kod ile ekle" shows
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
      });
      await settle();
      press(tree, 'Kod ile ekle');
      await settle();
    };

    // an account in its first week: the server accepts the inviter's code on the spot
    await addByCode('ABC234');
    expect(api.requestFriend).toHaveBeenLastCalledWith({ username: undefined, inviteCode: 'ABC234' });
    expect(rendered(tree)).toContain('Kanka oldunuz');
    expect(rendered(tree)).not.toContain('İstek gönderildi.');

    // an older one still asks
    api.requestFriend = jest.fn(async () => ({ status: 'pending', friendshipId: 'f-2' }));
    await addByCode('XYZ789');
    expect(api.requestFriend).toHaveBeenCalledWith({ username: undefined, inviteCode: 'XYZ789' });
    expect(rendered(tree)).toContain('İstek gönderildi.');
  });
});

describe('kanka search with an @', () => {
  it('searches "@seyma" as seyma, and never offers it as an invite code', async () => {
    api.health = jest.fn(async () => ({ ok: true, version: '1', time: '', app: null, publicUrl: null }));
    api.requestFriend = jest.fn(async () => ({ status: 'pending', friendshipId: 'f-1' }));
    const FriendsScreen = require('@/app/(app)/(tabs)/friends').default;
    const tree = renderScreen(<FriendsScreen />);
    await settle();

    // as "Kullanıcı adını kopyala" and the davet message hand it out; nobody is found
    for (const term of ['@seyma', '@ seyma']) {
      typeInto(tree, 'Kanka ara', term);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
      });
      await settle();
      expect(api.searchUsers).toHaveBeenLastCalledWith('seyma');
      expect(rendered(tree)).toMatch(/“\s*seyma\s*” diye biri yok\./);
      // sent as a code it only got "Böyle bir kanka bulamadım"
      expect(() => findWith(tree, 'title', 'Kod ile ekle', 'onPress')).toThrow();
    }
    expect(api.requestFriend).not.toHaveBeenCalled();

    // a code typed bare still gets the button
    typeInto(tree, 'Kanka ara', 'ABC234');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await settle();
    expect(api.searchUsers).toHaveBeenLastCalledWith('ABC234');
    expect(findWith(tree, 'title', 'Kod ile ekle', 'onPress')).toBeTruthy();
  });
});

describe('the wizard\'s kanka filter', () => {
  const OZGE = { id: 'u-2', username: 'ozzy', displayName: 'Özge Çağlar', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };
  const ISMAIL = { id: 'u-3', username: 'isahin', displayName: 'İsmail Şahin', avatarEmoji: '🔥', createdAt: '2026-09-01T00:00:00.000Z' };

  it('finds Özge Çağlar by "ozge", "cag" and "@ozzy", and İsmail by "Ismail"', async () => {
    api.friends = jest.fn(async () => ({ friends: [OZGE, ISMAIL], incoming: [], outgoing: [] }));
    const NewChallengeScreen = require('@/app/(app)/challenge/new').default;
    const tree = renderScreen(<NewChallengeScreen />);
    await settle();
    const [row] = tree.root.findAll(
      (node) => typeof node.props.onSelect === 'function' && node.props.type?.key === 'adim_yarisi'
    );
    if (!row) throw new Error('adim_yarisi bulunamadı');
    act(() => {
      row.props.onSelect(row.props.type);
    });
    press(tree, 'İleri');
    press(tree, 'İleri');
    await settle();

    const listed = (term: string): string[] => {
      act(() => {
        findWith(tree, 'placeholder', 'Kanka ara...', 'onChangeText').props.onChangeText(term);
      });
      return tree.root
        .findAll((node) => typeof node.props.onToggle === 'function' && typeof node.props.user?.id === 'string')
        .map((node) => node.props.user.username as string)
        .filter((username, index, all) => all.indexOf(username) === index);
    };

    const ozge = ['ozge', 'Ozge', 'cag', '@ozzy', ' @ozzy', 'özge ç'];
    expect(ozge.map(listed)).toEqual(ozge.map(() => ['ozzy']));
    const ismail = ['Ismail', 'ISMAIL', 'isma', 'sahin'];
    expect(ismail.map(listed)).toEqual(ismail.map(() => ['isahin']));
    expect(listed('😎')).toEqual([]);
    expect(rendered(tree)).toMatch(/“\s*😎\s*” diye biri yok\./);
    expect(listed('@')).toEqual(['ozzy', 'isahin']);
  });
});

describe('login screen', () => {
  it('tells a friend who forgot the password whom to ask', async () => {
    const LoginScreen = require('@/app/(auth)/login').default;
    const tree = renderScreen(<LoginScreen />);
    await settle();
    expect(rendered(tree)).toContain('Şifreni mi unuttun? Sunucuyu açan kankana yaz, sıfırlasın.');
    expect(rendered(tree)).not.toContain('Oturumun düşmüş');
  });

  it('says why after the server ended the session, once', async () => {
    mockSession.ended = true;
    mockClearSessionEnded.mockClear();
    const LoginScreen = require('@/app/(auth)/login').default;
    const tree = renderScreen(<LoginScreen />);
    await settle();
    expect(rendered(tree)).toContain('Oturumun düşmüş, bir daha gir.');
    expect(mockClearSessionEnded).toHaveBeenCalledTimes(1);
    expect(mockSession.ended).toBe(false);

    const again = renderScreen(<LoginScreen />);
    await settle();
    expect(rendered(again)).not.toContain('Oturumun düşmüş');
  });

  it("gives the server's reason when it had one, so a password change elsewhere is not a mystery", async () => {
    mockSession.ended = true;
    mockSession.reason = 'Şifren değişti, bu telefondaki oturum kapandı. Yeni şifreyle gir.';
    const LoginScreen = require('@/app/(auth)/login').default;
    const tree = renderScreen(<LoginScreen />);
    await settle();
    expect(rendered(tree)).toContain('Şifren değişti, bu telefondaki oturum kapandı. Yeni şifreyle gir.');
    expect(rendered(tree)).not.toContain('Oturumun düşmüş');
    expect(mockSession.reason).toBeNull();
  });
});

/** The first mounted element carrying `props[key] === value` and a handler named `handler`. */
function findWith(tree: ReactTestRenderer, key: string, value: string, handler: string) {
  const [node] = tree.root.findAll(
    (candidate) => candidate.props[key] === value && typeof candidate.props[handler] === 'function'
  );
  if (!node) throw new Error(`${key}="${value}" bulunamadı`);
  return node;
}

/**
 * The nearest box around `node` that also holds a text reading `text`: the
 * column the two share, or the row that only puts them side by side.
 */
function closestHolding(node: ReactTestInstance, text: string): ReactTestInstance {
  const reads = (candidate: ReactTestInstance) =>
    typeof candidate.type === 'string' && [candidate.props.children].flat().join('') === text;
  let holder = node.parent;
  while (holder && holder.findAll(reads).length === 0) holder = holder.parent;
  if (!holder) throw new Error(`"${text}" bulunamadı`);
  return holder;
}

function press(tree: ReactTestRenderer, title: string): void {
  act(() => {
    findWith(tree, 'title', title, 'onPress').props.onPress();
  });
}

function typeInto(tree: ReactTestRenderer, label: string, text: string): void {
  act(() => {
    findWith(tree, 'label', label, 'onChangeText').props.onChangeText(text);
  });
}

describe('auth screens before a server is chosen', () => {
  const SCREENS = [
    { name: 'login', load: () => require('@/app/(auth)/login').default, submit: 'Gir bakalım' },
    { name: 'register', load: () => require('@/app/(auth)/register').default, submit: 'Kaydol ve başla' },
  ];
  const PASTE = 'Davet bağlantısı ya da 192.168.1.20';

  function paste(tree: ReactTestRenderer, text: string): void {
    act(() => {
      findWith(tree, 'placeholder', PASTE, 'onChangeText').props.onChangeText(text);
    });
  }

  let health: jest.SpyInstance | null = null;
  afterEach(async () => {
    health?.mockRestore();
    health = null;
    mockSetServerUrl.mockClear();
    await clearPendingInvite();
  });

  it.each(SCREENS)('$name asks for the invite link first and holds the submit button', async ({ load, submit }) => {
    const AuthScreen = load();
    const tree = renderScreen(<AuthScreen />);
    await settle();
    expect(rendered(tree)).toContain('Önce sunucuyu seç');
    expect(rendered(tree)).toContain('Kankanın attığı davet bağlantısını olduğu gibi yapıştır.');
    expect(findWith(tree, 'title', submit, 'onPress').props.disabled).toBe(true);
  });

  it.each(SCREENS)('$name shows no such card on a LAN address', async ({ load, submit }) => {
    mockServer.url = 'http://192.168.1.20:4000';
    const AuthScreen = load();
    const tree = renderScreen(<AuthScreen />);
    await settle();
    expect(rendered(tree)).not.toContain('Önce sunucuyu seç');
    expect(findWith(tree, 'title', submit, 'onPress').props.disabled).toBeFalsy();
  });

  it('adopts the server of a pasted WhatsApp message once it answers, and parks its code', async () => {
    health = jest.spyOn(ApiClient.prototype, 'health').mockResolvedValue({
      ok: true,
      version: '1.1.0',
      time: '',
      app: null,
      publicUrl: null,
    } as never);
    const LoginScreen = SCREENS[0]!.load();
    const tree = renderScreen(<LoginScreen />);
    paste(tree, 'Gel lan, KOYDUM’da kapışalım: https://abc.trycloudflare.com/davet/AB12CD');
    press(tree, 'Bağlan');
    await settle();
    expect(health).toHaveBeenCalledTimes(1);
    expect(mockSetServerUrl).toHaveBeenCalledWith('https://abc.trycloudflare.com');
    expect(await readPendingInvite()).toMatchObject({ code: 'AB12CD', server: 'https://abc.trycloudflare.com' });
  });

  it('sends a pasted invite from login on to register, and a bare address nowhere', async () => {
    const { router } = require('expo-router') as { router: Record<string, jest.Mock> };
    router.replace!.mockClear();
    health = jest.spyOn(ApiClient.prototype, 'health').mockResolvedValue({
      ok: true,
      version: '1.1.0',
      time: '',
      app: null,
      publicUrl: null,
    } as never);
    const LoginScreen = SCREENS[0]!.load();

    // somebody new: the login form would only ever say the password is wrong
    const invited = renderScreen(<LoginScreen />);
    paste(invited, 'Gel lan, KOYDUM’da kapışalım: https://abc.trycloudflare.com/davet/AB12CD');
    press(invited, 'Bağlan');
    await settle();
    expect(router.replace).toHaveBeenCalledWith('/(auth)/register');

    // just the address: could be anybody, so login stays
    router.replace!.mockClear();
    mockServer.url = 'http://localhost:4000';
    await clearPendingInvite();
    const bare = renderScreen(<LoginScreen />);
    paste(bare, 'https://abc.trycloudflare.com');
    press(bare, 'Bağlan');
    await settle();
    expect(mockSetServerUrl).toHaveBeenLastCalledWith('https://abc.trycloudflare.com');
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('offers register to whoever reaches login with an invite parked', async () => {
    const { router } = require('expo-router') as { router: Record<string, jest.Mock> };
    router.replace!.mockClear();
    mockServer.url = 'http://192.168.1.20:4000';
    await savePendingInvite('AB12CD', mockServer.url);
    const LoginScreen = SCREENS[0]!.load();
    const tree = renderScreen(<LoginScreen />);
    await settle();
    expect(rendered(tree)).toContain('Hesabın yoksa önce kayıt ol, kanka olursunuz.');
    press(tree, 'Hesabım yok, kayıt ol');
    expect(router.replace).toHaveBeenCalledWith('/(auth)/register');

    // register itself only says what happens next
    const RegisterScreen = SCREENS[1]!.load();
    const register = renderScreen(<RegisterScreen />);
    await settle();
    expect(rendered(register)).toContain('Kayıt olunca kanka olursunuz.');
    expect(rendered(register)).not.toContain('Hesabım yok, kayıt ol');
  });

  it('keeps the fallback and says why when the pasted server does not answer', async () => {
    health = jest.spyOn(ApiClient.prototype, 'health').mockRejectedValue(NETWORK_ERROR);
    const LoginScreen = SCREENS[0]!.load();
    const tree = renderScreen(<LoginScreen />);
    paste(tree, 'https://abc.trycloudflare.com/davet/AB12CD');
    press(tree, 'Bağlan');
    await settle();
    expect(rendered(tree)).toContain('Bu adrese ulaşamadım.');
    expect(mockSetServerUrl).not.toHaveBeenCalled();
    expect(await readPendingInvite()).toBeNull();

    // and something that is no address at all never reaches the network
    health.mockClear();
    paste(tree, 'Gel lan, KOYDUM’da kapışalım');
    press(tree, 'Bağlan');
    await settle();
    expect(rendered(tree)).toContain('Bunu adres olarak okuyamadım.');
    expect(health).not.toHaveBeenCalled();
  });
});

describe('usernames with Turkish letters', () => {
  beforeEach(() => {
    mockServer.url = 'http://192.168.1.20:4000';
    mockLogin.mockClear();
  });

  it('register shows the folded name while it is typed', async () => {
    const RegisterScreen = require('@/app/(auth)/register').default;
    const tree = renderScreen(<RegisterScreen />);
    await settle();
    typeInto(tree, 'Kullanıcı adı', 'Şeyma Nur');
    expect(findWith(tree, 'label', 'Kullanıcı adı', 'onChangeText').props.value).toBe('seymanur');
    expect(rendered(tree)).toContain('Türkçe harfler çevrilir (ş→s, ı→i).');
    expect(rendered(tree)).not.toContain('küçük harf');
  });

  it('login sends a capitalised İ as the plain i the server stores', async () => {
    const LoginScreen = require('@/app/(auth)/login').default;
    const tree = renderScreen(<LoginScreen />);
    await settle();
    typeInto(tree, 'Kullanıcı adı', 'İsmail');
    typeInto(tree, 'Şifre', 'cokgizli');
    press(tree, 'Gir bakalım');
    await settle();
    expect(mockLogin).toHaveBeenCalledWith({ username: 'ismail', password: 'cokgizli' });
  });
});

describe('a sign-up whose answer never came', () => {
  const { router } = require('expo-router') as { router: Record<string, jest.Mock> };
  const TIMEOUT = new ApiError('timeout', 'Sunucu cevap vermedi. Bağlantını kontrol et.', 0);
  const TAKEN = new ApiError('username_taken', 'Bu kullanıcı adı kapılmış. Başka bir tane dene.', 409);

  beforeEach(() => {
    mockServer.url = 'http://192.168.1.20:4000';
    mockLogin.mockClear();
    mockRegister.mockReset();
    mockSetSession.mockClear();
    router.replace!.mockClear();
  });

  async function signUp(password: string): Promise<ReactTestRenderer> {
    const RegisterScreen = require('@/app/(auth)/register').default;
    const tree = renderScreen(<RegisterScreen />);
    await settle();
    typeInto(tree, 'Kullanıcı adı', 'zeynep');
    typeInto(tree, 'Görünen ad', 'Zeynep');
    typeInto(tree, 'Şifre', password);
    press(tree, 'Kaydol ve başla');
    await settle();
    return tree;
  }

  it('signs in to the account the lost try made instead of calling the name taken', async () => {
    // the first try made the account and its answer was lost; the second hears the name is in use
    mockRegister.mockRejectedValueOnce(TIMEOUT).mockRejectedValueOnce(TAKEN);
    const tree = await signUp('gizli123');
    expect(rendered(tree)).toContain('Sunucu cevap vermedi.');
    expect(mockLogin).not.toHaveBeenCalled();

    press(tree, 'Kaydol ve başla');
    await settle();
    expect(mockLogin.mock.calls).toEqual([[{ username: 'zeynep', password: 'gizli123' }]]);
    expect(mockSetSession).toHaveBeenCalledWith('token', expect.objectContaining({ id: 'me-1' }));
    expect(router.replace).toHaveBeenCalledWith('/onboarding');
    expect(rendered(tree)).not.toContain('kapılmış');
  });

  it('keeps "kapılmış" for another password, or with no lost try before it', async () => {
    mockRegister.mockRejectedValueOnce(TIMEOUT).mockRejectedValueOnce(TAKEN);
    const changed = await signUp('gizli123');
    typeInto(changed, 'Şifre', 'baska456');
    press(changed, 'Kaydol ve başla');
    await settle();
    expect(rendered(changed)).toContain('Bu kullanıcı adı kapılmış.');

    // somebody else's name, asked about for the first time
    mockRegister.mockRejectedValueOnce(TAKEN);
    const taken = await signUp('gizli123');
    expect(rendered(taken)).toContain('Bu kullanıcı adı kapılmış.');

    expect(mockLogin).not.toHaveBeenCalled();
    expect(mockSetSession).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('says "kapılmış" when the password does not open the name after all', async () => {
    mockRegister.mockRejectedValueOnce(TIMEOUT).mockRejectedValueOnce(TAKEN);
    mockLogin.mockRejectedValueOnce(new ApiError('bad_credentials', 'Kullanıcı adı ya da şifre yanlış.', 401));
    const tree = await signUp('gizli123');
    press(tree, 'Kaydol ve başla');
    await settle();
    expect(mockLogin).toHaveBeenCalledTimes(1);
    expect(rendered(tree)).toContain('Bu kullanıcı adı kapılmış.');
    expect(rendered(tree)).not.toContain('şifre yanlış');
    expect(mockSetSession).not.toHaveBeenCalled();
  });
});

/** The (mocked) native TextInput inside the Input labelled `label`. */
function fieldOf(tree: ReactTestRenderer, label: string) {
  return findWith(tree, 'label', label, 'onChangeText').findByType(TextInput);
}

/**
 * Presses "İleri" on each field in turn and returns, for every press, whether
 * the field after it was focused. jest-expo's TextInput shares one focus() mock
 * on its prototype between every field, so each field gets its own here.
 */
function walkWithNext(tree: ReactTestRenderer, labels: string[]): boolean[] {
  const focused = labels.map((label) => {
    const focus = jest.fn();
    (fieldOf(tree, label).instance as { focus: () => void }).focus = focus;
    return focus;
  });
  return labels.slice(0, -1).map((label, index) => {
    act(() => {
      findWith(tree, 'label', label, 'onSubmitEditing').props.onSubmitEditing();
    });
    return focused[index + 1]!.mock.calls.length === 1;
  });
}

describe('the keyboard\'s "İleri" on the auth forms', () => {
  it('login goes from the username to the password, and the password is typed as it is', async () => {
    const LoginScreen = require('@/app/(auth)/login').default;
    const tree = renderScreen(<LoginScreen />);
    await settle();
    expect(walkWithNext(tree, ['Kullanıcı adı', 'Şifre'])).toEqual([true]);
    // "submit" keeps the keyboard up while the focus moves on
    expect(fieldOf(tree, 'Kullanıcı adı').props.submitBehavior).toBe('submit');
    expect(fieldOf(tree, 'Şifre').props).toMatchObject({ autoCapitalize: 'none', autoCorrect: false });
  });

  it('register walks username, display name and password', async () => {
    const RegisterScreen = require('@/app/(auth)/register').default;
    const tree = renderScreen(<RegisterScreen />);
    await settle();
    expect(walkWithNext(tree, ['Kullanıcı adı', 'Görünen ad', 'Şifre'])).toEqual([true, true]);
    expect(fieldOf(tree, 'Şifre').props).toMatchObject({ autoCapitalize: 'none', autoCorrect: false });
  });
});

describe('settings password sheet', () => {
  function openSheet(): ReactTestRenderer {
    const SettingsScreen = require('@/app/(app)/settings').default;
    const tree = renderScreen(<SettingsScreen />);
    press(tree, 'Şifreni değiştir');
    return tree;
  }

  beforeEach(() => {
    mockSetSession.mockClear();
  });

  it('flags a short new password and a repeat that does not match, and sends nothing', async () => {
    api.changePassword = jest.fn();
    const tree = openSheet();
    await settle();

    typeInto(tree, 'Mevcut şifre', '123456');
    typeInto(tree, 'Yeni şifre', 'kisa');
    typeInto(tree, 'Yeni şifre (tekrar)', 'kisaa');
    await act(async () => {
      findWith(tree, 'title', 'Değiştir', 'onPress').props.onPress();
    });

    const text = rendered(tree);
    expect(text).toContain('Yeni şifre en az 6 karakter olmalı.');
    expect(text).toContain('İkisi aynı değil, bir daha yaz.');
    expect(api.changePassword).not.toHaveBeenCalled();
  });

  it('shows a wrong current password under its field and keeps the session', async () => {
    api.changePassword = jest.fn(async () => {
      throw new ApiError('wrong_password', 'Mevcut şifren tutmadı.', 400);
    });
    const tree = openSheet();
    await settle();

    typeInto(tree, 'Mevcut şifre', 'yanlis');
    typeInto(tree, 'Yeni şifre', 'yepyeni42');
    typeInto(tree, 'Yeni şifre (tekrar)', 'yepyeni42');
    await act(async () => {
      findWith(tree, 'title', 'Değiştir', 'onPress').props.onPress();
    });
    await settle();

    // no push token registered on this phone: whatever the server holds is another phone's
    expect(api.changePassword).toHaveBeenCalledWith({ currentPassword: 'yanlis', newPassword: 'yepyeni42', pushToken: null });
    expect(rendered(tree)).toContain('Mevcut şifren tutmadı.');
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it('stores the session the server hands back', async () => {
    api.changePassword = jest.fn(async () => ({ token: 'yeni-token', me: ME }));
    await AsyncStorage.setItem('koydum.pushToken', 'ExponentPushToken[bu-telefon]');
    const tree = openSheet();
    await settle();

    typeInto(tree, 'Mevcut şifre', '123456');
    typeInto(tree, 'Yeni şifre', 'yepyeni42');
    typeInto(tree, 'Yeni şifre (tekrar)', 'yepyeni42');
    await act(async () => {
      findWith(tree, 'title', 'Değiştir', 'onPress').props.onPress();
    });
    await settle();

    expect(mockSetSession).toHaveBeenCalledWith('yeni-token', ME);
    expect(rendered(tree)).toContain('Tamamdır, yeni şifre işlendi');
    // the token this phone registered goes along, so the server keeps it
    expect(api.changePassword).toHaveBeenCalledWith({
      currentPassword: '123456',
      newPassword: 'yepyeni42',
      pushToken: 'ExponentPushToken[bu-telefon]',
    });
    await AsyncStorage.removeItem('koydum.pushToken');
  });

  it('goes from field to field on "İleri"', async () => {
    const tree = openSheet();
    await settle();
    expect(walkWithNext(tree, ['Mevcut şifre', 'Yeni şifre', 'Yeni şifre (tekrar)'])).toEqual([true, true]);
  });
});

describe('settings notification preferences', () => {
  function flip(tree: ReactTestRenderer, label: string, value: boolean): Promise<void> {
    return act(async () => {
      findWith(tree, 'accessibilityLabel', label, 'onValueChange').props.onValueChange(value);
    });
  }

  beforeEach(() => {
    mockReminders.enabled = true;
    mockReminders.set.mockClear();
    mockReminders.refresh.mockClear();
    mockSetMe.mockClear();
  });

  it('switches the nudge and the recap off on the account, and says what never goes quiet', async () => {
    api.updateMe = jest.fn(async (body: Partial<Me>) => ({ ...ME, ...body }));
    const SettingsScreen = require('@/app/(app)/settings').default;
    const tree = renderScreen(<SettingsScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('BİLDİRİM TERCİHLERİ');
    expect(text).toContain('Geride kalınca dürt beni');
    expect(text).toContain('Pazar akşamı haftalık özet');
    expect(text).toContain('Saatli çelınc uyarıları');
    // the tap after a step çelınc's end is one of them too
    expect(text).toContain('çelıncın son saatinde ve adım çelıncı bitince çalar');
    expect(text).toContain('“KOYDUM MU?” her zaman gelir, onu kapatamazsın.');

    await flip(tree, 'Geride kalınca dürt beni', false);
    await settle();
    expect(api.updateMe).toHaveBeenLastCalledWith({ nudgesEnabled: false });
    expect(mockSetMe).toHaveBeenLastCalledWith(expect.objectContaining({ nudgesEnabled: false }));
    expect(rendered(tree)).toContain('Dürtme kapatıldı');

    await flip(tree, 'Pazar akşamı haftalık özet', false);
    await settle();
    expect(api.updateMe).toHaveBeenLastCalledWith({ recapEnabled: false });
    // the phone's own alerts are not the server's business
    expect(mockReminders.set).not.toHaveBeenCalled();
  });

  it('keeps the deadline alerts on the phone: stores the switch and clears them, without the server', async () => {
    api.updateMe = jest.fn();
    const SettingsScreen = require('@/app/(app)/settings').default;
    const tree = renderScreen(<SettingsScreen />);
    await settle();

    await flip(tree, 'Saatli çelınc uyarıları', false);
    await settle();

    expect(mockReminders.set).toHaveBeenCalledWith(false);
    // stored first, then refreshed: with the switch off the refresh only clears
    expect(mockReminders.set.mock.invocationCallOrder[0]).toBeLessThan(
      mockReminders.refresh.mock.invocationCallOrder[0]!
    );
    expect(mockReminders.refresh).toHaveBeenCalledWith(api, 2, expect.any(String));
    expect(api.updateMe).not.toHaveBeenCalled();
    expect(rendered(tree)).toContain('Saatli uyarılar kapatıldı');
    expect(findWith(tree, 'accessibilityLabel', 'Saatli çelınc uyarıları', 'onValueChange').props.value).toBe(false);
  });

  it('shows the alerts switch off when this phone had it off', async () => {
    mockReminders.enabled = false;
    const SettingsScreen = require('@/app/(app)/settings').default;
    const tree = renderScreen(<SettingsScreen />);
    await settle();

    expect(findWith(tree, 'accessibilityLabel', 'Saatli çelınc uyarıları', 'onValueChange').props.value).toBe(false);
    expect(findWith(tree, 'accessibilityLabel', 'Geride kalınca dürt beni', 'onValueChange').props.value).toBe(true);
  });
});

describe('settings: what Android does in the background', () => {
  type AppStateListener = Parameters<(typeof import('react-native'))['AppState']['addEventListener']>[1];
  let appStateListeners: AppStateListener[] = [];
  /** The preset's own addEventListener is a jest.fn; a spy's mockRestore would leave it returning undefined. */
  const addEventListener = () =>
    (require('react-native') as typeof import('react-native')).AppState.addEventListener as unknown as jest.Mock;
  let preset: ((...args: unknown[]) => unknown) | undefined;

  beforeEach(() => {
    appStateListeners = [];
    preset = addEventListener().getMockImplementation();
    addEventListener().mockImplementation((_event: string, handler: AppStateListener) => {
      appStateListeners.push(handler);
      return {
        remove: () => {
          appStateListeners = appStateListeners.filter((candidate) => candidate !== handler);
        },
      };
    });
    mockDeviceHealth.requestBattery.mockClear();
    mockDeviceHealth.openAlarms.mockClear();
    mockReminders.enabled = true;
    mockReminders.refresh.mockClear();
  });

  afterEach(() => {
    if (preset) addEventListener().mockImplementation(preset);
  });

  /** The user comes back from the system page. */
  async function comeBack(): Promise<void> {
    await act(async () => {
      for (const listener of [...appStateListeners]) listener('active');
    });
    await settle();
  }

  function renderSettings(): ReactTestRenderer {
    const SettingsScreen = require('@/app/(app)/settings').default;
    return renderScreen(<SettingsScreen />);
  }

  it('is not there at all where Android has nothing to switch (iPhone, web, Expo Go)', async () => {
    const tree = renderSettings();
    await settle();
    expect(rendered(tree)).not.toContain('ARKA PLAN');
  });

  it('shows a restricted phone both rows with their buttons, and asks Android for each', async () => {
    mockDeviceHealth.state = { batteryUnrestricted: false, exactAlarms: false, xiaomi: false };
    const tree = renderSettings();
    await settle();

    const text = rendered(tree);
    expect(text).toContain('ARKA PLAN');
    expect(text).toContain('Pil kısıtlaması');
    expect(text).toContain('Uygulama kapalıyken de “KOYDUM MU?” vaktinde gelsin diye pil kısıtlamasını kaldır.');
    expect(text).toContain('Tam saatinde hatırlatma');
    expect(text).toContain('06:30’daki uyarı 07:00’yi geçebilir');
    expect(text).not.toContain('Otomatik başlatma');

    press(tree, 'Kısıtlamayı kaldır');
    await settle();
    expect(mockDeviceHealth.requestBattery).toHaveBeenCalledTimes(1);

    press(tree, 'Alarm izni ver');
    await settle();
    expect(mockDeviceHealth.openAlarms).toHaveBeenCalledTimes(1);
  });

  it('shows a phone that is already fine without buttons', async () => {
    mockDeviceHealth.state = { batteryUnrestricted: true, exactAlarms: true, xiaomi: false };
    const tree = renderSettings();
    await settle();

    const text = rendered(tree);
    expect(text).toContain('Telefon KOYDUM’u arka planda uyutmuyor.');
    expect(text).toContain('Check-in hatırlatmaları tam saatinde çalar.');
    expect(() => findWith(tree, 'title', 'Kısıtlamayı kaldır', 'onPress')).toThrow();
    expect(() => findWith(tree, 'title', 'Alarm izni ver', 'onPress')).toThrow();
  });

  it('reads the switch again on return and reschedules the reminders once exact alarms are allowed', async () => {
    mockDeviceHealth.state = { batteryUnrestricted: true, exactAlarms: false, xiaomi: false };
    const tree = renderSettings();
    await settle();

    press(tree, 'Alarm izni ver');
    await settle();
    // granted on the system page
    mockDeviceHealth.state = { batteryUnrestricted: true, exactAlarms: true, xiaomi: false };
    await comeBack();

    expect(rendered(tree)).toContain('Check-in hatırlatmaları tam saatinde çalar.');
    // the alarms already set were inexact; they are set again now
    expect(mockReminders.refresh).toHaveBeenCalledWith(api, 2, expect.any(String));
  });

  it('leaves the reminders alone when the user came back without allowing it', async () => {
    mockDeviceHealth.state = { batteryUnrestricted: false, exactAlarms: false, xiaomi: false };
    const tree = renderSettings();
    await settle();

    press(tree, 'Kısıtlamayı kaldır');
    await settle();
    mockDeviceHealth.state = { batteryUnrestricted: true, exactAlarms: false, xiaomi: false };
    await comeBack();

    expect(rendered(tree)).toContain('Telefon KOYDUM’u arka planda uyutmuyor.');
    expect(mockReminders.refresh).not.toHaveBeenCalled();
  });

  it('says where the switch is when the system page will not open', async () => {
    mockDeviceHealth.state = { batteryUnrestricted: false, exactAlarms: true, xiaomi: false };
    mockDeviceHealth.requestBattery.mockResolvedValueOnce(false);
    const tree = renderSettings();
    await settle();

    press(tree, 'Kısıtlamayı kaldır');
    await settle();
    expect(rendered(tree)).toContain('Ayarlar açılamadı');
    expect(rendered(tree)).toContain('“Kısıtlanmamış”ı seç');
  });

  it('tells a Xiaomi owner about MIUI’s own autostart switch', async () => {
    mockDeviceHealth.state = { batteryUnrestricted: false, exactAlarms: true, xiaomi: true };
    const tree = renderSettings();
    await settle();
    expect(rendered(tree)).toContain('“Otomatik başlatma”yı aç');
  });
});

/*
 * Health Connect answers a closed app only with its background permission, so
 * the 15-minute task never read it and a watch's steps waited for the app to
 * open. Phones that granted Steps before 1.1.1 were never asked.
 */
describe('settings: Health Connect read in the background', () => {
  const steps = () =>
    require('@/services/steps') as {
      getStepAvailability: jest.Mock;
      healthConnectBackgroundMissing: jest.Mock;
      requestHealthConnectBackground: jest.Mock;
      openHealthConnectSettingsIfPossible: jest.Mock;
    };
  const FROM_HEALTH_CONNECT = { available: true, source: 'health_connect', approximate: false };
  const REFUSED =
    'Dokun, Health Connect’i açayım: Uygulama izinleri → KOYDUM → Ek erişim → “Verilere arka planda erişim”i aç. Ek erişim hiç yoksa telefonundaki Health Connect bunu desteklemiyor.';

  beforeEach(() => {
    steps().requestHealthConnectBackground.mockClear();
    steps().openHealthConnectSettingsIfPossible.mockClear();
  });

  afterEach(() => {
    steps().getStepAvailability.mockResolvedValue({ available: false, reason: 'web' });
    steps().healthConnectBackgroundMissing.mockResolvedValue(false);
    steps().requestHealthConnectBackground.mockResolvedValue(false);
    steps().openHealthConnectSettingsIfPossible.mockResolvedValue(false);
  });

  async function renderSettings(): Promise<ReactTestRenderer> {
    const SettingsScreen = require('@/app/(app)/settings').default;
    const tree = renderScreen(<SettingsScreen />);
    await settle();
    return tree;
  }

  const offered = (tree: ReactTestRenderer) => {
    try {
      findWith(tree, 'title', 'Arka planda da okusun', 'onPress');
      return true;
    } catch {
      return false;
    }
  };

  it('is offered only while Health Connect is the source and the background task cannot read it', async () => {
    steps().getStepAvailability.mockResolvedValue(FROM_HEALTH_CONNECT);
    steps().healthConnectBackgroundMissing.mockResolvedValue(true);
    let tree = await renderSettings();
    expect(offered(tree)).toBe(true);
    expect(rendered(tree)).toContain('Health Connect’teki adımların şimdilik sadece KOYDUM açıkken okunuyor.');

    // the phone's own count is the source: Health Connect has nothing to read
    steps().getStepAvailability.mockResolvedValue({ available: true, source: 'pedometer', approximate: false, hcEmpty: true });
    tree = await renderSettings();
    expect(offered(tree)).toBe(false);

    steps().getStepAvailability.mockResolvedValue(FROM_HEALTH_CONNECT);
    steps().healthConnectBackgroundMissing.mockResolvedValue(false);
    tree = await renderSettings();
    expect(offered(tree)).toBe(false);
    expect(rendered(tree)).toContain('Health Connect’ten günlük adımların otomatik geliyor.');
  });

  it('asks Health Connect, reads the state again and goes once it is granted', async () => {
    steps().getStepAvailability.mockResolvedValue(FROM_HEALTH_CONNECT);
    steps().healthConnectBackgroundMissing.mockResolvedValue(true);
    const tree = await renderSettings();

    steps().requestHealthConnectBackground.mockResolvedValueOnce(true);
    steps().healthConnectBackgroundMissing.mockResolvedValue(false);
    press(tree, 'Arka planda da okusun');
    await settle();

    expect(steps().requestHealthConnectBackground).toHaveBeenCalledTimes(1);
    expect(offered(tree)).toBe(false);
    expect(rendered(tree)).toContain('Health Connect’teki adımların artık uygulama kapalıyken de gelir.');
  });

  it('a refusal stays offered, with a toast that opens Health Connect', async () => {
    steps().getStepAvailability.mockResolvedValue(FROM_HEALTH_CONNECT);
    steps().healthConnectBackgroundMissing.mockResolvedValue(true);
    const tree = await renderSettings();

    press(tree, 'Arka planda da okusun');
    await settle();
    expect(offered(tree)).toBe(true);
    expect(rendered(tree)).toContain('İzin verilmedi');

    const [toast] = tree.root.findAll(
      (node) =>
        node.props.accessibilityRole === 'button' &&
        typeof node.props.onPress === 'function' &&
        node.findAll((child) => child.props.children === REFUSED).length > 0
    );
    expect(toast).toBeDefined();
    act(() => {
      toast!.props.onPress();
    });
    await settle();
    expect(steps().openHealthConnectSettingsIfPossible).toHaveBeenCalledTimes(1);
  });

  // the toast sends them to Health Connect's own switch: on return the card
  // must not go on saying it is read only while KOYDUM is open
  it('looks again on the way back from Health Connect', async () => {
    type AppStateListener = Parameters<(typeof import('react-native'))['AppState']['addEventListener']>[1];
    const addEventListener = (require('react-native') as typeof import('react-native')).AppState
      .addEventListener as unknown as jest.Mock;
    const preset = addEventListener.getMockImplementation();
    let listeners: AppStateListener[] = [];
    addEventListener.mockImplementation((_event: string, handler: AppStateListener) => {
      listeners.push(handler);
      return { remove: () => (listeners = listeners.filter((candidate) => candidate !== handler)) };
    });
    try {
      steps().getStepAvailability.mockResolvedValue(FROM_HEALTH_CONNECT);
      steps().healthConnectBackgroundMissing.mockResolvedValue(true);
      steps().openHealthConnectSettingsIfPossible.mockResolvedValue(true);
      const tree = await renderSettings();

      press(tree, 'Arka planda da okusun');
      await settle();
      const [toast] = tree.root.findAll(
        (node) =>
          node.props.accessibilityRole === 'button' &&
          typeof node.props.onPress === 'function' &&
          node.findAll((child) => child.props.children === REFUSED).length > 0
      );
      act(() => {
        toast!.props.onPress();
      });
      await settle();

      // switched on over there
      steps().healthConnectBackgroundMissing.mockResolvedValue(false);
      await act(async () => {
        for (const listener of [...listeners]) listener('active');
      });
      await settle();
      expect(offered(tree)).toBe(false);
      expect(rendered(tree)).toContain('Health Connect’ten günlük adımların otomatik geliyor.');
    } finally {
      if (preset) addEventListener.mockImplementation(preset);
    }
  });
});

describe('the battery card on the home screen', () => {
  const storage = () => require('@/lib/storage') as typeof import('@/lib/storage');

  afterEach(async () => {
    const { StorageKeys, removeItem } = storage();
    await removeItem(StorageKeys.pushReason);
    await removeItem(StorageKeys.dismissedBatteryCard);
  });

  async function renderHome(): Promise<ReactTestRenderer> {
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const tree = renderScreen(<HomeScreen />);
    await settle();
    return tree;
  }

  it('shows once on a Firebase-less build that Android holds back, and "Kalsın" puts it away for good', async () => {
    const { StorageKeys, getItem, setItem } = storage();
    await setItem(StorageKeys.pushReason, 'no-fcm');
    mockDeviceHealth.state = { batteryUnrestricted: false, exactAlarms: true, xiaomi: false };
    mockDeviceHealth.requestBattery.mockClear();

    const tree = await renderHome();
    expect(rendered(tree)).toContain('Laflar sana geç gelebilir');

    press(tree, 'Kısıtlamayı kaldır');
    await settle();
    expect(mockDeviceHealth.requestBattery).toHaveBeenCalledTimes(1);

    press(tree, 'Kalsın');
    await settle();
    expect(rendered(tree)).not.toContain('Laflar sana geç gelebilir');
    expect(await getItem(StorageKeys.dismissedBatteryCard)).toBe('1');

    const again = await renderHome();
    expect(rendered(again)).not.toContain('Laflar sana geç gelebilir');
  });

  it('stays away when push works or the phone is not restricted', async () => {
    const { StorageKeys, setItem } = storage();
    mockDeviceHealth.state = { batteryUnrestricted: false, exactAlarms: true, xiaomi: false };
    // a token (no reason stored): push itself is not held back by battery optimisation
    expect(rendered(await renderHome())).not.toContain('Laflar sana geç gelebilir');

    await setItem(StorageKeys.pushReason, 'no-fcm');
    mockDeviceHealth.state = { batteryUnrestricted: true, exactAlarms: true, xiaomi: false };
    expect(rendered(await renderHome())).not.toContain('Laflar sana geç gelebilir');
  });
});

describe('a permission the phone said no to', () => {
  const storage = () => require('@/lib/storage') as typeof import('@/lib/storage');
  const notifications = () => require('@/services/notifications') as { registerForPush: jest.Mock };
  const steps = () => require('@/services/steps') as { requestStepPermission: jest.Mock };

  type AppStateListener = Parameters<(typeof import('react-native'))['AppState']['addEventListener']>[1];
  let appStateListeners: AppStateListener[] = [];
  /** The preset's own addEventListener is a jest.fn; a spy's mockRestore would leave it returning undefined. */
  const addEventListener = () =>
    (require('react-native') as typeof import('react-native')).AppState.addEventListener as unknown as jest.Mock;
  let preset: ((...args: unknown[]) => unknown) | undefined;

  beforeEach(() => {
    appStateListeners = [];
    preset = addEventListener().getMockImplementation();
    addEventListener().mockImplementation((_event: string, handler: AppStateListener) => {
      appStateListeners.push(handler);
      return {
        remove: () => {
          appStateListeners = appStateListeners.filter((candidate) => candidate !== handler);
        },
      };
    });
    mockDeviceHealth.openSettings.mockClear();
    notifications().registerForPush.mockClear();
  });

  afterEach(async () => {
    if (preset) addEventListener().mockImplementation(preset);
    const { StorageKeys, removeItem } = storage();
    await removeItem(StorageKeys.dismissedNotifCard);
  });

  /** The user comes back from the system page. */
  async function comeBack(): Promise<void> {
    await act(async () => {
      for (const listener of [...appStateListeners]) listener('active');
    });
    await settle();
  }

  async function renderHome(): Promise<ReactTestRenderer> {
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const tree = renderScreen(<HomeScreen />);
    await settle();
    return tree;
  }

  /** Taps the toast that is on screen, the one showing `body`. */
  function tapToast(tree: ReactTestRenderer, body: string): void {
    const [toast] = tree.root.findAll(
      (node) =>
        node.props.accessibilityRole === 'button' &&
        typeof node.props.onPress === 'function' &&
        node.findAll((child) => child.props.children === body).length > 0
    );
    if (!toast) throw new Error(`"${body}" diyen bildirim yok`);
    act(() => {
      toast.props.onPress();
    });
  }

  it('home says notifications are off, opens KOYDUM’s settings page, and goes once they are on', async () => {
    mockNotifPermission.status = 'denied';
    const tree = await renderHome();
    expect(rendered(tree)).toContain('Bildirimlerin kapalı');
    expect(rendered(tree)).toContain('check-in hatırlatmaları da çalmaz');

    press(tree, 'Ayarları aç');
    await settle();
    expect(mockDeviceHealth.openSettings).toHaveBeenCalledTimes(1);

    // switched on over there; the card reads it again on the way back
    mockNotifPermission.status = 'granted';
    await comeBack();
    expect(rendered(tree)).not.toContain('Bildirimlerin kapalı');
  });

  it('home shows nothing while the permission is granted or was never asked', async () => {
    expect(rendered(await renderHome())).not.toContain('Bildirimlerin kapalı');
    mockNotifPermission.status = 'undetermined';
    expect(rendered(await renderHome())).not.toContain('Bildirimlerin kapalı');
  });

  it('"Kalsın" puts the card away for good', async () => {
    mockNotifPermission.status = 'denied';
    const tree = await renderHome();
    press(tree, 'Kalsın');
    await settle();
    expect(rendered(tree)).not.toContain('Bildirimlerin kapalı');
    const { StorageKeys, getItem } = storage();
    expect(await getItem(StorageKeys.dismissedNotifCard)).toBe('1');
    expect(rendered(await renderHome())).not.toContain('Bildirimlerin kapalı');
  });

  it('says where the switch is when the settings page will not open', async () => {
    mockNotifPermission.status = 'denied';
    mockDeviceHealth.openSettings.mockResolvedValueOnce(false);
    const tree = await renderHome();
    press(tree, 'Ayarları aç');
    await settle();
    expect(rendered(tree)).toContain('Ayarlar açılamadı');
    expect(rendered(tree)).toContain('KOYDUM → Bildirimler');
  });

  it('Ayarlar gives a denied push row the way to the settings page, and looks again on return', async () => {
    notifications().registerForPush.mockResolvedValue({ token: null, granted: false, reason: 'denied' });
    try {
      const SettingsScreen = require('@/app/(app)/settings').default;
      const tree = renderScreen(<SettingsScreen />);
      await settle();
      expect(rendered(tree)).toContain('“Ayarları aç”a bas');
      // opening the screen only looks: the slide or the bridge already asked this run
      expect(notifications().registerForPush.mock.calls).toEqual([[{ askAgain: false }]]);
      // "Tekrar dene" is a tap, and a tap asks
      press(tree, 'Tekrar dene');
      await settle();
      expect(notifications().registerForPush.mock.calls.at(-1)).toEqual([{}]);
      const asked = notifications().registerForPush.mock.calls.length;

      press(tree, 'Ayarları aç');
      await settle();
      expect(mockDeviceHealth.openSettings).toHaveBeenCalledTimes(1);

      notifications().registerForPush.mockResolvedValue({ token: null, granted: true, reason: 'no-fcm' });
      await comeBack();
      expect(notifications().registerForPush.mock.calls.length).toBe(asked + 1);
      // and so does coming back from the system page
      expect(notifications().registerForPush.mock.calls.at(-1)).toEqual([{ askAgain: false }]);
      expect(() => findWith(tree, 'title', 'Ayarları aç', 'onPress')).toThrow();
    } finally {
      notifications().registerForPush.mockResolvedValue({ token: null, reason: 'web' });
    }
  });

  it('Ayarlar does not take the push slot back for a token this phone already sent, but "Tekrar dene" does', async () => {
    const { StorageKeys, setItem, removeItem } = storage();
    notifications().registerForPush.mockResolvedValue({ token: 'ExponentPushToken[eski]', granted: true });
    api.setPushToken = jest.fn(async () => ({ ok: true }));
    await setItem(StorageKeys.pushToken, 'ExponentPushToken[eski]');
    const hadToken = ME.hasPushToken;
    // the server holds a token for the account: the new phone's, after a move
    ME.hasPushToken = true;
    try {
      const SettingsScreen = require('@/app/(app)/settings').default;
      const tree = renderScreen(<SettingsScreen />);
      await settle();
      expect(api.setPushToken).not.toHaveBeenCalled();

      press(tree, 'Tekrar dene');
      await settle();
      expect(api.setPushToken).toHaveBeenCalledTimes(1);
    } finally {
      ME.hasPushToken = hadToken;
      notifications().registerForPush.mockResolvedValue({ token: null, reason: 'web' });
      await removeItem(StorageKeys.pushToken);
    }
  });

  it('Ayarlar says when the push slot is another device\'s, and is right again after "Tekrar dene"', async () => {
    const { StorageKeys, setItem, removeItem } = storage();
    notifications().registerForPush.mockResolvedValue({ token: 'ExponentPushToken[eski]', granted: true });
    api.setPushToken = jest.fn(async () => ({ ok: true }));
    // the slot holds the tablet's token: taken, but not by this phone
    api.me = jest.fn(async () => ({ ...ME, hasPushToken: true, pushTokenIsThisPhone: false }));
    await setItem(StorageKeys.pushToken, 'ExponentPushToken[eski]');
    const hadToken = ME.hasPushToken;
    ME.hasPushToken = true;
    try {
      const SettingsScreen = require('@/app/(app)/settings').default;
      const tree = renderScreen(<SettingsScreen />);
      await settle();
      expect(api.me).toHaveBeenCalledWith({ pushToken: 'ExponentPushToken[eski]' });
      expect(rendered(tree)).toContain('Başka cihazda');
      expect(rendered(tree)).toContain('Bildirimler hesabının başka bir cihazına gidiyor.');
      expect(rendered(tree)).not.toContain('Bildirimler telefonuna düşüyor.');

      press(tree, 'Tekrar dene');
      await settle();
      expect(api.setPushToken).toHaveBeenCalledTimes(1);
      expect(rendered(tree)).toContain('Bildirimler telefonuna düşüyor.');
      expect(rendered(tree)).not.toContain('Başka cihazda');
    } finally {
      ME.hasPushToken = hadToken;
      delete api.me;
      notifications().registerForPush.mockResolvedValue({ token: null, reason: 'web' });
      await removeItem(StorageKeys.pushToken);
    }
  });

  it('Ayarlar sends the token when the server has none for the account', async () => {
    notifications().registerForPush.mockResolvedValue({ token: 'ExponentPushToken[yeni]', granted: true });
    api.setPushToken = jest.fn(async () => ({ ok: true }));
    try {
      const SettingsScreen = require('@/app/(app)/settings').default;
      renderScreen(<SettingsScreen />);
      await settle();
      expect(api.setPushToken).toHaveBeenCalledWith({ token: 'ExponentPushToken[yeni]', platform: expect.any(String) });
    } finally {
      notifications().registerForPush.mockResolvedValue({ token: null, reason: 'web' });
      const { StorageKeys, removeItem } = storage();
      await removeItem(StorageKeys.pushToken);
    }
  });

  it('a step permission refused in Ayarlar leaves a toast that opens the settings page', async () => {
    steps().requestStepPermission.mockResolvedValueOnce(false);
    const SettingsScreen = require('@/app/(app)/settings').default;
    const tree = renderScreen(<SettingsScreen />);
    await settle();

    press(tree, 'İzin ver');
    await settle();
    expect(rendered(tree)).toContain('İzin verilmedi');
    tapToast(tree, 'Dokun, ayarları açayım: Fiziksel aktivite iznini aç.');
    await settle();
    expect(mockDeviceHealth.openSettings).toHaveBeenCalledTimes(1);
  });

  it('so does one refused from the home screen’s step card', async () => {
    const stepsModule = require('@/services/steps') as { getStepAvailability: jest.Mock };
    stepsModule.getStepAvailability.mockResolvedValue({ available: false, reason: 'denied' });
    steps().requestStepPermission.mockResolvedValueOnce(false);
    try {
      const tree = await renderHome();
      press(tree, 'İZİN VER');
      await settle();
      tapToast(tree, 'Dokun, ayarları açayım: Fiziksel aktivite iznini aç.');
      await settle();
      expect(mockDeviceHealth.openSettings).toHaveBeenCalledTimes(1);
    } finally {
      stepsModule.getStepAvailability.mockResolvedValue({ available: false, reason: 'web' });
    }
  });
});

describe('usage access Android greys out as "Kısıtlanmış ayar"', () => {
  const { Platform } = require('react-native') as typeof import('react-native');
  let os: { restore: () => void } | null = null;
  let version: jest.SpyInstance | null = null;

  /** An Android phone on API `api`, without usage access unless a test says otherwise. */
  function android(api: number): void {
    os = jest.replaceProperty(Platform, 'OS', 'android');
    // a getter on the preset's Platform, so a spy rather than replaceProperty
    version = jest.spyOn(Platform, 'Version', 'get').mockReturnValue(api);
  }

  beforeEach(() => {
    mockScreenTime.availability = { available: false, reason: 'permission' };
    mockDeviceHealth.openSettings.mockClear();
  });

  afterEach(() => {
    mockScreenTime.availability = null;
    version?.mockRestore();
    version = null;
    os?.restore();
    os = null;
  });

  async function renderSettings(): Promise<ReactTestRenderer> {
    const SettingsScreen = require('@/app/(app)/settings').default;
    const tree = renderScreen(<SettingsScreen />);
    await settle();
    return tree;
  }

  it('Ayarlar says where the unlock is on Android 15 and opens KOYDUM’s App info page', async () => {
    android(35);
    const tree = await renderSettings();

    const text = rendered(tree);
    expect(text).toContain('Kullanım erişimi ver');
    expect(text).toContain('“Kısıtlanmış ayar”');
    expect(text).toContain('KOYDUM → sağ üstteki ⋮ → “Kısıtlanmış ayarlara izin ver”');
    expect(text).toContain('Bazı telefonlarda');

    // services/deviceHealth's own test checks this is Linking.openSettings, KOYDUM's App info
    press(tree, 'Uygulama bilgilerini aç');
    await settle();
    expect(mockDeviceHealth.openSettings).toHaveBeenCalledTimes(1);
  });

  it('says where to go by hand when that page will not open', async () => {
    android(35);
    mockDeviceHealth.openSettings.mockResolvedValueOnce(false);
    const tree = await renderSettings();
    press(tree, 'Uygulama bilgilerini aç');
    await settle();
    expect(rendered(tree)).toContain('Ayarlar açılamadı');
    expect(rendered(tree)).toContain('Ayarlar → Uygulamalar → KOYDUM yolundan gir, sağ üstteki ⋮ menüsüne bak.');
  });

  it('stays out of the way before Android 15, and once access is given', async () => {
    android(34);
    let tree = await renderSettings();
    expect(rendered(tree)).toContain('Kullanım erişimi ver');
    expect(rendered(tree)).not.toContain('Kısıtlanmış ayar');
    expect(() => findWith(tree, 'title', 'Uygulama bilgilerini aç', 'onPress')).toThrow();

    version?.mockReturnValue(36);
    mockScreenTime.availability = { available: true, source: 'usage_stats' };
    tree = await renderSettings();
    expect(rendered(tree)).not.toContain('Kısıtlanmış ayar');
    expect(() => findWith(tree, 'title', 'Uygulama bilgilerini aç', 'onPress')).toThrow();
  });

  it('the screen-time çelınc says it under its own permission button', async () => {
    android(35);
    searchParams.id = 'c-1';
    const detail = challengeDetail();
    api.challenge = jest.fn(async () => ({
      ...detail,
      challenge: {
        ...detail.challenge,
        typeKey: 'ekran_suresi_beyani',
        metricType: 'manual_lower_is_better' as const,
        direction: 'lower' as const,
        unit: 'dk',
      },
    }));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    // the button titles render in capitals here, so they are found by title
    findWith(tree, 'title', 'Kullanım erişimi ver', 'onPress');
    expect(rendered(tree)).toContain('“Kısıtlanmış ayarlara izin ver”');
    press(tree, 'Uygulama bilgilerini aç');
    await settle();
    expect(mockDeviceHealth.openSettings).toHaveBeenCalledTimes(1);
    // the typed fallback is still there for whoever gives up on Settings
    findWith(tree, 'title', 'Şimdilik elle gir', 'onPress');
  });
});

describe('the Android back button', () => {
  type BackListener = Parameters<(typeof import('react-native'))['BackHandler']['addEventListener']>[1];

  /** Listeners the screen registered, newest last: Android asks the newest first. */
  let listeners: BackListener[] = [];
  let spy: jest.SpyInstance;

  beforeEach(() => {
    listeners = [];
    const { BackHandler } = require('react-native') as typeof import('react-native');
    spy = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
      listeners.push(handler);
      return {
        remove: () => {
          listeners = listeners.filter((candidate) => candidate !== handler);
        },
      };
    });
    const { router } = require('expo-router') as { router: Record<string, jest.Mock> };
    router.back!.mockClear();
    router.replace!.mockClear();
  });

  afterEach(() => {
    spy.mockRestore();
    delete mockPreventRemove.prevent;
  });

  /**
   * Focuses the screen as it renders now, presses back once and says whether
   * the screen kept the press (false means Android goes on to close it).
   */
  function pressBack(): boolean {
    let handled = false;
    act(() => {
      // a focus effect may hand back its cleanup, which runs on blur
      const cleanup: unknown = mockFocus.effect?.();
      const newest = listeners[listeners.length - 1];
      handled = newest ? newest({ type: 'hardwareBackPress', timeStamp: Date.now() }) === true : false;
      if (typeof cleanup === 'function') cleanup();
    });
    return handled;
  }

  function chooseType(tree: ReactTestRenderer, key: string): void {
    const [row] = tree.root.findAll(
      (node) => typeof node.props.onSelect === 'function' && node.props.type?.key === key
    );
    if (!row) throw new Error(`${key} bulunamadı`);
    act(() => {
      row.props.onSelect(row.props.type);
    });
  }

  it('walks the wizard back a step at a time instead of closing it', async () => {
    const NewChallengeScreen = require('@/app/(app)/challenge/new').default;
    const tree = renderScreen(<NewChallengeScreen />);
    await settle();
    chooseType(tree, 'adim_yarisi');
    press(tree, 'İleri');
    press(tree, 'İleri');
    expect(rendered(tree)).toContain('Kime koyacaksın?');

    expect(pressBack()).toBe(true);
    expect(rendered(tree)).toContain('Kuralları koy');
    expect(pressBack()).toBe(true);
    expect(rendered(tree)).toContain('Ne üzerine koyuyoruz?');

    const { router } = require('expo-router') as { router: Record<string, jest.Mock> };
    expect(router.back).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('asks before throwing a chosen type away on the first step, and closes on "Çık"', async () => {
    const { Alert } = require('react-native') as typeof import('react-native');
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    try {
      const NewChallengeScreen = require('@/app/(app)/challenge/new').default;
      const tree = renderScreen(<NewChallengeScreen />);
      await settle();
      chooseType(tree, 'adim_yarisi');

      expect(pressBack()).toBe(true);
      expect(alert).toHaveBeenCalledTimes(1);
      const [title, , buttons] = alert.mock.calls[0]!;
      expect(title).toBe('Çıkıyor musun?');
      const { router } = require('expo-router') as { router: Record<string, jest.Mock> };
      expect(router.replace).not.toHaveBeenCalled();

      await act(async () => {
        buttons?.find((button) => button.text === 'Çık')?.onPress?.();
      });
      // opened straight into the wizard, so there is no history to pop
      expect(router.replace).toHaveBeenCalledWith('/(app)/(tabs)');
    } finally {
      alert.mockRestore();
    }
  });

  it('closes the wizard into the friends tab when there is no kanka to pick', async () => {
    const { router } = require('expo-router') as { router: Record<string, jest.Mock> };
    router.replace!.mockClear();
    router.navigate!.mockClear();
    router.dismissAll!.mockClear();
    const NewChallengeScreen = require('@/app/(app)/challenge/new').default;
    const tree = renderScreen(<NewChallengeScreen />);
    await settle();
    chooseType(tree, 'adim_yarisi');
    press(tree, 'İleri');
    press(tree, 'İleri');
    await settle();
    expect(rendered(tree)).toContain('Kanka yok');

    // the wizard is a modal over the tab bar; replacing it put a second tab bar there
    router.canDismiss!.mockReturnValueOnce(true);
    press(tree, 'Kankaları Çağır');
    expect(router.dismissAll).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith('/(app)/(tabs)/friends');
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('lets Android close the wizard when nothing has been chosen yet', async () => {
    const NewChallengeScreen = require('@/app/(app)/challenge/new').default;
    renderScreen(<NewChallengeScreen />);
    await settle();
    expect(pressBack()).toBe(false);
  });

  it('asks "Seansı bitirelim mi?" during a running focus session instead of leaving', async () => {
    searchParams.id = 'c-1';
    const detail = challengeDetail();
    api.challenge = jest.fn(async () => ({
      ...detail,
      challenge: { ...detail.challenge, typeKey: 'odak_seansi', metricType: 'focus_minutes' as const, unit: 'dk' },
    }));
    const FocusScreen = require('@/app/(app)/focus/[id]').default;
    const tree = renderScreen(<FocusScreen />);
    await settle();

    // on the picker nothing is at stake yet: back is Android's
    expect(pressBack()).toBe(false);
    expect(mockPreventRemove.prevent).toBe(false);

    press(tree, 'Başlat');
    expect(rendered(tree)).toContain('Elini telefondan çek');
    expect(rendered(tree)).not.toContain('Seansı bitirelim mi?');
    expect(mockPreventRemove.prevent).toBe(true);

    expect(pressBack()).toBe(true);
    expect(rendered(tree)).toContain('Seansı bitirelim mi?');
    const { router } = require('expo-router') as { router: Record<string, jest.Mock> };
    expect(router.back).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();

    // once they say so, the burnt session no longer holds the screen
    press(tree, 'Evet, vazgeçtim');
    expect(rendered(tree)).toContain('Seans yandı');
    expect(mockPreventRemove.prevent).toBe(false);
    expect(pressBack()).toBe(false);

    const { saveSession } = require('@/services/focus') as typeof import('@/services/focus');
    await act(async () => {
      await saveSession(null);
    });
  });

  it('keeps the running timer, and its guard, when a refetch of the çelınc fails', async () => {
    searchParams.id = 'c-1';
    const detail = challengeDetail();
    api.challenge = jest.fn(async () => ({
      ...detail,
      challenge: { ...detail.challenge, typeKey: 'odak_seansi', metricType: 'focus_minutes' as const, unit: 'dk' },
    }));
    const FocusScreen = require('@/app/(app)/focus/[id]').default;
    const tree = renderScreen(<FocusScreen />);
    await settle();
    press(tree, 'Başlat');

    // the 45 s refetch hits a dead tunnel (or airplane mode, for focus)
    api.challenge = jest.fn(async () => {
      throw NETWORK_ERROR;
    });
    await act(async () => {
      await clientOf(tree).refetchQueries({ queryKey: ['challenge', 'c-1'] });
    });
    await settle();

    // it used to become "Seans açılmadı" with an unguarded back and a "Geri dön" that dropped the session
    expect(rendered(tree)).toContain('Elini telefondan çek');
    expect(rendered(tree)).not.toContain('Seans açılmadı');
    expect(mockPreventRemove.prevent).toBe(true);
    expect(pressBack()).toBe(true);
    expect(rendered(tree)).toContain('Seansı bitirelim mi?');

    const { saveSession } = require('@/services/focus') as typeof import('@/services/focus');
    await act(async () => {
      await saveSession(null);
    });
  });
});

describe('the focus timer on a short phone', () => {
  // The timer was the one screen with buttons that could not scroll: on a
  // 640 dp phone with the 3-button bar, the paused card pushed "Vazgeç" under it
  it('scrolls, and its last button ends above the navigation bar', async () => {
    searchParams.id = 'c-1';
    const detail = challengeDetail();
    api.challenge = jest.fn(async () => ({
      ...detail,
      challenge: { ...detail.challenge, typeKey: 'odak_seansi', metricType: 'focus_minutes' as const, unit: 'dk' },
    }));
    const FocusScreen = require('@/app/(app)/focus/[id]').default;
    const tree = renderScreen(<FocusScreen />);
    await settle();
    press(tree, 'Başlat');
    expect(rendered(tree)).toContain('Elini telefondan çek');

    let scroller = findWith(tree, 'title', 'Vazgeç', 'onPress').parent;
    while (scroller && scroller.type !== ScrollView) scroller = scroller.parent;
    expect(scroller).not.toBeNull();
    expect(StyleSheet.flatten(scroller!.props.contentContainerStyle).paddingBottom).toBe(
      Spacing.xxl + SAFE_AREA.insets.bottom
    );

    const { saveSession } = require('@/services/focus') as typeof import('@/services/focus');
    await act(async () => {
      await saveSession(null);
    });
  });
});

describe('a focus session the server did not answer for', () => {
  const { readQueue, removeFromQueue } = require('@/services/offlineQueue') as typeof import('@/services/offlineQueue');
  const { StorageKeys, setJson } = require('@/lib/storage') as typeof import('@/lib/storage');
  const { saveSession } = require('@/services/focus') as typeof import('@/services/focus');

  async function openFocus(): Promise<ReactTestRenderer> {
    searchParams.id = 'c-1';
    const detail = challengeDetail();
    api.challenge = jest.fn(async () => ({
      ...detail,
      challenge: { ...detail.challenge, typeKey: 'odak_seansi', metricType: 'focus_minutes' as const, unit: 'dk' },
    }));
    const FocusScreen = require('@/app/(app)/focus/[id]').default;
    const tree = renderScreen(<FocusScreen />);
    await settle();
    return tree;
  }

  /** The default 25 minutes, sat through: the clock jumps and the timer's next tick finishes it. */
  async function sitThrough(tree: ReactTestRenderer): Promise<void> {
    press(tree, 'Başlat');
    expect(rendered(tree)).toMatch(/Hedef\s+25dk/);
    jest.setSystemTime(Date.now() + 25 * 60_000);
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    await settle();
  }

  beforeEach(async () => {
    // the account the phone has stored, as after a sign-in: the queue parks under it
    await setJson(StorageKeys.me, ME);
    // the clock and the timer's tick are faked; the query and settle() still need real timeouts
    jest.useFakeTimers({
      doNotFake: [
        'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
        'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      ],
    });
  });

  afterEach(async () => {
    jest.useRealTimers();
    for (const item of await readQueue()) await removeFromQueue(item.id);
    await AsyncStorage.removeItem(StorageKeys.me);
    await act(async () => {
      await saveSession(null);
    });
  });

  it('says a finished session waits on the phone, not that it went on the score', async () => {
    api.addEntry = jest.fn(async () => {
      throw NETWORK_ERROR;
    });
    const tree = await openFocus();
    await sitThrough(tree);

    const queue = await readQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ challengeId: 'c-1', body: { source: 'focus', value: 25 } });
    // the server never saw it: a green "25dk skoruna eklendi." was a score nobody had
    const text = rendered(tree);
    expect(text).toContain('25dk telefonda bekliyor, bağlantı gelince skoruna eklenecek.');
    expect(text).not.toContain('skoruna eklendi');
  });

  it('says what the server kept when it does answer', async () => {
    api.addEntry = jest.fn(async (_id: string, body: { value: number }) => ({
      entry: { id: 'f-1', value: body.value, source: 'focus', status: 'ok' },
      standings: [],
    }));
    const tree = await openFocus();
    await sitThrough(tree);

    expect(await readQueue()).toHaveLength(0);
    const text = rendered(tree);
    expect(text).toContain('25dk skoruna eklendi.');
    expect(text).not.toContain('telefonda bekliyor');
  });

  it('parks the whole minutes of a burnt session once, without a second "kaydet"', async () => {
    api.addEntry = jest.fn(async () => {
      throw NETWORK_ERROR;
    });
    const tree = await openFocus();
    press(tree, 'Başlat');
    jest.setSystemTime(Date.now() + 3 * 60_000 + 5_000);
    press(tree, 'Vazgeç');
    press(tree, 'Evet, vazgeçtim');
    expect(rendered(tree)).toContain('Seans yandı');

    press(tree, '3dk kaydet');
    await settle();

    expect(await readQueue()).toHaveLength(1);
    const text = rendered(tree);
    expect(text).toContain('3dk telefonda bekliyor, bağlantı gelince skoruna eklenecek.');
    expect(text).not.toContain('yine de skoruna yazıldı');
    expect(text).not.toContain('Kaydedelim mi?');
    expect(
      tree.root.findAll((node) => node.props.title === '3dk kaydet' && typeof node.props.onPress === 'function')
    ).toHaveLength(0);
  });
});

describe('effort that would not count', () => {
  /** A focus çelınc that ends `msLeft` from now. */
  function focusEndingIn(msLeft: number) {
    return focusEndingAt(new Date(Date.now() + msLeft));
  }

  function focusEndingAt(endsAt: Date) {
    const detail = challengeDetail();
    return {
      ...detail,
      challenge: {
        ...detail.challenge,
        typeKey: 'odak_seansi',
        metricType: 'focus_minutes' as const,
        unit: 'dk',
        endsAt: endsAt.toISOString(),
      },
    };
  }

  function pickPreset(tree: ReactTestRenderer, minutes: number): void {
    const [control] = tree.root.findAll(
      (node) => Array.isArray(node.props.options) && typeof node.props.onChange === 'function'
    );
    if (!control) throw new Error('süre seçici bulunamadı');
    act(() => {
      control.props.onChange(minutes);
    });
  }

  afterEach(async () => {
    const { saveSession } = require('@/services/focus') as typeof import('@/services/focus');
    await act(async () => {
      await saveSession(null);
    });
  });

  it('fits a focus session into the time the çelınc has left', async () => {
    searchParams.id = 'c-1';
    // 20 minutes once the half-minute margin for the upload is taken off
    api.challenge = jest.fn(async () => focusEndingIn(20 * 60_000 + 45_000));
    const FocusScreen = require('@/app/(app)/focus/[id]').default;
    const tree = renderScreen(<FocusScreen />);
    await settle();

    expect(rendered(tree)).toMatch(/en fazla\s+20dk\s+sayılır/);
    pickPreset(tree, 45);
    press(tree, 'Başlat');
    // 45 minutes at 23:30 on the last night used to be refused whole at midnight
    expect(rendered(tree)).toMatch(/Hedef\s+20dk/);
    expect(rendered(tree)).toContain('20:00');
  });

  it('does not start a focus session the çelınc cannot take any more', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => focusEndingIn(50_000));
    const FocusScreen = require('@/app/(app)/focus/[id]').default;
    const tree = renderScreen(<FocusScreen />);
    await settle();

    expect(rendered(tree)).toContain('Çelıncın bitmesine bir dakika bile yok, seans skora yazılmaz.');
    expect(findWith(tree, 'title', 'Başlat', 'onPress').props.disabled).toBe(true);
  });

  /** Today's finished sessions, in the zone the screen falls back to (ME.timezone is unusable). */
  function focusedToday(...minutes: number[]): Entry[] {
    const day = todayKey('Europe/Istanbul');
    return minutes.map((value, i) => ({
      id: `f-${i}`,
      challengeId: 'c-1',
      userId: 'me-1',
      dayKey: day,
      value,
      source: 'focus' as const,
      note: null,
      proofUrl: null,
      status: 'ok' as const,
      createdAt: new Date().toISOString(),
    }));
  }

  it("fits a focus session into what the day's 360 minutes have left", async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => ({ ...focusEndingIn(3 * 24 * 60 * 60_000), myEntries: focusedToday(180, 150) }));
    const FocusScreen = require('@/app/(app)/focus/[id]').default;
    const tree = renderScreen(<FocusScreen />);
    await settle();

    // the default 25 still fits
    expect(rendered(tree)).toContain('Bugün 30 dk hakkın kaldı.');
    pickPreset(tree, 45);
    expect(rendered(tree)).toContain('Bugün 30 dk hakkın kaldı, seans 30 dk sürer.');
    press(tree, 'Başlat');
    // the server would have cut a full 45 to 30 after the friend sat through it
    expect(rendered(tree)).toMatch(/Hedef\s+30dk/);
  });

  it('does not start a focus session once the day has its 360 minutes', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => ({ ...focusEndingIn(3 * 24 * 60 * 60_000), myEntries: focusedToday(180, 180) }));
    const FocusScreen = require('@/app/(app)/focus/[id]').default;
    const tree = renderScreen(<FocusScreen />);
    await settle();

    expect(rendered(tree)).toContain('Bugünlük 360 dk doldu. Yarın devam.');
    expect(rendered(tree)).not.toContain('hakkın kaldı');
    expect(findWith(tree, 'title', 'Başlat', 'onPress').props.disabled).toBe(true);
  });

  it('promises no tomorrow at the cap on the last day', async () => {
    const { endOfDayInTz } = require('@/utils/datetime') as typeof import('@/utils/datetime');
    const lastNight = endOfDayInTz(todayKey('Europe/Istanbul'), 'Europe/Istanbul');
    if (!lastNight) throw new Error('günün sonu hesaplanamadı');
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => ({
      // the exact end of today: going through Date.now() twice let a passing millisecond push it into tomorrow
      ...focusEndingAt(lastNight),
      myEntries: focusedToday(180, 180),
    }));
    const FocusScreen = require('@/app/(app)/focus/[id]').default;
    const tree = renderScreen(<FocusScreen />);
    await settle();

    expect(rendered(tree)).toContain('Bugünlük 360 dk doldu.');
    expect(rendered(tree)).not.toContain('Yarın devam');
  });

  it("leaves the session's length to the end card when the çelınc ends before the day's cap", async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => ({ ...focusEndingIn(20 * 60_000), myEntries: focusedToday(180, 150) }));
    const FocusScreen = require('@/app/(app)/focus/[id]').default;
    const tree = renderScreen(<FocusScreen />);
    await settle();
    pickPreset(tree, 45);

    // 30 left of the 360, but the çelınc has 19 minutes: the session runs 19
    expect(rendered(tree)).toContain('Bugün 30 dk hakkın kaldı.');
    expect(rendered(tree)).not.toContain('seans 30 dk sürer');
    expect(rendered(tree)).toMatch(/seans en fazla\s+19\s*dk\s+sayılır/);
  });

  it("says the check-in deadline has to fall in the type's window", async () => {
    const NewChallengeScreen = require('@/app/(app)/challenge/new').default;
    const tree = renderScreen(<NewChallengeScreen />);
    await settle();
    const [row] = tree.root.findAll(
      (node) => typeof node.props.onSelect === 'function' && node.props.type?.key === 'erken_yat'
    );
    if (!row) throw new Error('erken_yat bulunamadı');
    act(() => {
      row.props.onSelect(row.props.type);
    });
    press(tree, 'İleri');
    expect(rendered(tree)).toContain('Gece yarısını geçen saat olmaz, en geç 23:59.');

    // "gece yarısından önce yat": every check-in would be too early or late
    typeInto(tree, 'Check-in saati', '00:00');
    expect(rendered(tree)).toContain('Check-in saati 19:00 sonrası, en geç 23:59 olmalı.');
    expect(findWith(tree, 'title', 'İleri', 'onPress').props.disabled).toBe(true);

    typeInto(tree, 'Check-in saati', '23:30');
    expect(rendered(tree)).not.toContain('sonrası, en geç 23:59 olmalı');
    expect(findWith(tree, 'title', 'İleri', 'onPress').props.disabled).toBe(false);
  });
});

describe('the first morning of a check-in çelınc', () => {
  const ALI = { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };
  const PAST_DEADLINE = 'Bugünün check-in saati geçti, ilk check-in yarın.';

  /** The wizard at `at` (a wall-clock instant), on its settings step for `key`. */
  async function settingsFor(key: string, at: string): Promise<ReactTestRenderer> {
    // only the clock is faked: the query and settle() still need real timers
    jest.useFakeTimers({
      now: new Date(at),
      doNotFake: [
        'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
        'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval',
        'clearInterval', 'setTimeout', 'clearTimeout',
      ],
    });
    const NewChallengeScreen = require('@/app/(app)/challenge/new').default;
    const tree = renderScreen(<NewChallengeScreen />);
    await settle();
    const [row] = tree.root.findAll(
      (node) => typeof node.props.onSelect === 'function' && node.props.type?.key === key
    );
    if (!row) throw new Error(`${key} bulunamadı`);
    act(() => {
      row.props.onSelect(row.props.type);
    });
    press(tree, 'İleri');
    return tree;
  }

  function startAt(tree: ReactTestRenderer, mode: 'now' | 'tomorrow'): void {
    const [control] = tree.root.findAll(
      (node) =>
        typeof node.props.onChange === 'function' &&
        Array.isArray(node.props.options) &&
        node.props.options.some((option: { value: string }) => option.value === 'tomorrow')
    );
    if (!control) throw new Error('başlangıç seçimi bulunamadı');
    act(() => {
      control.props.onChange(mode);
    });
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts an Erken Kalkan Koyar "Yarın" at 04:00, and a "Hemen" after 07:00 there too', async () => {
    api.friends = jest.fn(async () => ({ friends: [ALI], incoming: [], outgoing: [] }));
    api.createChallenge = jest.fn(async () => ({ id: 'c-new' }));
    // 08:00 on 9 September in Istanbul: this morning's 07:00 is gone
    const tree = await settingsFor('erken_kus', '2026-09-09T05:00:00.000Z');

    expect(rendered(tree)).toContain('Yarın 04:00');
    expect(rendered(tree)).not.toContain('Yarın 09:00');
    expect(rendered(tree)).toContain(PAST_DEADLINE);
    expect(rendered(tree)).toContain('10 Eylül Perşembe · 04:00');
    // five mornings: 10-14 September
    expect(rendered(tree)).toContain('14 Eylül Pazartesi · 23:59');

    // "Yarın" starts there anyway: nothing to warn about
    startAt(tree, 'tomorrow');
    expect(rendered(tree)).not.toContain(PAST_DEADLINE);
    expect(rendered(tree)).toContain('10 Eylül Perşembe · 04:00');

    // with 10:30 typed, this morning can still be played
    startAt(tree, 'now');
    typeInto(tree, 'Check-in saati', '10:30');
    expect(rendered(tree)).not.toContain(PAST_DEADLINE);
    expect(rendered(tree)).toContain('9 Eylül Çarşamba · 08:00');

    typeInto(tree, 'Check-in saati', '07:00');
    press(tree, 'İleri');
    const [ali] = tree.root.findAll(
      (node) => typeof node.props.onToggle === 'function' && node.props.user?.id === ALI.id
    );
    if (!ali) throw new Error('Ali bulunamadı');
    act(() => {
      ali.props.onToggle(ALI.id);
    });
    press(tree, 'İleri');
    await act(async () => {
      findWith(tree, 'title', 'KOY BAKALIM', 'onPress').props.onPress();
    });
    const [body] = api.createChallenge.mock.calls[0] as [{ startsAt: string; endsAt: string }];
    expect(body.startsAt).toBe('2026-09-10T01:00:00.000Z');
    expect(body.endsAt).toBe('2026-09-14T20:59:59.999Z');
  });

  it('starts a "Hemen" at once while the morning can still be played', async () => {
    // 06:00 in Istanbul
    const tree = await settingsFor('erken_kus', '2026-09-09T03:00:00.000Z');
    expect(rendered(tree)).not.toContain(PAST_DEADLINE);
    expect(rendered(tree)).toContain('9 Eylül Çarşamba · 06:00');
  });

  it('says "Yarın 05:00" for Yatak Toplama Sabahı and keeps 09:00 for the rest', async () => {
    const yatak = await settingsFor('yatak_toplama', '2026-09-09T17:00:00.000Z');
    expect(rendered(yatak)).toContain('Yarın 05:00');

    // 20:00: tonight's 23:00 is still ahead
    const yat = await settingsFor('erken_yat', '2026-09-09T17:00:00.000Z');
    expect(rendered(yat)).toContain('Yarın 09:00');
    expect(rendered(yat)).not.toContain(PAST_DEADLINE);

    const steps = await settingsFor('adim_yarisi', '2026-09-09T17:00:00.000Z');
    expect(rendered(steps)).toContain('Yarın 09:00');
    expect(rendered(steps)).not.toContain(PAST_DEADLINE);
    expect(rendered(steps)).toContain('9 Eylül Çarşamba · 20:00');
  });
});

describe('saying no to a çelınc', () => {
  const ALI = { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };
  const CEM = { id: 'u-3', username: 'cem', displayName: 'Cem', avatarEmoji: '🦁', createdAt: '2026-09-01T00:00:00.000Z' };

  /** Ali's çelınc, the reader in it as `mine`; `crowd` adds Cem, still thinking about it. */
  function aliInvites(mine: 'invited' | 'declined' | 'accepted', crowd = false) {
    const detail = challengeDetail();
    const ali = { ...detail.me!, user: ALI };
    const me = { ...detail.me!, status: mine, score: 0, days: 0, rank: 0, lastEntryAt: null };
    const cem = { ...me, user: CEM, status: 'invited' as const };
    const participants = crowd ? [ali, me, cem] : [ali, me];
    return { ...detail, challenge: { ...detail.challenge, creatorId: ALI.id }, participants, me };
  }

  let alert: jest.SpyInstance;

  beforeEach(() => {
    const { Alert } = require('react-native') as typeof import('react-native');
    alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    alert.mockRestore();
  });

  /** Taps a button of the confirmation the screen raised last. */
  async function answerAlert(text: string): Promise<void> {
    const buttons = alert.mock.calls[alert.mock.calls.length - 1]?.[2] as { text?: string; onPress?: () => void }[];
    await act(async () => {
      buttons.find((button) => button.text === text)?.onPress?.();
    });
    await settle();
  }

  it('asks before a "Reddet" on the home card, and says a head-to-head would be over', async () => {
    const { challenge, participants, me } = aliInvites('invited');
    api.challenges = jest.fn(async () => [{ challenge, participants, me, unreadTaunts: 0 }]);
    api.declineChallenge = jest.fn(async () => ({}));
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const tree = renderScreen(<HomeScreen />);
    await settle();

    press(tree, 'Reddet');
    await settle();
    expect(alert).toHaveBeenCalledTimes(1);
    const [title, body] = alert.mock.calls[0]!;
    expect(title).toBe('Pas mı geçiyorsun?');
    expect(body).toContain('çelınc yatar');
    // the no goes to whoever called, who is not always the creator any more
    expect(body).toContain('Seni çağırana da haber gider.');
    expect(api.declineChallenge).not.toHaveBeenCalled();

    await answerAlert('Vazgeç');
    expect(api.declineChallenge).not.toHaveBeenCalled();

    press(tree, 'Reddet');
    await settle();
    await answerAlert('Reddet');
    expect(api.declineChallenge).toHaveBeenCalledWith('c-1');
  });

  // the server reads an answered invite in Gelen; the badge only drops it once
  // asked again, and an invite is mostly answered away from Gelen
  it('reads the inbox and its badge again once an invite is answered, yes or no', async () => {
    const { qk } = require('@/lib/query') as typeof import('@/lib/query');
    const keysOf = (spy: jest.SpyInstance) => spy.mock.calls.map(([filters]) => filters?.queryKey);

    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => aliInvites('invited', true));
    api.acceptChallenge = jest.fn(async () => ({}));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const screen = renderScreen(<ChallengeScreen />);
    await settle();
    const fromScreen = jest.spyOn(clientOf(screen), 'invalidateQueries');
    press(screen, 'Varım');
    await settle();
    expect(api.acceptChallenge).toHaveBeenCalledWith('c-1');
    expect(keysOf(fromScreen)).toEqual(expect.arrayContaining([qk.inbox, qk.unread]));

    const { challenge, participants, me } = aliInvites('invited');
    api.challenges = jest.fn(async () => [{ challenge, participants, me, unreadTaunts: 0 }]);
    api.declineChallenge = jest.fn(async () => ({}));
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const home = renderScreen(<HomeScreen />);
    await settle();
    const fromHome = jest.spyOn(clientOf(home), 'invalidateQueries');
    press(home, 'Reddet');
    await settle();
    await answerAlert('Reddet');
    expect(api.declineChallenge).toHaveBeenCalledWith('c-1');
    expect(keysOf(fromHome)).toEqual(expect.arrayContaining([qk.inbox, qk.unread]));
  });

  it('asks before a "Yokum" too, and says the way back while others may still join', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => aliInvites('invited', true));
    api.declineChallenge = jest.fn(async () => ({}));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    press(tree, 'Yokum');
    await settle();
    expect(alert.mock.calls[0]![1]).toContain("Gelen'deki davetten");
    expect(alert.mock.calls[0]![1]).toContain('seni çağırana da haber gider');
    expect(api.declineChallenge).not.toHaveBeenCalled();
    await answerAlert('Reddet');
    expect(api.declineChallenge).toHaveBeenCalledWith('c-1');
  });

  // "Ayrıl" under "Varım" / "Yokum" warned an invitee about a score they never
  // had, and the server stored it as a walk-out with no way back
  it('gives an invitee "Varım" and "Yokum" but no "Ayrıl", which stays a player\'s', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => aliInvites('invited', true));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const invited = renderScreen(<ChallengeScreen />);
    await settle();

    const text = rendered(invited);
    expect(text).toContain('VARIM');
    expect(text).toContain('YOKUM');
    expect(text).not.toContain('AYRIL');

    api.challenge = jest.fn(async () => aliInvites('accepted', true));
    const playing = renderScreen(<ChallengeScreen />);
    await settle();
    expect(rendered(playing)).toContain('AYRIL');
    expect(rendered(playing)).not.toContain('YOKUM');
  });

  // Before the start there is no score and no ranking, and the kankas are told
  // "vazgeçti"; the dialog spoke of a kept score, and not of the one thing that
  // counts: the server never lets a leaver back in, while a "Reddet" may be undone.
  it('tells a player leaving before the start that there is no way back, not about a score', async () => {
    searchParams.id = 'c-1';
    const notYet = (mine: 'invited' | 'accepted') => {
      const detail = aliInvites(mine, true);
      const startsAt = new Date(Date.now() + 86_400_000).toISOString();
      return { ...detail, challenge: { ...detail.challenge, status: 'pending' as const, startsAt } };
    };
    api.challenge = jest.fn(async () => notYet('accepted'));
    api.leaveChallenge = jest.fn(async () => ({}));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    press(tree, 'Ayrıl');
    await settle();
    const [title, body] = alert.mock.calls[0]!;
    expect(title).toBe('Ayrılıyor musun?');
    expect(body).toBe('Çelınc daha başlamadı. Ayrılırsan kankalara haber gider ve bu çelınca geri dönemezsin.');
    await answerAlert('Ayrıl');
    expect(api.leaveChallenge).toHaveBeenCalledWith('c-1');
    expect(rendered(tree)).toContain('Çelınc sensiz başlayacak.');
    expect(rendered(tree)).not.toContain('sensiz devam ediyor');

    // an invitee's no to a çelınc that has not started either
    alert.mockClear();
    api.challenge = jest.fn(async () => notYet('invited'));
    api.declineChallenge = jest.fn(async () => ({}));
    const invited = renderScreen(<ChallengeScreen />);
    await settle();
    press(invited, 'Yokum');
    await settle();
    await answerAlert('Reddet');
    expect(api.declineChallenge).toHaveBeenCalledWith('c-1');
    expect(rendered(invited)).toContain('Çelınc sensiz başlayacak.');
    expect(rendered(invited)).not.toContain('sensiz devam ediyor');
  });

  it('lets a declined invite back in with "Katıl"', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => aliInvites('declined', true));
    api.acceptChallenge = jest.fn(async () => ({}));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    expect(rendered(tree)).toContain('Reddetmiştin. Fikrin değiştiyse hâlâ girebilirsin.');
    press(tree, 'Katıl');
    await settle();
    expect(api.acceptChallenge).toHaveBeenCalledWith('c-1');
    expect(alert).not.toHaveBeenCalled();
  });

  it('offers no way back once the çelınc is over', async () => {
    searchParams.id = 'c-1';
    const detail = aliInvites('declined', true);
    api.challenge = jest.fn(async () => ({ ...detail, challenge: { ...detail.challenge, status: 'cancelled' as const } }));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    expect(rendered(tree)).not.toContain('Reddetmiştin');
  });
});

describe('taking a social mistake back', () => {
  const MEHMET = { id: 'u-4', username: 'mehmet', displayName: 'Mehmet', avatarEmoji: '🐻', createdAt: '2026-09-01T00:00:00.000Z' };

  let alert: jest.SpyInstance;

  beforeEach(() => {
    const { Alert } = require('react-native') as typeof import('react-native');
    alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    alert.mockRestore();
  });

  /** Taps a button of the confirmation the screen raised last. */
  async function answerAlert(text: string): Promise<void> {
    const buttons = alert.mock.calls[alert.mock.calls.length - 1]?.[2] as { text?: string; onPress?: () => void }[];
    await act(async () => {
      buttons.find((button) => button.text === text)?.onPress?.();
    });
    await settle();
  }

  it('settings says so when nobody is blocked', async () => {
    const SettingsScreen = require('@/app/(app)/settings').default;
    const tree = renderScreen(<SettingsScreen />);
    await settle();

    expect(api.blockedUsers).toHaveBeenCalled();
    expect(rendered(tree)).toContain('Kimseyi engellemedin.');
  });

  it('settings lists my blocks, and "Engeli kaldır" lifts one only after asking', async () => {
    api.blockedUsers = jest.fn(async () => [MEHMET]);
    api.unblockUser = jest.fn(async () => ({ status: 'none', userId: MEHMET.id, removed: true }));
    const SettingsScreen = require('@/app/(app)/settings').default;
    const tree = renderScreen(<SettingsScreen />);
    await settle();

    expect(rendered(tree)).toContain('Mehmet');
    expect(rendered(tree)).not.toContain('Kimseyi engellemedin.');

    press(tree, 'Engeli kaldır');
    await settle();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0]![1]).toContain('Mehmet seni yeniden bulabilir.');
    await answerAlert('Vazgeç');
    expect(api.unblockUser).not.toHaveBeenCalled();

    api.blockedUsers = jest.fn(async () => []);
    press(tree, 'Engeli kaldır');
    await settle();
    await answerAlert('Kaldır');
    expect(api.unblockUser).toHaveBeenCalledWith('u-4');
    // the list is fetched again and the row is gone
    expect(api.blockedUsers).toHaveBeenCalled();
    expect(rendered(tree)).toContain('Kimseyi engellemedin.');
  });

  it('a sent request has "Geri çek" instead of a BEKLİYOR chip, and it asks first', async () => {
    api.friends = jest.fn(async () => ({ friends: [], incoming: [], outgoing: [{ id: 'f-9', user: MEHMET }] }));
    api.withdrawFriendRequest = jest.fn(async () => ({ status: 'withdrawn', userId: MEHMET.id }));
    api.removeFriend = jest.fn(async () => ({ status: 'removed', userId: MEHMET.id }));
    const FriendsScreen = require('@/app/(app)/(tabs)/friends').default;
    const tree = renderScreen(<FriendsScreen />);
    await settle();

    expect(rendered(tree)).not.toContain('BEKLİYOR');
    press(tree, 'Geri çek');
    await settle();
    expect(alert.mock.calls[0]![0]).toBe('İsteği geri çek');
    expect(alert.mock.calls[0]![1]).toBe('Mehmet isteğini artık görmeyecek.');
    await answerAlert('Vazgeç');
    expect(api.withdrawFriendRequest).not.toHaveBeenCalled();

    press(tree, 'Geri çek');
    await settle();
    await answerAlert('Geri çek');
    expect(api.withdrawFriendRequest).toHaveBeenCalledWith('u-4');
    // never the plain DELETE, which would end a friendship accepted meanwhile
    expect(api.removeFriend).not.toHaveBeenCalled();
  });

  it('a "Geri çek" that lands after the request was accepted keeps the friendship', async () => {
    api.friends = jest.fn(async () => ({ friends: [], incoming: [], outgoing: [{ id: 'f-9', user: MEHMET }] }));
    api.withdrawFriendRequest = jest.fn(async () => {
      throw new ApiError('already_friends', 'İsteğini kabul etmiş, artık kankasınız.', 409);
    });
    const FriendsScreen = require('@/app/(app)/(tabs)/friends').default;
    const tree = renderScreen(<FriendsScreen />);
    await settle();

    // Mehmet says yes while the confirm is open
    api.friends = jest.fn(async () => ({ friends: [MEHMET], incoming: [], outgoing: [] }));
    press(tree, 'Geri çek');
    await settle();
    await answerAlert('Geri çek');

    expect(rendered(tree)).toContain('İsteğini kabul etmiş, artık kankasınız.');
    // the stale row goes: the list is read again and Mehmet is a kanka now
    expect(api.friends).toHaveBeenCalled();
    expect(rendered(tree)).not.toContain('Geri çek');
  });

  it('says the davet link is new after a block, and reads the new code for Paylaş', async () => {
    searchParams.id = MEHMET.id;
    api.userProfile = jest.fn(async () => ({
      ...MEHMET,
      stats: { wins: 0, losses: 0, challengesPlayed: 0 },
      badges: [],
    }));
    api.friends = jest.fn(async () => ({ friends: [MEHMET], incoming: [], outgoing: [] }));
    api.blockUser = jest.fn(async () => ({ status: 'blocked', userId: MEHMET.id }));
    mockRefreshMe.mockClear();
    mockRefreshMe.mockResolvedValueOnce({ ...ME, inviteCode: 'YENI99' });
    const UserScreen = require('@/app/(app)/user/[id]').default;
    const tree = renderScreen(<UserScreen />);
    await settle();

    press(tree, 'Diğer seçenekler');
    const [blockRow] = tree.root.findAll(
      (node) =>
        node.props.accessibilityRole === 'button' &&
        typeof node.props.onPress === 'function' &&
        node.findAll((inner) => inner.props.children === '⛔ Engelle').length > 0
    );
    act(() => {
      blockRow!.props.onPress();
    });
    await settle();
    await answerAlert('Engelle');

    expect(api.blockUser).toHaveBeenCalledWith('u-4');
    expect(mockRefreshMe).toHaveBeenCalledTimes(1);
    expect(rendered(tree)).toContain('Davet bağlantın da yenilendi, eskisiyle kimse gelemez.');
  });

  // Sıralama is me and my friends; the Ben tab stays mounted and only read it
  // again on a focus 20 s later, so a kanka I had just dropped stayed on it
  it('takes a removed or blocked kanka off Sıralama too, not only off the list', async () => {
    searchParams.id = MEHMET.id;
    api.userProfile = jest.fn(async () => ({
      ...MEHMET,
      stats: { wins: 0, losses: 0, challengesPlayed: 0 },
      badges: [],
    }));
    api.friends = jest.fn(async () => ({ friends: [MEHMET], incoming: [], outgoing: [] }));
    api.removeFriend = jest.fn(async () => ({ status: 'removed', userId: MEHMET.id }));
    api.blockUser = jest.fn(async () => ({ status: 'blocked', userId: MEHMET.id }));
    const { qk } = require('@/lib/query') as typeof import('@/lib/query');
    const UserScreen = require('@/app/(app)/user/[id]').default;

    for (const [label, confirm] of [
      ['👋 Arkadaşlıktan çıkar', 'Çıkar'],
      ['⛔ Engelle', 'Engelle'],
    ] as const) {
      const tree = renderScreen(<UserScreen />);
      await settle();
      const invalidated = jest.spyOn(clientOf(tree), 'invalidateQueries');
      press(tree, 'Diğer seçenekler');
      const [row] = tree.root.findAll(
        (node) =>
          node.props.accessibilityRole === 'button' &&
          typeof node.props.onPress === 'function' &&
          node.findAll((inner) => inner.props.children === label).length > 0
      );
      act(() => {
        row!.props.onPress();
      });
      await settle();
      await answerAlert(confirm);
      expect([label, invalidated.mock.calls.map(([filters]) => filters?.queryKey)]).toEqual([label, expect.arrayContaining([qk.leaderboard])]);
    }
    expect(api.removeFriend).toHaveBeenCalledWith('u-4');
    expect(api.blockUser).toHaveBeenCalledWith('u-4');
  });

  it('the profile of someone I asked offers "İsteği geri çek" instead of a dead button', async () => {
    searchParams.id = MEHMET.id;
    api.userProfile = jest.fn(async () => ({
      ...MEHMET,
      stats: { wins: 0, losses: 0, challengesPlayed: 0 },
      badges: [],
    }));
    api.friends = jest.fn(async () => ({ friends: [], incoming: [], outgoing: [{ id: 'f-9', user: MEHMET }] }));
    api.withdrawFriendRequest = jest.fn(async () => ({ status: 'withdrawn', userId: MEHMET.id }));
    const UserScreen = require('@/app/(app)/user/[id]').default;
    const tree = renderScreen(<UserScreen />);
    await settle();

    expect(rendered(tree)).not.toContain('İstek gönderildi');
    press(tree, 'İsteği geri çek');
    await settle();
    await answerAlert('Geri çek');
    expect(api.withdrawFriendRequest).toHaveBeenCalledWith('u-4');
  });
});

describe('the whole çelınc history', () => {
  const ALI = { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };
  const VELI = { id: 'u-3', username: 'veli', displayName: 'Veli', avatarEmoji: '🦁', createdAt: '2026-09-01T00:00:00.000Z' };

  /** Çelınc `n` against one rival, closed `n` days before the 20th: 1 is the newest. */
  function past(n: number, rival: typeof ALI, outcome: 'won' | 'lost' | 'tie' | 'cancelled') {
    const { challenge, participants } = challengeDetail();
    const me = { ...participants[0]!, rank: outcome === 'lost' ? 2 : 1, isWinner: outcome === 'won' };
    const them = { ...me, user: rival, rank: outcome === 'won' ? 2 : 1, isWinner: outcome === 'lost' };
    return {
      challenge: {
        ...challenge,
        id: `c-${n}`,
        title: `Çelınc ${n}`,
        status: outcome === 'cancelled' ? ('cancelled' as const) : ('finished' as const),
        endsAt: new Date(Date.UTC(2026, 8, 20 - n)).toISOString(),
        finalizedAt: new Date(Date.UTC(2026, 8, 20 - n)).toISOString(),
        winnerId: outcome === 'won' ? ME.id : outcome === 'lost' ? rival.id : null,
        isTie: outcome === 'tie',
      },
      participants: [me, them] as ParticipantView[],
      me,
      unreadTaunts: 0,
    };
  }

  // Ali: 1 won, 3 won, 4 tie, 6 lost. Veli: 2 lost, 5 won, 7 cancelled.
  function seven() {
    const list = [
      past(1, ALI, 'won'),
      past(2, VELI, 'lost'),
      past(3, ALI, 'won'),
      past(4, ALI, 'tie'),
      past(5, VELI, 'won'),
      past(6, ALI, 'lost'),
      past(7, VELI, 'cancelled'),
    ];
    // Ali said no to Veli's çelınc: rank 0 in the list, and never a round between us
    const declined = { ...list[4]!.participants[1]!, user: ALI, status: 'declined' as const, rank: 0, isWinner: false };
    list[4]!.participants.push(declined);
    return list;
  }

  function serve(list: ReturnType<typeof seven>) {
    api.challenges = jest.fn(async (status?: string) =>
      status ? list.filter((summary) => status.split(',').includes(summary.challenge.status)) : list
    );
  }

  function titles(tree: ReactTestRenderer): number[] {
    const text = rendered(tree);
    return [1, 2, 3, 4, 5, 6, 7].filter((n) => text.includes(`Çelınc ${n}`));
  }

  function tapChip(tree: ReactTestRenderer, label: string): void {
    act(() => {
      findWith(tree, 'label', label, 'onPress').props.onPress();
    });
  }

  it('home keeps the newest five and offers the rest behind "Hepsini gör (7)"', async () => {
    serve(seven());
    const { router } = require('expo-router') as { router: Record<string, jest.Mock> };
    router.push!.mockClear();
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const tree = renderScreen(<HomeScreen />);
    await settle();

    expect(titles(tree)).toEqual([1, 2, 3, 4, 5]);
    expect(rendered(tree)).toContain('HEPSİNİ GÖR (7)');
    press(tree, 'Hepsini gör (7)');
    expect(router.push).toHaveBeenCalledWith('/history');
  });

  it('home says nothing about the rest when five is all there is', async () => {
    serve(seven().slice(0, 5));
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const tree = renderScreen(<HomeScreen />);
    await settle();

    expect(titles(tree)).toEqual([1, 2, 3, 4, 5]);
    expect(rendered(tree)).not.toContain('HEPSİNİ GÖR');
  });

  it('history lists all seven, and the chips split the wins from the losses', async () => {
    serve(seven());
    const { router } = require('expo-router') as { router: Record<string, jest.Mock> };
    router.push!.mockClear();
    const HistoryScreen = require('@/app/(app)/history').default;
    const tree = renderScreen(<HistoryScreen />);
    await settle();

    expect(titles(tree)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    tapChip(tree, 'Koyduklarım (3)');
    expect(titles(tree)).toEqual([1, 3, 5]);
    tapChip(tree, 'Yediklerim (2)');
    expect(titles(tree)).toEqual([2, 6]);
    tapChip(tree, 'Berabere (1)');
    expect(titles(tree)).toEqual([4]);
    tapChip(tree, 'İptal (1)');
    expect(titles(tree)).toEqual([7]);

    // a cancelled one has no result to show; a finished one opens straight on it
    const { ChallengeCard } = require('@/components/ChallengeCard') as typeof import('@/components/ChallengeCard');
    act(() => tree.root.findByType(ChallengeCard).props.onPress());
    expect(router.push).toHaveBeenLastCalledWith({ pathname: '/challenge/[id]', params: { id: 'c-7' } });
    tapChip(tree, 'Hepsi (7)');
    act(() => tree.root.findAllByType(ChallengeCard)[0]!.props.onPress());
    expect(router.push).toHaveBeenLastCalledWith({ pathname: '/challenge/[id]/results', params: { id: 'c-1' } });
  });

  it('a "Nazik" reader files them as Kazandıklarım and Kaybettiklerim, and the cards say it the same way', async () => {
    mockLevel.value = 1;
    serve(seven());
    const HistoryScreen = require('@/app/(app)/history').default;
    const tree = renderScreen(<HistoryScreen />);
    await settle();

    tapChip(tree, 'Kazandıklarım (3)');
    expect(titles(tree)).toEqual([1, 3, 5]);
    expect(rendered(tree)).toContain('KAZANDIN');
    tapChip(tree, 'Kaybettiklerim (2)');
    expect(titles(tree)).toEqual([2, 6]);
    expect(rendered(tree)).toContain('KAYBETTİN');
    expect(rendered(tree)).not.toMatch(/Koyduklarım|Yediklerim|KOYDUN|YEDİN/);
  });

  it('the rövanş badge opens it on the losses', async () => {
    serve(seven());
    searchParams.show = 'lost';
    const HistoryScreen = require('@/app/(app)/history').default;
    const tree = renderScreen(<HistoryScreen />);
    await settle();

    expect(titles(tree)).toEqual([2, 6]);
  });

  it('says so when nothing has finished yet', async () => {
    serve([]);
    const HistoryScreen = require('@/app/(app)/history').default;
    const tree = renderScreen(<HistoryScreen />);
    await settle();

    expect(rendered(tree)).toContain('Daha bitmiş çelıncın yok');
  });

  it('a rival\'s head-to-head counts the rounds we both played and opens exactly those', async () => {
    serve(seven());
    searchParams.id = ALI.id;
    api.userProfile = jest.fn(async () => ({
      ...ALI,
      stats: { wins: 0, losses: 0, challengesPlayed: 0 },
      badges: [],
    }));
    api.friends = jest.fn(async () => ({ friends: [ALI], incoming: [], outgoing: [] }));
    const { router } = require('expo-router') as { router: Record<string, jest.Mock> };
    router.push!.mockClear();
    const UserScreen = require('@/app/(app)/user/[id]').default;
    const tree = renderScreen(<UserScreen />);
    await settle();

    // 1 and 3 mine, 6 his, 4 a tie; the çelınc he said no to is not a round he won
    expect(rendered(tree)).toContain('2-1 öndesin.');
    const { Card } = require('@/components/Card') as typeof import('@/components/Card');
    const [card] = tree.root.findAllByType(Card).filter((node) => typeof node.props.onPress === 'function');
    act(() => card!.props.onPress());
    expect(router.push).toHaveBeenCalledWith({ pathname: '/history', params: { with: ALI.id } });
  });

  /** Ali's profile while "Adım Savaşı" runs (or waits for its start) with me at `myRank` and him as `ali`. */
  async function profileWhileRunning(
    ali: 'invited' | 'accepted',
    myRank: number,
    status: 'active' | 'pending' = 'active'
  ): Promise<string> {
    const { challenge, participants } = challengeDetail();
    const me = { ...participants[0]!, rank: myRank };
    // the server lists an invitee at rank 0, ahead of anybody's 1
    const him = { ...me, user: ALI, status: ali, rank: ali === 'invited' ? 0 : 1 };
    const running = {
      challenge: { ...challenge, title: 'Adım Savaşı', status },
      participants: [me, him],
      me,
      unreadTaunts: 0,
    };
    api.challenges = jest.fn(async (status?: string) => (status === 'active,pending' ? [running] : []));
    searchParams.id = ALI.id;
    api.userProfile = jest.fn(async () => ({
      ...ALI,
      stats: { wins: 0, losses: 0, challengesPlayed: 0 },
      badges: [],
    }));
    api.friends = jest.fn(async () => ({ friends: [ALI], incoming: [], outgoing: [] }));
    const UserScreen = require('@/app/(app)/user/[id]').default;
    const tree = renderScreen(<UserScreen />);
    await settle();
    return rendered(tree);
  }

  it('a rival who has not said yes to the running çelınc is not ahead of me in it', async () => {
    const text = await profileWhileRunning('invited', 1);

    expect(text).toContain('"Adım Savaşı" sürüyor, Ali daha kabul etmedi.');
    expect(text).not.toContain('geridesin');
    expect(text).not.toContain('ilki sürüyor');
    // the invite is already out: no "open one" on top of it
    expect(text).toContain('Henüz karşı karşıya gelmediniz.');
    expect(text).not.toContain('Bir çelınc aç da görelim');
  });

  it('a rival who did say yes is still ranked against me', async () => {
    const text = await profileWhileRunning('accepted', 2);

    expect(text).toContain('"Adım Savaşı" sürüyor, şu an geridesin.');
    expect(text).toContain('Daha bitmiş bir çelıncınız yok, ilki sürüyor.');
  });

  it('a çelınc we are both in that has not started yet is not "sürüyor" on either line', async () => {
    const text = await profileWhileRunning('accepted', 1, 'pending');

    expect(text).toContain('"Adım Savaşı" başlamak üzere, ikiniz de varsınız.');
    expect(text).toContain('Daha bitmiş bir çelıncınız yok, ilki başlamak üzere.');
    expect(text).not.toContain('sürüyor');
  });

  it('history `with` a rival keeps only the çelınclar the two of us played, until "Herkesle"', async () => {
    serve(seven());
    searchParams.with = ALI.id;
    const HistoryScreen = require('@/app/(app)/history').default;
    const tree = renderScreen(<HistoryScreen />);
    await settle();

    expect(rendered(tree)).toContain('🆚 Ali ile oynadıkların');
    expect(titles(tree)).toEqual([1, 3, 4, 6]);
    tapChip(tree, 'Yediklerim (1)');
    expect(titles(tree)).toEqual([6]);
    tapChip(tree, 'İptal (0)');
    expect(rendered(tree)).toContain('İptal olan çelınc yok.');

    tapChip(tree, 'Herkesle');
    tapChip(tree, 'Hepsi (7)');
    expect(titles(tree)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(rendered(tree)).not.toContain('oynadıkların');
  });
});

describe('a tap on a Gelen row', () => {
  it('opens its çelınc with navigate, so a double tap does not stack it twice', async () => {
    const at = new Date().toISOString();
    api.inbox = jest.fn(async () => [
      { id: 'n-1', type: 'poke', title: '👉 Dürtüldün', body: 'Ali seni dürttü.', data: { challengeId: 'c-1' }, readAt: at, createdAt: at },
    ]);
    const { router } = require('expo-router') as { router: Record<string, jest.Mock> };
    router.push!.mockClear();
    router.navigate!.mockClear();
    const InboxScreen = require('@/app/(app)/(tabs)/inbox').default;
    const tree = renderScreen(<InboxScreen />);
    await settle();

    const [row] = tree.root.findAll(
      (node) => (node.props.item as { id?: string } | undefined)?.id === 'n-1' && typeof node.props.onPress === 'function'
    );
    if (!row) throw new Error('n-1 bulunamadı');
    act(() => {
      row.props.onPress(row.props.item);
      row.props.onPress(row.props.item);
    });
    expect(router.navigate).toHaveBeenCalledWith('/challenge/c-1');
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe('an inbox longer than one page', () => {
  const NOW = Date.now();
  /** Row `i` minutes old, unless it is told when; bodies end in "." so 1 is not a prefix of 10. */
  function row(i: number, at = NOW - i * 60_000) {
    return {
      id: `n-${i}`,
      type: 'poke',
      title: '👉 Dürtüldün',
      body: `satır-${i}.`,
      data: {},
      readAt: new Date(NOW).toISOString(),
      createdAt: new Date(at).toISOString(),
    };
  }

  // A full first page whose last row shares its millisecond with the next one:
  // one scheduler pass can write both. `before` = that instant would lose n-30.
  const edge = NOW - 29 * 60_000;
  const firstPage = [...Array.from({ length: 29 }, (_, i) => row(i)), row(29, edge)];
  const secondPage = [row(29, edge), row(30, edge), row(31), row(32), row(33)];

  function list(tree: ReactTestRenderer) {
    const [node] = tree.root.findAll(
      (candidate) => typeof candidate.props.onEndReached === 'function' && Array.isArray(candidate.props.sections)
    );
    if (!node) throw new Error('SectionList bulunamadı');
    return node;
  }

  function ids(tree: ReactTestRenderer): string[] {
    const sections = list(tree).props.sections as { data: { id: string }[] }[];
    return sections.flatMap((section) => section.data.map((item) => item.id));
  }

  async function reachEnd(tree: ReactTestRenderer): Promise<void> {
    act(() => {
      list(tree).props.onEndReached({ distanceFromEnd: 0 });
    });
    await settle();
  }

  it('fetches the older page at the bottom, a millisecond past the last row, and shows both once', async () => {
    api.inbox = jest.fn(async ({ before }: { before?: string } = {}) => (before ? secondPage : firstPage));
    const InboxScreen = require('@/app/(app)/(tabs)/inbox').default;
    const tree = renderScreen(<InboxScreen />);
    await settle();

    expect(api.inbox).toHaveBeenCalledTimes(1);
    expect(ids(tree)).toHaveLength(30);
    expect(rendered(tree)).toContain('DAHA ESKİLERİ GÖSTER');

    await reachEnd(tree);
    expect(api.inbox).toHaveBeenCalledTimes(2);
    expect(api.inbox).toHaveBeenLastCalledWith({ before: new Date(edge + 1).toISOString(), limit: 30 });
    expect(ids(tree)).toEqual(Array.from({ length: 34 }, (_, i) => `n-${i}`));
    // a short page is the last one
    expect(rendered(tree)).not.toContain('DAHA ESKİLERİ GÖSTER');
    expect(rendered(tree)).toContain('Dibe vurdun, daha eskisi yok.');

    await reachEnd(tree);
    expect(api.inbox).toHaveBeenCalledTimes(2);
  });

  it('keeps what it has when the older page fails, and only the button tries again', async () => {
    let fail = true;
    api.inbox = jest.fn(async ({ before }: { before?: string } = {}) => {
      if (!before) return firstPage;
      if (fail) throw NETWORK_ERROR;
      return secondPage;
    });
    const InboxScreen = require('@/app/(app)/(tabs)/inbox').default;
    const tree = renderScreen(<InboxScreen />);
    await settle();

    await reachEnd(tree);
    expect(api.inbox).toHaveBeenCalledTimes(2);
    expect(rendered(tree)).not.toContain('Sunucuya ulaşamadım');
    expect(ids(tree)).toHaveLength(30);
    expect(rendered(tree)).toContain('Eskiler gelmedi. Bir daha dene.');

    // bouncing at the bottom does not hammer a server that just said no
    await reachEnd(tree);
    expect(api.inbox).toHaveBeenCalledTimes(2);

    fail = false;
    press(tree, 'Daha eskileri göster');
    await settle();
    expect(api.inbox).toHaveBeenCalledTimes(3);
    expect(ids(tree)).toHaveLength(34);
  });
});

describe('"Kanka ekle" on a çelınc already under way', () => {
  const ALI = { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };
  const CEM = { id: 'u-3', username: 'cem', displayName: 'Cem', avatarEmoji: '🦁', createdAt: '2026-09-01T00:00:00.000Z' };
  const VELI = { id: 'u-4', username: 'veli', displayName: 'Veli', avatarEmoji: '🐺', createdAt: '2026-09-01T00:00:00.000Z' };
  const DAN = { id: 'u-5', username: 'dan', displayName: 'Dan', avatarEmoji: '🦊', createdAt: '2026-09-01T00:00:00.000Z' };
  // level 2 reads "Kankaları Çağır"; buttons draw it in Turkish capitals
  const CTA = 'Kankaları Çağır';

  /** My running step çelınc with Ali playing, Veli who said no and Dan who walked out. */
  function mine() {
    const detail = challengeDetail();
    const ali = { ...detail.me!, user: ALI, score: 4201, rank: 2 };
    const veli = { ...ali, user: VELI, status: 'declined' as const, score: 0, rank: 0 };
    const dan = { ...veli, user: DAN, status: 'left' as const };
    return { ...detail, participants: [detail.me!, ali, veli, dan] };
  }

  /** The FriendRow for this user, ready to be ticked. */
  function friendRow(tree: ReactTestRenderer, userId: string) {
    const [row] = tree.root.findAll(
      (node) => (node.props.user as { id?: string } | undefined)?.id === userId && typeof node.props.onToggle === 'function'
    );
    return row;
  }

  it('lets the creator call a friend in, offering only who is not already on the list', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => mine());
    api.friends = jest.fn(async () => ({ friends: [ALI, CEM, VELI, DAN], incoming: [], outgoing: [] }));
    api.inviteToChallenge = jest.fn(async () => mine());
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    expect(rendered(tree)).toContain('KANKALARI ÇAĞIR');
    // the list is only asked for once the sheet opens
    expect(api.friends).not.toHaveBeenCalled();
    press(tree, CTA);
    await settle();

    expect(rendered(tree)).toContain('Kimi çağırıyorsun?');
    // Ali plays and Dan walked out; Veli said no, and may be asked again
    expect(friendRow(tree, ALI.id)).toBeUndefined();
    expect(friendRow(tree, DAN.id)).toBeUndefined();
    expect(friendRow(tree, VELI.id)).toBeDefined();

    act(() => {
      friendRow(tree, CEM.id)!.props.onToggle(CEM.id);
    });
    press(tree, 'Çağır (1)');
    await settle();

    expect(api.inviteToChallenge).toHaveBeenCalledWith('c-1', [CEM.id]);
    expect(rendered(tree)).toContain('Davet gitti: Cem. Kabul eden sıralamaya girer.');
    expect(rendered(tree)).not.toContain('Kimi çağırıyorsun?');
  });

  it('is there for every player, not only whoever opened the çelınc', async () => {
    searchParams.id = 'c-1';
    const detail = mine();
    api.challenge = jest.fn(async () => ({ ...detail, challenge: { ...detail.challenge, creatorId: ALI.id } }));
    // the newcomer is often my kanka and not the creator's
    api.friends = jest.fn(async () => ({ friends: [CEM], incoming: [], outgoing: [] }));
    api.inviteToChallenge = jest.fn(async () => mine());
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    expect(rendered(tree)).toContain('KANKALARI ÇAĞIR');
    press(tree, CTA);
    await settle();
    act(() => {
      friendRow(tree, CEM.id)!.props.onToggle(CEM.id);
    });
    press(tree, 'Çağır (1)');
    await settle();
    expect(api.inviteToChallenge).toHaveBeenCalledWith('c-1', [CEM.id]);
  });

  it('sends whoever has nobody left to call to the friends tab, not a second tab bar over the çelınc', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => mine());
    // Ali plays and Dan walked out: nobody to offer
    api.friends = jest.fn(async () => ({ friends: [ALI, DAN], incoming: [], outgoing: [] }));
    const { router } = require('expo-router') as { router: Record<string, jest.Mock> };
    router.push!.mockClear();
    router.navigate!.mockClear();
    router.dismissAll!.mockClear();
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();
    press(tree, CTA);
    await settle();
    expect(rendered(tree)).toContain('Çağıracak kimse kalmadı.');

    // the çelınc sits over the tab bar
    router.canDismiss!.mockReturnValueOnce(true);
    press(tree, 'Kankalara git');
    expect(router.dismissAll).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith('/(app)/(tabs)/friends');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('is not there for somebody who has not said yes yet', async () => {
    searchParams.id = 'c-1';
    const detail = mine();
    const me = { ...detail.me!, status: 'invited' as const, score: 0, rank: 0 };
    api.challenge = jest.fn(async () => ({
      ...detail,
      challenge: { ...detail.challenge, creatorId: ALI.id },
      participants: [me, ...detail.participants.slice(1)],
      me,
    }));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    expect(rendered(tree)).toContain('Haftalık Adım');
    expect(rendered(tree)).not.toContain('KANKALARI ÇAĞIR');
  });

  it('opens with the new kanka ticked when the "Kanka oldunuz" tap brings me here', async () => {
    searchParams.id = 'c-1';
    searchParams.invite = CEM.id;
    api.challenge = jest.fn(async () => mine());
    api.friends = jest.fn(async () => ({ friends: [ALI, CEM, VELI], incoming: [], outgoing: [] }));
    api.inviteToChallenge = jest.fn(async () => mine());
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    expect(rendered(tree)).toContain('Kimi çağırıyorsun?');
    expect(friendRow(tree, CEM.id)?.props.selected).toBe(true);
    expect(friendRow(tree, VELI.id)?.props.selected).toBe(false);
    press(tree, 'Çağır (1)');
    await settle();
    expect(api.inviteToChallenge).toHaveBeenCalledWith('c-1', [CEM.id]);
  });

  it('opens with the new kanka ticked when the tap lands on this çelınc while it is open', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => mine());
    api.friends = jest.fn(async () => ({ friends: [ALI, CEM, VELI], incoming: [], outgoing: [] }));
    api.inviteToChallenge = jest.fn(async () => mine());
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const { useState } = require('react') as typeof import('react');
    // the router hands the open screen its new params in place: a re-render, no remount
    let reparam!: (invite: string) => void;
    function OpenScreen() {
      const [invite, setInvite] = useState<string | undefined>(undefined);
      reparam = (next) => {
        searchParams.invite = next;
        setInvite(next);
      };
      return <ChallengeScreen invite={invite} />;
    }
    const tree = renderScreen(<OpenScreen />);
    await settle();
    expect(rendered(tree)).not.toContain('Kimi çağırıyorsun?');

    act(() => {
      reparam(CEM.id);
    });
    await settle();

    expect(rendered(tree)).toContain('Kimi çağırıyorsun?');
    expect(friendRow(tree, CEM.id)?.props.selected).toBe(true);
    expect(friendRow(tree, VELI.id)?.props.selected).toBe(false);
  });

  it('goes away when the last hour starts, as the server stops taking anybody new', async () => {
    searchParams.id = 'c-1';
    const detail = mine();
    const endsAt = new Date(Date.now() + 30 * 60_000).toISOString();
    api.challenge = jest.fn(async () => ({ ...detail, challenge: { ...detail.challenge, endsAt } }));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    // still running: the countdown is there, the button is not
    expect(rendered(tree)).toContain('BİTMESİNE');
    expect(rendered(tree)).not.toContain('KANKALARI ÇAĞIR');
  });
});

describe('"Kanka oldunuz" while a çelınc of mine still takes players', () => {
  const CEM = { id: 'u-3', username: 'cem', displayName: 'Cem', avatarEmoji: '🦁', createdAt: '2026-09-01T00:00:00.000Z' };

  /** Cem asked; the list the home tab keeps is mounted too, as in the app. */
  async function friendsTab() {
    api.friends = jest.fn(async () => ({ friends: [], incoming: [{ id: 'f-1', user: CEM }], outgoing: [] }));
    api.challenges = jest.fn(async () => [challengeDetail()]);
    const { useChallenges } = require('@/hooks/queries') as typeof import('@/hooks/queries');
    function ChallengeList() {
      useChallenges();
      return null;
    }
    const FriendsScreen = require('@/app/(app)/(tabs)/friends').default;
    const tree = renderScreen(
      <>
        <ChallengeList />
        <FriendsScreen />
      </>
    );
    await settle();
    return tree;
  }

  function tapToast(tree: ReactTestRenderer, body: string): void {
    const [toast] = tree.root.findAll(
      (node) =>
        node.props.accessibilityRole === 'button' &&
        typeof node.props.onPress === 'function' &&
        node.findAll((child) => child.props.children === body).length > 0
    );
    if (!toast) throw new Error(`"${body}" diyen bildirim yok`);
    act(() => {
      toast.props.onPress();
    });
  }

  it('names the çelınc the server offers, and the tap opens its "Kanka ekle" with Cem ticked', async () => {
    const { router } = require('expo-router') as { router: Record<string, jest.Mock> };
    router.push.mockClear();
    api.acceptFriend = jest.fn(async () => ({
      status: 'accepted',
      friendshipId: 'f-1',
      user: CEM,
      invitable: [{ id: 'c-7', title: 'Ofis Ligi', endsAt: new Date(Date.now() + 86_400_000).toISOString() }],
    }));
    const tree = await friendsTab();

    press(tree, 'Kabul');
    await settle();
    expect(api.acceptFriend).toHaveBeenCalledWith('f-1');
    const body = 'Cem artık listende. “Ofis Ligi” çelıncına çağır, grubu bölme.';
    expect(rendered(tree)).toContain(body);
    expect(rendered(tree)).not.toContain('Aç bir çelınc');

    tapToast(tree, body);
    expect(router.push).toHaveBeenCalledWith({ pathname: '/challenge/[id]', params: { id: 'c-7', invite: CEM.id } });
  });

  it('finds the çelınc in my list when an older server names none, and says "Aç bir çelınc" when the server has none', async () => {
    // an older server: no `invitable` at all
    api.acceptFriend = jest.fn(async () => ({ status: 'accepted', friendshipId: 'f-1', user: CEM }));
    const tree = await friendsTab();
    press(tree, 'Kabul');
    await settle();
    expect(rendered(tree)).toContain('Cem artık listende. “Haftalık Adım” çelıncına çağır, grubu bölme.');

    // a new server that found nothing: my list does not overrule it
    api.acceptFriend = jest.fn(async () => ({ status: 'accepted', friendshipId: 'f-1', user: CEM, invitable: [] }));
    const again = await friendsTab();
    press(again, 'Kabul');
    await settle();
    expect(rendered(again)).toContain('Cem artık listende. Aç bir çelınc.');
  });
});

describe('the pull-to-refresh spinner', () => {
  // isRefetching is also true for the 45 s / 60 s polls, push invalidations
  // and every step sync: bound to it, the spinner dropped in by itself and the
  // app looked stuck
  it('spins for a pull, not for a refetch nobody asked for', async () => {
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const tree = renderScreen(<HomeScreen />);
    await settle();
    const spinner = () => tree.root.findByType(RefreshControl).props as { refreshing: boolean; onRefresh: () => void };

    let answer: (rows: unknown[]) => void = () => {};
    api.challenges = jest.fn(() => new Promise<unknown[]>((resolve) => (answer = resolve)));

    act(() => {
      void clientOf(tree).invalidateQueries({ queryKey: ['challenges'] });
    });
    await settle();
    expect(api.challenges).toHaveBeenCalledTimes(1);
    expect(spinner().refreshing).toBe(false);
    await act(async () => answer([]));
    await settle();

    act(() => spinner().onRefresh());
    await settle();
    expect(api.challenges).toHaveBeenCalledTimes(2);
    expect(spinner().refreshing).toBe(true);

    await act(async () => answer([]));
    await settle();
    expect(spinner().refreshing).toBe(false);
  });
});

describe('a pull-to-refresh with an entry parked', () => {
  const { enqueueEntry, readQueue, removeFromQueue } =
    require('@/services/offlineQueue') as typeof import('@/services/offlineQueue');
  /** what reached the server, in order */
  let calls: string[];

  beforeEach(async () => {
    calls = [];
    api.addEntry = jest.fn(async () => {
      calls.push('addEntry');
      return { entry: { value: 1, late: false }, standings: [] };
    });
    // parked during the outage, the app open all along
    await enqueueEntry(
      'c-1',
      { dayKey: '2026-09-08', value: 1, source: 'checkin', clientTime: '2026-09-08T03:58:00.000Z' },
      'c-1:2026-09-08:checkin:'
    );
  });

  afterEach(async () => {
    for (const item of await readQueue()) await removeFromQueue(item.id);
  });

  async function pull(tree: ReactTestRenderer): Promise<void> {
    calls = [];
    mockReminders.refresh.mockClear();
    act(() => {
      (tree.root.findByType(RefreshControl).props as { onRefresh: () => void }).onRefresh();
    });
    await settle();
  }

  it('sends it before Ana sayfa reads the cards again', async () => {
    api.challenges = jest.fn(async () => {
      calls.push('challenges');
      return [];
    });
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const tree = renderScreen(<HomeScreen />);
    await settle();
    expect(await readQueue()).toHaveLength(1);

    await pull(tree);

    expect(calls[0]).toBe('addEntry');
    expect(calls).toContain('challenges');
    expect(await readQueue()).toEqual([]);
    // the check-in counted: today's "30 dakikan kaldı" goes with it, as after the bridge's drain
    expect(mockReminders.refresh).toHaveBeenCalledWith(api, 2, 'Europe/Istanbul');
  });

  it('sends it before the çelınc screen reads itself again', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => {
      calls.push('challenge');
      return challengeDetail();
    });
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();
    expect(await readQueue()).toHaveLength(1);

    await pull(tree);

    expect(calls.slice(0, 2)).toEqual(['addEntry', 'challenge']);
    expect(api.addEntry).toHaveBeenCalledWith('c-1', expect.objectContaining({ source: 'checkin' }));
    expect(await readQueue()).toEqual([]);
    expect(mockReminders.refresh).toHaveBeenCalledWith(api, 2, 'Europe/Istanbul');
  });

  it('still refreshes the screen when the entry cannot go yet', async () => {
    searchParams.id = 'c-1';
    api.addEntry = jest.fn(async () => {
      calls.push('addEntry');
      throw NETWORK_ERROR;
    });
    api.challenge = jest.fn(async () => {
      calls.push('challenge');
      return challengeDetail();
    });
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    await pull(tree);

    expect(calls).toEqual(['addEntry', 'challenge']);
    expect(await readQueue()).toHaveLength(1);
    // nothing landed: the poke stays to bring the app back before the deadline
    expect(mockReminders.refresh).not.toHaveBeenCalled();
    expect((tree.root.findByType(RefreshControl).props as { refreshing: boolean }).refreshing).toBe(false);
  });

  it('waits a few seconds for an upload, not two minutes, and reads the screen again when it lands', async () => {
    // a proof photo first in line on a weak uplink: the spinner stayed up and
    // nothing was read again until the upload ended or timed out
    searchParams.id = 'c-1';
    let land: () => void = () => {};
    api.addEntry = jest.fn(
      () =>
        new Promise((resolve) => {
          calls.push('addEntry');
          land = () => resolve({ entry: { value: 1, late: false }, standings: [] });
        })
    );
    api.challenge = jest.fn(async () => {
      calls.push('challenge');
      return challengeDetail();
    });
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();
    calls = [];
    const spinner = () => (tree.root.findByType(RefreshControl).props as { refreshing: boolean }).refreshing;

    // only the timeouts wait for the test; everything else runs as usual
    jest.useFakeTimers({
      doNotFake: [
        'Date', 'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
        'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
      ],
    });
    const advance = async (ms: number) => {
      for (let i = 0; i < 10; i++) {
        await act(async () => {
          await jest.advanceTimersByTimeAsync(i === 0 ? ms : 0);
        });
      }
    };
    try {
      act(() => {
        (tree.root.findByType(RefreshControl).props as { onRefresh: () => void }).onRefresh();
      });
      await advance(PULL_FLUSH_WAIT_MS - 1);
      expect(calls).toEqual(['addEntry']);
      expect(spinner()).toBe(true);

      await advance(1);
      expect(calls).toEqual(['addEntry', 'challenge']);
      expect(spinner()).toBe(false);

      // the upload ends after the pull let go: the screen shows it counted
      await act(async () => land());
      await advance(0);
      expect(calls).toEqual(['addEntry', 'challenge', 'challenge']);
      expect(await readQueue()).toEqual([]);
    } finally {
      // a failed expectation must not leave the flush holding the queue
      land();
      jest.useRealTimers();
    }
  });
});

describe('badge names at the reader\'s level', () => {
  const ALI = { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };

  it('a "Nazik" reader chases "İlk Zafer" on their own ladder, not "Çırak Saplamacı"', async () => {
    mockLevel.value = 1;
    const ProfileScreen = require('@/app/(app)/(tabs)/profile').default;
    const polite = renderScreen(<ProfileScreen />);
    await settle();
    // no win yet: koyus_1 is the rung on show
    expect(rendered(polite)).toContain('İlk Zafer');
    expect(rendered(polite)).not.toContain('Saplamacı');

    mockLevel.value = 2;
    const casual = renderScreen(<ProfileScreen />);
    await settle();
    expect(rendered(casual)).toContain('Çırak Saplamacı');
  });

  it('names a friend\'s badges at my level, not theirs', async () => {
    mockLevel.value = 1;
    searchParams.id = ALI.id;
    api.userProfile = jest.fn(async () => ({
      ...ALI,
      stats: { wins: 1, losses: 0, challengesPlayed: 1 },
      badges: ['koyus_1'],
    }));
    api.friends = jest.fn(async () => ({ friends: [ALI], incoming: [], outgoing: [] }));
    const UserScreen = require('@/app/(app)/user/[id]').default;
    const tree = renderScreen(<UserScreen />);
    await settle();

    const text = rendered(tree);
    expect(text).toContain('İlk Zafer');
    expect(text).toContain('🏆');
    expect(text).not.toContain('Saplamacı');
  });
});

describe('the score tiles at the reader\'s level', () => {
  it('a "Nazik" reader sees Galibiyet and Yenilgi on their own karne, no eggplant', async () => {
    mockLevel.value = 1;
    const ProfileScreen = require('@/app/(app)/(tabs)/profile').default;
    const polite = renderScreen(<ProfileScreen />);
    await settle();
    expect(rendered(polite)).toContain('🏆 0 GALİBİYET');
    expect(rendered(polite)).toContain('YENİLGİ');
    expect(rendered(polite)).not.toContain('YEDİM');
    expect(rendered(polite)).not.toContain('KOYDUM');

    mockLevel.value = 2;
    const casual = renderScreen(<ProfileScreen />);
    await settle();
    expect(rendered(casual)).toContain('🍆 0 KOYDUM');
    expect(rendered(casual)).toContain('YEDİM');
  });

  it('a friend\'s score reads the same way', async () => {
    const ALI = { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };
    mockLevel.value = 1;
    searchParams.id = ALI.id;
    api.userProfile = jest.fn(async () => ({
      ...ALI,
      stats: { wins: 2, losses: 1, challengesPlayed: 3 },
      badges: [],
    }));
    api.friends = jest.fn(async () => ({ friends: [ALI], incoming: [], outgoing: [] }));
    const UserScreen = require('@/app/(app)/user/[id]').default;
    const tree = renderScreen(<UserScreen />);
    await settle();
    const text = rendered(tree);
    expect(text).toContain('🏆 2 GALİBİYET');
    expect(text).toContain('😵 1 YENİLGİ');
    expect(text).not.toContain('KOYDU');
    expect(text).not.toContain('🍆');
  });
});

describe('the profile of a "Nazik" reader', () => {
  const ALI = { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };

  it('names the board and the win and loss ladders without koy or ye', async () => {
    mockLevel.value = 1;
    api.leaderboard = jest.fn(async () => [{ user: ALI, wins: 4, losses: 1, rank: 1 }]);
    const ProfileScreen = require('@/app/(app)/(tabs)/profile').default;
    const polite = renderScreen(<ProfileScreen />);
    await settle();
    const text = rendered(polite);
    expect(text).toContain('en çok kazananlar');
    expect(text).toContain('galibiyet');
    // spelled out in both cases: /i does not pair i with İ
    expect(text).not.toMatch(/koyuş|koyan|yiyiş|KOYUŞ|YİYİŞ/);

    mockLevel.value = 2;
    const casual = renderScreen(<ProfileScreen />);
    await settle();
    expect(rendered(casual)).toContain('en çok koyanlar');
    expect(rendered(casual)).toContain('koyuş');
    expect(rendered(casual)).toContain('KOYUŞ');
    expect(rendered(casual)).toContain('YİYİŞ');
  });

  it('explains the first rung of wins in plain words', async () => {
    mockLevel.value = 1;
    const ProfileScreen = require('@/app/(app)/(tabs)/profile').default;
    const tree = renderScreen(<ProfileScreen />);
    await settle();
    const [rung] = tree.root.findAll(
      (node) => node.props.rung?.badge?.key === 'koyus_1' && typeof node.props.onPress === 'function'
    );
    act(() => {
      rung!.props.onPress(rung!.props.rung);
    });

    const text = rendered(tree);
    // the sheet's line is several text nodes: "Galibiyet", " merdiveni · ", "1", ". basamak"
    expect(text).toMatch(/Galibiyet\s+merdiveni/);
    expect(text).not.toContain('Koyuş');
    expect(text).toContain('Hangi türde olursa olsun, her galibiyet sayılır.');
    expect(text).not.toContain('o koyar');
  });

  it('says what my own public profile is for without koy', async () => {
    mockLevel.value = 1;
    searchParams.id = ME.id;
    api.userProfile = jest.fn(async () => ({ ...ME, stats: { wins: 0, losses: 0, challengesPlayed: 0 }, badges: [] }));
    const UserScreen = require('@/app/(app)/user/[id]').default;
    const tree = renderScreen(<UserScreen />);
    await settle();

    expect(rendered(tree)).toContain('Bu sensin. Kendinle yarışamazsın.');
    expect(rendered(tree)).not.toContain('koyamazsın');
  });
});

describe('the rövanş rung on the profile', () => {
  it('asks for a lost çelınc won back, not for any rematch won', async () => {
    const ProfileScreen = require('@/app/(app)/(tabs)/profile').default;
    const tree = renderScreen(<ProfileScreen />);
    await settle();
    // revengeWins counts only the rematch of one you lost: "3 rövanş kazan"
    // left somebody who keeps winning rematches of his own wins at 0/3
    expect(rendered(tree)).toContain('Kaybettiğin 3 çelıncın rövanşını al');
    expect(rendered(tree)).not.toContain('3 rövanş kazan');
  });
});

describe('the odak and adım rungs on the profile', () => {
  const stats = ME.stats;
  const badges = ME.badges;

  afterEach(() => {
    ME.stats = stats;
    ME.badges = badges;
  });

  it('asks for focus in minutes, the unit of the progress under it', async () => {
    ME.stats = { ...stats, focusTotalMinutes: 1280 };
    ME.badges = ['odak_1', 'odak_2'];
    const ProfileScreen = require('@/app/(app)/(tabs)/profile').default;
    const tree = renderScreen(<ProfileScreen />);
    await settle();
    const text = rendered(tree);
    // "Toplam 50sa odaklan" over "1.280 / 3.000" left the reader to convert
    expect(text).toContain('Toplam 3.000 dakika odaklan');
    expect(text).toContain('1.280 / 3.000');
    expect(text).not.toContain('50sa');
  });

  it('says the step rung counts what the phone counted', async () => {
    ME.stats = { ...stats, stepsSingleDayMax: 4000 };
    const ProfileScreen = require('@/app/(app)/(tabs)/profile').default;
    const tree = renderScreen(<ProfileScreen />);
    await settle();
    const text = rendered(tree);
    // a day typed with "Beyan et" never moves it, and nothing used to say so
    expect(text).toContain('Tek günde 7.500 adım at (telefonun saydığı)');
    expect(text).toContain('4.000 / 7.500');
  });
});

describe('the kanka count on the Karne', () => {
  const ALI = { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };
  const CAN = { ...ALI, id: 'u-4', username: 'can', displayName: 'Can' };

  // the other tiles come from the stored profile; this one from GET /friends,
  // which a cold start with the PC asleep never got
  it('says it does not know rather than 0 when the friends list did not come', async () => {
    api.friends = jest.fn(async () => {
      throw NETWORK_ERROR;
    });
    const ProfileScreen = require('@/app/(app)/(tabs)/profile').default;
    const tree = renderScreen(<ProfileScreen />);
    await settle();
    expect(api.friends).toHaveBeenCalled();
    expect(rendered(tree)).toContain('🫂 – KANKA');
    expect(rendered(tree)).not.toContain('🫂 0 KANKA');
  });

  it('counts them once they come, and a real 0 stays 0', async () => {
    api.friends = jest.fn(async () => ({ friends: [ALI, CAN], incoming: [], outgoing: [] }));
    const ProfileScreen = require('@/app/(app)/(tabs)/profile').default;
    const two = renderScreen(<ProfileScreen />);
    await settle();
    expect(rendered(two)).toContain('🫂 2 KANKA');

    api.friends = jest.fn(async () => ({ friends: [], incoming: [], outgoing: [] }));
    const none = renderScreen(<ProfileScreen />);
    await settle();
    expect(rendered(none)).toContain('🫂 0 KANKA');
  });
});

describe('Sıralama on the profile', () => {
  const ALI = { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };

  // The tab refetches the board on focus and after a finish; the owner's PC
  // asleep or the tunnel down must not swap the board it showed for an error.
  it('keeps the last board when a refetch fails, and says it is not the newest', async () => {
    api.leaderboard = jest.fn(async () => [{ user: ALI, wins: 4, losses: 1, rank: 1 }]);
    const ProfileScreen = require('@/app/(app)/(tabs)/profile').default;
    const tree = renderScreen(<ProfileScreen />);
    await settle();
    expect(rendered(tree)).toContain('Ali');
    expect(rendered(tree)).not.toContain('Güncellenemedi');

    api.leaderboard = jest.fn(async () => {
      throw NETWORK_ERROR;
    });
    await act(async () => {
      await clientOf(tree).refetchQueries({ queryKey: ['leaderboard'] });
    });
    await settle();
    expect(api.leaderboard).toHaveBeenCalled();
    const text = rendered(tree);
    expect(text).toContain('Ali');
    expect(text).toContain('Güncellenemedi, son gelen sıralama bu.');
    expect(text).not.toContain('Sunucuya ulaşamadım');
  });

  it('shows the error with a retry when there is no board to keep', async () => {
    api.leaderboard = jest.fn(async () => {
      throw NETWORK_ERROR;
    });
    const ProfileScreen = require('@/app/(app)/(tabs)/profile').default;
    const tree = renderScreen(<ProfileScreen />);
    await settle();
    expect(rendered(tree)).toContain('Sunucuya ulaşamadım');
    expect(rendered(tree)).toContain('TEKRAR DENE');
  });
});

describe('a server whose clock is off from the phone', () => {
  const ALI = { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };
  const HOURS_3 = 3 * 60 * 60_000;

  /** As if /health had just answered with the server `skewMs` ahead of this phone. */
  function serverAhead(skewMs: number): void {
    const { noteServerTime } = require('@/utils/serverClock') as typeof import('@/utils/serverClock');
    const now = Date.now();
    act(() => {
      noteServerTime(new Date(now + skewMs).toISOString(), now, now);
    });
  }

  // the reading lives in a module every screen in this file shares
  afterEach(() => serverAhead(0));

  it('says so on home with hours between them, not over a minute', async () => {
    serverAhead(60_000);
    const HomeScreen = require('@/app/(app)/(tabs)/index').default;
    const tree = renderScreen(<HomeScreen />);
    await settle();
    expect(rendered(tree)).not.toContain('Saatler tutmuyor');

    // a Windows PC that last booted Linux, 3 hours behind until it resyncs
    serverAhead(-HOURS_3);
    expect(rendered(tree)).toContain('Saatler tutmuyor');
    expect(rendered(tree)).toContain('Sunucunun saati seninkinden 3 saat geri.');
    expect(rendered(tree)).toContain('“Şimdi eşitle”ye bassın.');
  });

  it('says so in Ayarlar too', async () => {
    serverAhead(20 * 60_000);
    const SettingsScreen = require('@/app/(app)/settings').default;
    const tree = renderScreen(<SettingsScreen />);
    await settle();
    expect(rendered(tree)).toContain('Sunucunun saati seninkinden 20 dakika ileri.');
  });

  it('starts a "Hemen" çelınc at the server\'s now, not the phone\'s', async () => {
    serverAhead(HOURS_3);
    api.friends = jest.fn(async () => ({ friends: [ALI], incoming: [], outgoing: [] }));
    api.createChallenge = jest.fn(async () => ({ id: 'c-new' }));
    const NewChallengeScreen = require('@/app/(app)/challenge/new').default;
    const tree = renderScreen(<NewChallengeScreen />);
    await settle();

    const [row] = tree.root.findAll(
      (node) => typeof node.props.onSelect === 'function' && node.props.type?.key === 'adim_yarisi'
    );
    if (!row) throw new Error('adim_yarisi bulunamadı');
    act(() => {
      row.props.onSelect(row.props.type);
    });
    press(tree, 'İleri');
    press(tree, 'İleri');
    const [ali] = tree.root.findAll(
      (node) => typeof node.props.onToggle === 'function' && node.props.user?.id === ALI.id
    );
    if (!ali) throw new Error('Ali bulunamadı');
    act(() => {
      ali.props.onToggle(ALI.id);
    });
    press(tree, 'İleri');
    await act(async () => {
      findWith(tree, 'title', 'KOY BAKALIM', 'onPress').props.onPress();
    });

    expect(api.createChallenge).toHaveBeenCalledTimes(1);
    const [body] = api.createChallenge.mock.calls[0] as [{ startsAt: string }];
    // a phone 3 hours slow used to send its own now, which the server refused as the past
    expect(Math.abs(Date.parse(body.startsAt) - (Date.now() + HOURS_3))).toBeLessThan(5_000);
  });
});
