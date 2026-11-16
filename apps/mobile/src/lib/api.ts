import type {
  AuthResponse,
  Challenge,
  ChallengeDetail,
  ChallengeResults,
  ChallengeSummary,
  ChallengeType,
  Entry,
  FeedPage,
  FriendAcceptResult,
  FriendsView,
  LeaderboardEntry,
  Me,
  Notification,
  ParticipantView,
  PublicProfile,
  ProveBody,
  ProveResponse,
  PublicUser,
  TauntTemplate,
  UnreadCount,
} from '@koydum/shared';

import { stripTrailingSlash } from '@/lib/config';
import { isLocalNetworkUrl } from '@/utils/url';

/**
 * A proxy's own "the server behind me is gone": 502/503/504 from any gateway,
 * 520-530 from Cloudflare (530 is the tunnel with the owner's PC asleep).
 */
function gatewayDown(status: number): boolean {
  return status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);
}

/**
 * Thrown for every non-2xx response so screens can branch on `code`. Two codes
 * are the client's own, for replies our server never sends: `server_down` (a
 * gateway says the server is off, status kept) and `not_koydum` (something
 * else answered: a page, or an error without our envelope).
 */
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
  /** milliseconds; a phone on a bad connection should fail fast (photo uploads: UPLOAD_TIMEOUT_MS) */
  timeoutMs?: number;
  /**
   * called whenever the server rejects our token, so the app can log out; the
   * error carries the server's reason (an expired session, a password change)
   */
  onUnauthorized?: (error: ApiError) => void;
}

type Query = Record<string, string | number | boolean | null | undefined>;

/**
 * How long a proof photo may take to go up. The pickers send the camera's full
 * resolution at quality 0.6, 1.5-3 MB, and a phone on home ADSL (about 1 Mbit
 * up) or weak 4G needs 15-25 s for that: with the 15 s every other call gets, a
 * photo on a working connection timed out and was parked as if there were no
 * signal. The server puts no limit of its own on a request (Fastify's
 * requestTimeout is off), so this is the only clock on the upload.
 */
export const UPLOAD_TIMEOUT_MS = 120_000;

/** `app` is the Android build the server offers, when the operator published one. */
export interface HealthResponse {
  ok: boolean;
  version: string;
  time: string;
  app?: { latestVersion: string | null; downloadUrl: string; notes: string | null } | null;
  /** the address friends elsewhere should use (set by `npm run internet` / PUBLIC_URL) */
  publicUrl?: string | null;
  /**
   * Stays the same across restarts and new addresses, changes exactly when the
   * server's old tokens stop working (services/serverMove.ts). Older servers
   * leave it out.
   */
  serverId?: string | null;
}

export interface InviteLookup {
  code: string;
  inviter: { username: string; displayName: string; avatarEmoji: string };
}

export class ApiClient {
  baseUrl: string;
  token: string | null;
  private readonly timeoutMs: number;
  private readonly onUnauthorized?: (error: ApiError) => void;

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
    options: { body?: unknown; query?: Query; formData?: FormData; timeoutMs?: number } = {}
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
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
      // "the same network" only helps with a home address; a tunnel is reached
      // from anywhere, so there the PC or its changed address is the suspect
      const unreachable = isLocalNetworkUrl(this.baseUrl)
        ? 'Sunucuya ulaşamadım. Aynı ağda mısın, adres doğru mu?'
        : 'Sunucuya ulaşamadım. İnternetin açık mı? Açıksa sunucu kapalı ya da adresi değişmiş olabilir; kankandan yeni bağlantıyı iste.';
      throw new ApiError(
        aborted ? 'timeout' : 'network',
        aborted ? 'Sunucu cevap vermedi. Bağlantını kontrol et.' : unreachable,
        0
      );
    }
    clearTimeout(timer);

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    let payload: unknown = null;
    let json = true;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        json = false;
      }
    }

    // Our server renders every failure, its own 404s and 500s included, as this
    // envelope (server/src/errors.ts). A reply without it came from something
    // in between: the tunnel while the owner's PC sleeps, a Wi-Fi login page,
    // a router. None of those speaks for our server, so none of them is ever a
    // refusal of an entry or the end of a session.
    const envelope = payload as { error?: { code?: string; message?: string; issues?: unknown } } | null;
    const ours = typeof envelope?.error?.code === 'string';

    if (!response.ok && !ours) {
      // The status stays: a 5xx parks an entry for later, as before. Cloudflare
      // answers a quick tunnel's old address (its window reopened, the home
      // internet back) with the same 530 as a sleeping PC: that one never
      // heals by itself, and the friend needs the new link.
      if (gatewayDown(response.status)) {
        throw new ApiError(
          'server_down',
          'Sunucu şu an kapalı, uyuyor ya da adresi değişmiş. Sunucuyu açan kankana haber ver: açıksa yeni bağlantıyı ondan iste, kapalıysa açılınca kendiliğinden düzelir.',
          response.status
        );
      }
      // nginx in front of a VPS turns a photo past its own limit (1 MB by
      // default) away before our server sees it: about the file, whoever says it
      if (response.status === 413) {
        throw new ApiError('too_large', 'Gönderdiğin dosya çok büyük, sunucu almadı.', 413);
      }
      throw new ApiError('not_koydum', 'Bu adreste KOYDUM sunucusu yok gibi. Adresi kontrol et.', response.status);
    }

    if (!response.ok) {
      const code = envelope?.error?.code ?? `http_${response.status}`;
      const message = envelope?.error?.message ?? 'Bir şeyler ters gitti.';
      const error = new ApiError(code, message, response.status, envelope?.error?.issues);
      if (response.status === 401) this.onUnauthorized?.(error);
      throw error;
    }

    // A 200 page in place of our JSON is a captive portal or a router answering
    // for the address. Handed back as null, it counted a parked entry as sent
    // and a login as a wrong password. Status 0 parks it like no signal.
    if (!json) {
      throw new ApiError(
        'not_koydum',
        'Bu adreste KOYDUM sunucusu yok gibi. Wi-Fi giriş sayfası olabilir, adresi kontrol et.',
        0
      );
    }

    return payload as T;
  }

  /* ------------------------------------------------------------- health */

  health() {
    return this.request<HealthResponse>('GET', '/health');
  }

  /** Who owns an invite code — public fields only, no token needed. */
  invite(code: string) {
    return this.request<InviteLookup>('GET', `/invites/${encodeURIComponent(code)}`);
  }

  /* --------------------------------------------------------------- auth */

  register(body: { username: string; password: string; displayName: string; timezone: string; vulgarityMax?: number }) {
    return this.request<AuthResponse>('POST', '/auth/register', { body });
  }

  login(body: { username: string; password: string }) {
    return this.request<AuthResponse>('POST', '/auth/login', { body });
  }

  /** A fresh 90 days for the token this client holds (services/session.ts). */
  refreshToken() {
    return this.request<{ token: string }>('POST', '/auth/refresh');
  }

  /** The address proves it holds our token's secret (services/serverMove.ts). No token is sent. */
  prove(body: ProveBody) {
    return this.request<ProveResponse>('POST', '/auth/prove', { body });
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
    nudgesEnabled?: boolean;
    recapEnabled?: boolean;
  }) {
    return this.request<Me>('PATCH', '/me', { body });
  }

  deleteMe() {
    return this.request<{ ok: true }>('DELETE', '/me');
  }

  /**
   * A wrong current password is a 400 `wrong_password`, so it never logs out.
   * `pushToken` is the one this phone registered (null: none), so the server
   * keeps it and drops one held by a phone the change signs out.
   */
  changePassword(body: { currentPassword: string; newPassword: string; pushToken?: string | null }) {
    return this.request<AuthResponse>('POST', '/me/password', { body });
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

  /** Android only in practice: the phone's own daily screen minutes. */
  syncScreenTime(days: { dayKey: string; minutes: number }[]) {
    return this.request<{ updated: number }>('POST', '/me/screen-time', { body: { days } });
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

  /** `removed` is false when there was no block of mine to lift (it is idempotent). */
  unblockUser(id: string) {
    return this.request<{ status: 'none'; userId: string; removed: boolean }>('POST', `/users/${id}/unblock`);
  }

  /** The people I blocked, newest first; never the ones who blocked me. */
  blockedUsers() {
    return this.request<PublicUser[]>('GET', '/users/blocked');
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

  /** `invitable`: my running çelınclar the new kanka could still join (older servers leave it out). */
  acceptFriend(friendshipId: string) {
    return this.request<FriendAcceptResult>('POST', `/friends/${friendshipId}/accept`);
  }

  declineFriend(friendshipId: string) {
    return this.request<{ ok: true }>('POST', `/friends/${friendshipId}/decline`);
  }

  /** Ends a friendship, or takes back my own request while it is still unanswered. */
  removeFriend(userId: string) {
    return this.request<{ status: 'removed' | 'withdrawn'; userId: string }>('DELETE', `/friends/${userId}`);
  }

  /**
   * "Geri çek": takes back my own unanswered request and nothing else. Accepted
   * while the confirm was open, it stays a friendship (409 `already_friends`).
   */
  withdrawFriendRequest(userId: string) {
    return this.request<{ status: 'withdrawn'; userId: string }>('DELETE', `/friends/${userId}`, {
      query: { only: 'request' },
    });
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

  /** A page of a çelınc's entries, newest first, older than `before` when given. */
  challengeFeed(id: string, query: { before?: string; beforeId?: string; userId?: string; limit?: number } = {}) {
    return this.request<FeedPage>('GET', `/challenges/${id}/feed`, { query });
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

  /** A player bringing friends into a çelınc already under way; answers with the fresh detail. */
  inviteToChallenge(id: string, userIds: string[]) {
    return this.request<ChallengeDetail>('POST', `/challenges/${id}/invite`, { body: { userIds } });
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

  /**
   * `answerBy` is set once the itirazlar are a majority (the owner's clock
   * started) and null below it, when the server calls the other players to it.
   */
  disputeEntry(challengeId: string, entryId: string, reason: string) {
    return this.request<{
      entry: Entry;
      answerBy?: string | null;
      /** how many other players were called to it; missing from older servers */
      othersCalled?: number;
      standings: ParticipantView[];
    }>(
      'POST',
      `/challenges/${challengeId}/entries/${entryId}/dispute`,
      { body: { reason } }
    );
  }

  /** Takes the caller's own open itiraz back; the entry is clean again once nobody else disputes it. */
  withdrawDispute(challengeId: string, entryId: string) {
    return this.request<{ entry: Entry; standings: ParticipantView[] }>(
      'DELETE',
      `/challenges/${challengeId}/entries/${entryId}/dispute`
    );
  }

  /** The owner's answer to an itiraz: an uploaded photo (`uploadPhoto`) that closes it. */
  addEntryProof(challengeId: string, entryId: string, proofUrl: string) {
    return this.request<{ entry: Entry; standings: ParticipantView[] }>(
      'POST',
      `/challenges/${challengeId}/entries/${entryId}/proof`,
      { body: { proofUrl } }
    );
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
    return this.request<{ url: string }>('POST', '/uploads', { formData: form, timeoutMs: UPLOAD_TIMEOUT_MS });
  }
}

/** Convenience wrapper used outside React (background tasks). */
export function createClient(baseUrl: string, token: string | null): ApiClient {
  return new ApiClient({ baseUrl, token });
}
