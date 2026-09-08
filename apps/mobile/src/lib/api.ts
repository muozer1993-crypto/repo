import type {
  AuthResponse,
  Challenge,
  ChallengeDetail,
  ChallengeResults,
  ChallengeSummary,
  ChallengeType,
  Entry,
  FriendsView,
  LeaderboardEntry,
  Me,
  Notification,
  ParticipantView,
  PublicProfile,
  PublicUser,
  TauntTemplate,
  UnreadCount,
} from '@koydum/shared';

import { stripTrailingSlash } from '@/lib/config';

/** Thrown for every non-2xx response so screens can branch on `code`. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly issues?: unknown;

  constructor(code: string, message: string, status: number, issues?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.issues = issues;
  }

  /** True when the phone could not reach the server at all. */
  get isNetwork(): boolean {
    return this.status === 0;
  }

  get isAuth(): boolean {
    return this.status === 401;
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  token?: string | null;
  /** milliseconds; a phone on a bad connection should fail fast */
  timeoutMs?: number;
  /** called whenever the server rejects our token, so the app can log out */
  onUnauthorized?: () => void;
}

type Query = Record<string, string | number | boolean | null | undefined>;

export class ApiClient {
  baseUrl: string;
  token: string | null;
  private readonly timeoutMs: number;
  private readonly onUnauthorized?: () => void;

  constructor(options: ApiClientOptions) {
    this.baseUrl = stripTrailingSlash(options.baseUrl);
    this.token = options.token ?? null;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.onUnauthorized = options.onUnauthorized;
  }

  withToken(token: string | null): ApiClient {
    this.token = token;
    return this;
  }

  private url(path: string, query?: Query): string {
    const base = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    if (!query) return base;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined || value === '') continue;
      params.append(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    options: { body?: unknown; query?: Query; formData?: FormData } = {}
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(this.url(path, options.query), {
        method,
        headers,
        body: options.formData ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new ApiError(
        aborted ? 'timeout' : 'network',
        aborted
          ? 'Sunucu cevap vermedi. Bağlantını kontrol et.'
          : 'Sunucuya ulaşamadım. Aynı ağda mısın, adres doğru mu?',
        0
      );
    }
    clearTimeout(timer);

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const envelope = payload as { error?: { code?: string; message?: string; issues?: unknown } } | null;
      const code = envelope?.error?.code ?? `http_${response.status}`;
      const message = envelope?.error?.message ?? 'Bir şeyler ters gitti.';
      if (response.status === 401) this.onUnauthorized?.();
      throw new ApiError(code, message, response.status, envelope?.error?.issues);
    }

    return payload as T;
  }

  /* ------------------------------------------------------------- health */

  health() {
    return this.request<{ ok: boolean; version: string; time: string }>('GET', '/health');
  }

  /* --------------------------------------------------------------- auth */

  register(body: { username: string; password: string; displayName: string; timezone: string; vulgarityMax?: number }) {
    return this.request<AuthResponse>('POST', '/auth/register', { body });
  }

  login(body: { username: string; password: string }) {
    return this.request<AuthResponse>('POST', '/auth/login', { body });
  }

  /* ----------------------------------------------------------------- me */

  me() {
    return this.request<Me>('GET', '/me');
  }

  updateMe(body: {
    displayName?: string;
    avatarEmoji?: string;
    vulgarityMax?: number;
    timezone?: string;
    reminderHour?: number | null;
  }) {
    return this.request<Me>('PATCH', '/me', { body });
  }

  deleteMe() {
    return this.request<{ ok: true }>('DELETE', '/me');
  }

  setPushToken(body: { token: string; platform: 'ios' | 'android' | 'web' }) {
    return this.request<{ ok: true }>('POST', '/me/push-token', { body });
  }

  clearPushToken() {
    return this.request<{ ok: true }>('DELETE', '/me/push-token');
  }

  syncSteps(days: { dayKey: string; steps: number; source: 'pedometer' | 'health_connect' }[]) {
    return this.request<{ updated: number }>('POST', '/me/steps', { body: { days } });
  }

  inbox(params: { before?: string; limit?: number } = {}) {
    return this.request<Notification[]>('GET', '/me/inbox', { query: params });
  }

  markInboxRead(body: { ids?: string[]; all?: boolean }) {
    return this.request<{ ok: true }>('POST', '/me/inbox/read', { body });
  }

  unreadCount() {
    return this.request<UnreadCount>('GET', '/me/inbox/unread');
  }

  /* -------------------------------------------------------------- users */

  searchUsers(q: string) {
    return this.request<PublicUser[]>('GET', '/users/search', { query: { q } });
  }

  userProfile(id: string) {
    return this.request<PublicProfile>('GET', `/users/${id}`);
  }

  blockUser(id: string) {
    return this.request<{ ok: true }>('POST', `/users/${id}/block`);
  }

  unblockUser(id: string) {
    return this.request<{ ok: true }>('POST', `/users/${id}/unblock`);
  }

  reportUser(id: string, reason: string) {
    return this.request<{ ok: true }>('POST', `/users/${id}/report`, { body: { reason } });
  }

  /* ------------------------------------------------------------ friends */

  friends() {
    return this.request<FriendsView>('GET', '/friends');
  }

  requestFriend(body: { username?: string; inviteCode?: string }) {
    return this.request<{ status: 'pending' | 'accepted' }>('POST', '/friends/request', { body });
  }

  acceptFriend(friendshipId: string) {
    return this.request<{ ok: true }>('POST', `/friends/${friendshipId}/accept`);
  }

  declineFriend(friendshipId: string) {
    return this.request<{ ok: true }>('POST', `/friends/${friendshipId}/decline`);
  }

  removeFriend(userId: string) {
    return this.request<{ ok: true }>('DELETE', `/friends/${userId}`);
  }

  /* ------------------------------------------------------------ catalog */

  catalog() {
    return this.request<{
      version: string;
      types: ChallengeType[];
      taunts: TauntTemplate[];
      microcopy: Record<string, { level1: string; level2: string; level3: string }>;
      badges: { key: string; nameTr: string; emoji: string; descriptionTr: string; rule: string }[];
    }>('GET', '/catalog');
  }

  /* --------------------------------------------------------- challenges */

  challenges(status?: string) {
    return this.request<ChallengeSummary[]>('GET', '/challenges', { query: { status } });
  }

  challenge(id: string) {
    return this.request<ChallengeDetail>('GET', `/challenges/${id}`);
  }

  createChallenge(body: {
    typeKey: string;
    title?: string;
    startsAt: string;
    endsAt: string;
    participantIds: string[];
    rewardText?: string;
    penaltyText?: string;
    deadlineTime?: string;
    dailyTarget?: number;
    proofRequired?: boolean;
  }) {
    return this.request<Challenge>('POST', '/challenges', { body });
  }

  acceptChallenge(id: string) {
    return this.request<{ ok: true }>('POST', `/challenges/${id}/accept`);
  }

  declineChallenge(id: string) {
    return this.request<{ ok: true }>('POST', `/challenges/${id}/decline`);
  }

  leaveChallenge(id: string) {
    return this.request<{ ok: true }>('POST', `/challenges/${id}/leave`);
  }

  cancelChallenge(id: string) {
    return this.request<{ ok: true }>('POST', `/challenges/${id}/cancel`);
  }

  addEntry(
    id: string,
    body: {
      dayKey: string;
      value: number;
      source: string;
      note?: string;
      proofUrl?: string;
      clientTime: string;
      sessionId?: string;
    }
  ) {
    return this.request<{ entry: Entry; standings: ParticipantView[] }>('POST', `/challenges/${id}/entries`, {
      body,
    });
  }

  deleteEntry(challengeId: string, entryId: string) {
    return this.request<{ ok: true }>('DELETE', `/challenges/${challengeId}/entries/${entryId}`);
  }

  disputeEntry(challengeId: string, entryId: string, reason: string) {
    return this.request<{ ok: true }>('POST', `/challenges/${challengeId}/entries/${entryId}/dispute`, {
      body: { reason },
    });
  }

  poke(challengeId: string, body: { toUserId: string; templateId?: string }) {
    return this.request<{ ok: true }>('POST', `/challenges/${challengeId}/poke`, { body });
  }

  taunt(challengeId: string, body: { toUserId: string; templateId?: string; customBody?: string }) {
    return this.request<{ ok: true }>('POST', `/challenges/${challengeId}/taunt`, { body });
  }

  rematch(challengeId: string) {
    return this.request<Challenge>('POST', `/challenges/${challengeId}/rematch`);
  }

  results(challengeId: string) {
    return this.request<ChallengeResults>('GET', `/challenges/${challengeId}/results`);
  }

  leaderboard() {
    return this.request<LeaderboardEntry[]>('GET', '/leaderboard');
  }

  /* ------------------------------------------------------------ uploads */

  async uploadPhoto(uri: string, name = 'kanit.jpg'): Promise<{ url: string }> {
    const form = new FormData();
    const type = name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    // React Native's FormData accepts this shape; the DOM types do not know it
    form.append('file', { uri, name, type } as unknown as Blob, name);
    return this.request<{ url: string }>('POST', '/uploads', { formData: form });
  }
}

/** Convenience wrapper used outside React (background tasks). */
export function createClient(baseUrl: string, token: string | null): ApiClient {
  return new ApiClient({ baseUrl, token });
}
