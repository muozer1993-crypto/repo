import type { Entry, Me, ParticipantView } from '@koydum/shared';
import { LIMITS, addDays, todayKey } from '@koydum/shared';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '@/components/Toast';
import { ApiClient, ApiError } from '@/lib/api';
import { clearPendingInvite, readPendingInvite } from '@/services/invite';

/**
 * Every list screen has to survive the three states the server actually
 * produces: an empty list, a failed request, and a deep link whose route param
 * never arrived. A throw in any of them is a blank app, so they get rendered
 * here rather than trusted.
 */

/* ------------------------------------------------------------------ mocks */

const searchParams: { id?: string; with?: string; show?: string; day?: string } = {};

/** The last focus effect a screen handed over; nothing navigates here, so tests run it by hand. */
const mockFocus: { effect?: () => void } = {};

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), canGoBack: () => false },
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

/** what a 401 leaves behind for the login screen (see store/auth) */
const mockSession = { ended: false };
const mockClearSessionEnded = jest.fn(() => {
  mockSession.ended = false;
});
const mockSetSession = jest.fn(async () => {});
/** the ApiClient the auth screens build from the store */
const mockLogin = jest.fn(async (_body: { username: string; password: string }) => ({
  token: 'token',
  me: { ...ME, timezone: 'Europe/Istanbul' },
}));
const mockSetMe = jest.fn(async () => {});
/** the address the screens see; a fresh install sits on the localhost fallback */
const mockServer = { url: 'http://localhost:4000' };
const mockSetServerUrl = jest.fn(async (url: string) => {
  mockServer.url = url;
});

jest.mock('@/store/auth', () => ({
  useAuth: (selector: (state: unknown) => unknown) =>
    selector({
      me: ME,
      token: 'token',
      serverUrl: mockServer.url,
      setServerUrl: mockSetServerUrl,
      refreshMe: jest.fn(),
      setSession: mockSetSession,
      setMe: mockSetMe,
      client: () => ({ login: mockLogin }),
      rememberServerId: jest.fn(async () => {}),
      sessionEnded: mockSession.ended,
      clearSessionEnded: mockClearSessionEnded,
      onboarding: false,
      setOnboarding: jest.fn(),
    }),
  useLevel: () => 2,
  deviceTimezone: () => 'Europe/Istanbul',
}));

jest.mock('@/services/steps', () => ({
  getDailySteps: jest.fn(async () => []),
  getTodaySteps: jest.fn(async () => 0),
  getStepAvailability: jest.fn(async () => ({ available: false, reason: 'web' })),
  requestStepPermission: jest.fn(async () => false),
  openHealthConnectSettingsIfPossible: jest.fn(async () => false),
  startForegroundStepTracking: () => () => {},
}));

/** What the phone says about the notification permission, read without asking (home's card). */
const mockNotifPermission: { status: 'granted' | 'denied' | 'undetermined' | 'unknown' } = { status: 'granted' };

// Ayarlar asks for push on mount; the real module would load expo-notifications
jest.mock('@/services/notifications', () => ({
  registerForPush: jest.fn(async () => ({ token: null, reason: 'web' })),
  pushPermissionStatus: async () => mockNotifPermission.status,
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

/** The photo the picker hands back, from the camera or the gallery alike (its cache file on a phone). */
const mockPickedPhoto = { uri: 'file:///data/user/0/com.koydum.app/cache/ImagePicker/kanit-1.jpeg' };

jest.mock('expo-image-picker', () => {
  const picked = async () => ({
    canceled: false,
    assets: [{ uri: mockPickedPhoto.uri, fileName: 'kanit-1.jpeg', width: 1200, height: 900 }],
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
  mockDeviceHealth.state = null;
  mockNotifPermission.status = 'granted';
  delete searchParams.id;
  delete searchParams.with;
  delete searchParams.show;
  delete searchParams.day;
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
    api.challenge = jest.fn(async () => challengeDetail());
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

  it('takes it back as well when the check-in is parked offline', async () => {
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
    expect(mockReminders.skipToday).toHaveBeenCalledWith('c-1', expect.any(String));
  });

  it('leaves the poke alone when the server turns the check-in down', async () => {
    searchParams.id = 'c-1';
    api.challenge = jest.fn(async () => checkinDetail());
    api.addEntry = jest.fn(async () => {
      throw new ApiError('checkin_too_early', "Bu check-in 04:00'den sonra sayılıyor. Biraz erken geldin.", 400);
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
    expect(rendered(behind)).toContain('BERABERE LAN');
    expect(() => findWith(behind, 'title', 'Laf at', 'onPress')).toThrow();
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
});

/** The first mounted element carrying `props[key] === value` and a handler named `handler`. */
function findWith(tree: ReactTestRenderer, key: string, value: string, handler: string) {
  const [node] = tree.root.findAll(
    (candidate) => candidate.props[key] === value && typeof candidate.props[handler] === 'function'
  );
  if (!node) throw new Error(`${key}="${value}" bulunamadı`);
  return node;
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

    expect(api.changePassword).toHaveBeenCalledWith({ currentPassword: 'yanlis', newPassword: 'yepyeni42' });
    expect(rendered(tree)).toContain('Mevcut şifren tutmadı.');
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it('stores the session the server hands back', async () => {
    api.changePassword = jest.fn(async () => ({ token: 'yeni-token', me: ME }));
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

describe('saying no to a çelınc', () => {
  const ALI = { id: 'u-2', username: 'ali', displayName: 'Ali', avatarEmoji: '🐐', createdAt: '2026-09-01T00:00:00.000Z' };
  const CEM = { id: 'u-3', username: 'cem', displayName: 'Cem', avatarEmoji: '🦁', createdAt: '2026-09-01T00:00:00.000Z' };

  /** Ali's çelınc, the reader in it as `mine`; `crowd` adds Cem, still thinking about it. */
  function aliInvites(mine: 'invited' | 'declined', crowd = false) {
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
    expect(api.declineChallenge).not.toHaveBeenCalled();

    await answerAlert('Vazgeç');
    expect(api.declineChallenge).not.toHaveBeenCalled();

    press(tree, 'Reddet');
    await settle();
    await answerAlert('Reddet');
    expect(api.declineChallenge).toHaveBeenCalledWith('c-1');
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
    expect(api.declineChallenge).not.toHaveBeenCalled();
    await answerAlert('Reddet');
    expect(api.declineChallenge).toHaveBeenCalledWith('c-1');
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

  it('is not there for a friend who did not open the çelınc', async () => {
    searchParams.id = 'c-1';
    const detail = mine();
    api.challenge = jest.fn(async () => ({ ...detail, challenge: { ...detail.challenge, creatorId: ALI.id } }));
    const ChallengeScreen = require('@/app/(app)/challenge/[id]/index').default;
    const tree = renderScreen(<ChallengeScreen />);
    await settle();

    expect(rendered(tree)).toContain('Haftalık Adım');
    expect(rendered(tree)).not.toContain('KANKALARI ÇAĞIR');
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
