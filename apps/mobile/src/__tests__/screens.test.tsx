import type { Me } from '@koydum/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '@/components/Toast';
import { ApiError } from '@/lib/api';

/**
 * Every list screen has to survive the three states the server actually
 * produces: an empty list, a failed request, and a deep link whose route param
 * never arrived. A throw in any of them is a blank app, so they get rendered
 * here rather than trusted.
 */

/* ------------------------------------------------------------------ mocks */

const searchParams: { id?: string } = {};

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), canGoBack: () => false },
  useLocalSearchParams: () => searchParams,
  Link: ({ children }: { children: React.ReactNode }) => children,
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

jest.mock('@/store/auth', () => ({
  useAuth: (selector: (state: unknown) => unknown) =>
    selector({
      me: ME,
      token: 'token',
      serverUrl: 'http://localhost:4000',
      refreshMe: jest.fn(),
      setSession: mockSetSession,
      rememberServerId: jest.fn(async () => {}),
      sessionEnded: mockSession.ended,
      clearSessionEnded: mockClearSessionEnded,
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

// Ayarlar asks for push on mount; the real module would load expo-notifications
jest.mock('@/services/notifications', () => ({
  registerForPush: jest.fn(async () => ({ token: null, reason: 'web' })),
}));

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
      mutations: { retry: false },
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

afterEach(() => {
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
  delete searchParams.id;
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
      endsAt: '2026-09-14T00:00:00.000Z',
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
