import type { ChallengeType, EntryStatus, TauntContext } from './types';

// ---------------------------------------------------------------------------
// Validation constants (shared by schemas.ts, the server and the app)
// ---------------------------------------------------------------------------

export const LIMITS = {
  USERNAME_MIN: 3,
  USERNAME_MAX: 20,
  PASSWORD_MIN: 6,
  PASSWORD_MAX: 72,
  DISPLAY_NAME_MAX: 30,
  /** Avatar length in user-perceived characters (grapheme clusters), see `countGraphemes`. */
  AVATAR_EMOJI_MAX: 4,
  /** Abuse guard in UTF-16 code units — a heavy ZWJ family emoji is ~20 units. */
  AVATAR_EMOJI_MAX_UNITS: 64,
  CHALLENGE_TITLE_MAX: 40,
  REWARD_TEXT_MAX: 80,
  PENALTY_TEXT_MAX: 80,
  NOTE_MAX: 120,
  PROOF_URL_MAX: 500,
  DISPUTE_REASON_MAX: 140,
  REPORT_REASON_MAX: 300,
  CUSTOM_TAUNT_MAX: 140,
  PARTICIPANTS_MIN: 1,
  PARTICIPANTS_MAX: 15,
  STEPS_SYNC_DAYS_MAX: 14,
  STEPS_PER_DAY_MAX: 100_000,
  /** startsAt may be at most this far in the past when creating a challenge. */
  START_GRACE_MS: 5 * 60 * 1000,
  MIN_DURATION_MS: 60 * 60 * 1000,
  MAX_DURATION_DAYS: 60,
  MAX_DURATION_MS: 60 * 24 * 60 * 60 * 1000,
  /** Manual entries may be backfilled this many days; steps this many. */
  MANUAL_BACKFILL_DAYS: 2,
  STEPS_BACKFILL_DAYS: 7,
  FOCUS_MIN_MINUTES: 1,
  FOCUS_MAX_MINUTES: 180,
  POKE_COOLDOWN_MS: 2 * 60 * 60 * 1000,
  /** Accepting an invite is allowed while now < endsAt - this. */
  ACCEPT_CUTOFF_MS: 60 * 60 * 1000,
  REMATCH_START_DELAY_MS: 5 * 60 * 1000,
  INBOX_PAGE_DEFAULT: 30,
  INBOX_PAGE_MAX: 100,
  UPLOAD_MAX_BYTES: 5 * 1024 * 1024,
} as const;

// ---------------------------------------------------------------------------
// Scoring (SPEC 1.3)
// ---------------------------------------------------------------------------

export interface ScoreEntry {
  dayKey: string;
  value: number;
  status: EntryStatus;
}

export interface ScoreInput {
  userId: string;
  entries: ScoreEntry[];
}

export interface ScoreResult {
  userId: string;
  score: number;
  days: number;
  rank: number;
  isWinner: boolean;
}

export interface RankingResult {
  /** Sorted best-first (rank asc, then days desc, then userId asc). */
  results: ScoreResult[];
  winnerId: string | null;
  isTie: boolean;
}

export type WinMargin = 'big' | 'close' | 'normal';

const SCORE_PRECISION = 1000;

/** Round to 3 decimals so float sums (0.1 + 0.2) compare equal for ties. */
function roundScore(n: number): number {
  return Math.round(n * SCORE_PRECISION) / SCORE_PRECISION;
}

function isCountedEntry(e: ScoreEntry): boolean {
  // SPEC 1.3: `ok` and `disputed` (dispute pending) entries count; `rejected` never
  // counts. Disputing alone must not zero out a rival — only an upheld dispute does.
  return e.status !== 'rejected' && Number.isFinite(e.value);
}

/**
 * Pure, deterministic score for one participant.
 *
 * - `dayKeys` is the challenge's day window (see `dayKeysBetween`). It is used only
 *   for the missing-day penalty of `manual_lower_is_better`; entries are NOT filtered
 *   by it — the server validates day keys at write time. Because the window is
 *   computed once per challenge while day keys are validated per user timezone, an
 *   entry may legitimately sit on a boundary day outside `dayKeys`: its value still
 *   counts, but it never cancels the penalty of an unreported in-window day.
 * - `days` = number of distinct day keys with a counted entry.
 * - Boolean types (`checkin_deadline`, `daily_boolean`) score the number of distinct
 *   days with a positive value, so duplicate rows for one day cannot double count.
 * - Sum types (`auto_steps`, `focus_minutes`, `manual_count`) score the plain sum.
 * - `manual_lower_is_better` scores sum + missingDays × penalty, where penalty is
 *   `type.missingDayPenalty` (falls back to `type.maxPerDay` — an unreported day is
 *   treated as the worst case so not reporting never wins).
 */
export function computeScore(
  type: ChallengeType,
  dayKeys: string[],
  entries: ScoreInput['entries'],
): { score: number; days: number } {
  const counted = entries.filter(isCountedEntry);
  const dayValues = new Map<string, number[]>();
  for (const e of counted) {
    const list = dayValues.get(e.dayKey);
    if (list) list.push(e.value);
    else dayValues.set(e.dayKey, [e.value]);
  }
  const days = dayValues.size;

  switch (type.metricType) {
    case 'checkin_deadline':
    case 'daily_boolean': {
      let hits = 0;
      for (const values of dayValues.values()) {
        if (values.some((v) => v > 0)) hits += 1;
      }
      return { score: hits, days };
    }
    case 'manual_lower_is_better': {
      let sum = 0;
      for (const e of counted) sum += e.value;
      const penalty = type.missingDayPenalty ?? type.maxPerDay;
      let missingDays = 0;
      for (const key of new Set(dayKeys)) {
        if (!dayValues.has(key)) missingDays += 1;
      }
      return { score: roundScore(sum + missingDays * penalty), days };
    }
    case 'auto_steps':
    case 'focus_minutes':
    case 'manual_count':
    default: {
      let sum = 0;
      for (const e of counted) sum += e.value;
      return { score: roundScore(sum), days };
    }
  }
}

function compareScores(direction: ChallengeType['direction'], a: number, b: number): number {
  return direction === 'lower' ? a - b : b - a;
}

/**
 * Rank every participant. Rank 1 is shared on equal score (competition ranking:
 * 1, 1, 3). When the top score is shared by two or more participants the challenge
 * is a tie: `winnerId` is null and nobody is `isWinner`.
 */
export function rankParticipants(type: ChallengeType, dayKeys: string[], inputs: ScoreInput[]): RankingResult {
  const scored = inputs.map((input) => {
    const { score, days } = computeScore(type, dayKeys, input.entries);
    return { userId: input.userId, score, days };
  });

  scored.sort((a, b) => {
    const byScore = compareScores(type.direction, a.score, b.score);
    if (byScore !== 0) return byScore;
    if (a.days !== b.days) return b.days - a.days;
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });

  if (scored.length === 0) return { results: [], winnerId: null, isTie: false };

  const topScore = scored[0]!.score;
  const isTie = scored.filter((s) => s.score === topScore).length >= 2;

  const results: ScoreResult[] = [];
  let rank = 1;
  for (let i = 0; i < scored.length; i++) {
    const s = scored[i]!;
    if (i > 0 && s.score !== scored[i - 1]!.score) rank = i + 1;
    results.push({ userId: s.userId, score: s.score, days: s.days, rank, isWinner: !isTie && rank === 1 });
  }

  return { results, winnerId: isTie ? null : results[0]!.userId, isTie };
}

/**
 * How decisively the winner won (SPEC 1.3).
 * - `big`: winner ≥ 2× loser (or loser at 0 while winner > 0).
 * - `close`: difference ≤ 10% of the winner's score.
 * - `normal`: everything else.
 *
 * For `direction === 'lower'` the comparison is mirrored, because there the LOSER holds
 * the larger number and the literal rule could never produce `big`: big if
 * loser ≥ 2× winner (or winner 0 and loser > 0); close if the difference ≤ 10% of the
 * loser's score. Every caller must use this function rather than re-deriving the rule.
 *
 * Scores are compared at the same 3-decimal precision `computeScore` produces, so an
 * exact 10% margin on decimal scores (7 vs 6.3) is `close` and not a float accident.
 */
export function winMargin(type: Pick<ChallengeType, 'direction'>, winnerScore: number, loserScore: number): WinMargin {
  const hi = roundScore(type.direction === 'lower' ? loserScore : winnerScore);
  const lo = roundScore(type.direction === 'lower' ? winnerScore : loserScore);
  if (hi > 0 && (lo <= 0 || hi >= roundScore(2 * lo))) return 'big';
  if (hi <= 0 || roundScore(hi - lo) <= roundScore(0.1 * hi)) return 'close';
  return 'normal';
}

/** Taunt context matching a win margin (`tie` is handled by the caller). */
export function tauntContextForMargin(margin: WinMargin): TauntContext {
  if (margin === 'big') return 'win_big';
  if (margin === 'close') return 'win_close';
  return 'win';
}

// ---------------------------------------------------------------------------
// Formatting (tr-TR) — engine independent so Hermes and Node agree
// ---------------------------------------------------------------------------

/**
 * Format a number the Turkish way: `12430` → `12.430`, `1234.5` → `1.234,5`.
 * At most `maxFractionDigits` decimals (default 2), trailing zeros trimmed.
 */
export function formatNumberTr(n: number, maxFractionDigits = 2): string {
  if (!Number.isFinite(n)) return '0';
  const negative = n < 0;
  const abs = Math.abs(n);
  const fixed = abs.toFixed(Math.max(0, Math.min(20, maxFractionDigits)));
  const [intPartRaw, fracRaw = ''] = fixed.split('.');
  const intPart = (intPartRaw ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const frac = fracRaw.replace(/0+$/, '');
  const out = frac.length > 0 ? `${intPart},${frac}` : intPart;
  return negative && out !== '0' ? `-${out}` : out;
}

/** `scoreLabel(steps, 12430)` → `"12.430 adım"`. */
export function scoreLabel(type: Pick<ChallengeType, 'unitTr'>, score: number): string {
  const num = formatNumberTr(score);
  const unit = type.unitTr.trim();
  return unit ? `${num} ${unit}` : num;
}
