import { describe, expect, it } from 'vitest';
import type { ChallengeType } from '../types';
import {
  computeScore,
  formatNumberTr,
  rankParticipants,
  scoreLabel,
  tauntContextForMargin,
  winMargin,
  type ScoreInput,
} from '../scoring';

function makeType(overrides: Partial<ChallengeType> = {}): ChallengeType {
  return {
    key: 'steps',
    nameTr: 'Adım',
    emoji: '🚶',
    metricType: 'auto_steps',
    unitTr: 'adım',
    direction: 'higher',
    descriptionTr: '',
    descriptionPoliteTr: '',
    howMeasuredTr: '',
    defaultDurationDays: 7,
    suggestedRewardTr: '',
    antiCheatTr: '',
    proofRequired: false,
    category: 'hareket',
    maxPerEntry: 100000,
    maxPerDay: 100000,
    ...overrides,
  };
}

const DAYS = ['2024-05-01', '2024-05-02', '2024-05-03'];

describe('computeScore', () => {
  it('sums ok entries and counts distinct days for sum types', () => {
    const r = computeScore(makeType(), DAYS, [
      { dayKey: '2024-05-01', value: 1000, status: 'ok' },
      { dayKey: '2024-05-02', value: 2500, status: 'ok' },
    ]);
    expect(r).toEqual({ score: 3500, days: 2 });
  });

  it('excludes rejected entries but includes disputed ones', () => {
    const r = computeScore(makeType({ metricType: 'manual_count' }), DAYS, [
      { dayKey: '2024-05-01', value: 5, status: 'ok' },
      { dayKey: '2024-05-01', value: 3, status: 'disputed' },
      { dayKey: '2024-05-02', value: 100, status: 'rejected' },
    ]);
    expect(r).toEqual({ score: 8, days: 1 });
  });

  it('boolean types count distinct days with a positive value', () => {
    const r = computeScore(makeType({ metricType: 'daily_boolean' }), DAYS, [
      { dayKey: '2024-05-01', value: 1, status: 'ok' },
      { dayKey: '2024-05-01', value: 1, status: 'ok' }, // duplicate must not double count
      { dayKey: '2024-05-02', value: 0, status: 'ok' },
      { dayKey: '2024-05-03', value: 1, status: 'ok' },
    ]);
    expect(r).toEqual({ score: 2, days: 3 });
  });

  it('checkin_deadline counts 1s', () => {
    const r = computeScore(makeType({ metricType: 'checkin_deadline' }), DAYS, [
      { dayKey: '2024-05-01', value: 1, status: 'ok' },
      { dayKey: '2024-05-02', value: 0, status: 'ok' },
    ]);
    expect(r).toEqual({ score: 1, days: 2 });
  });

  it('lower-is-better adds the missing-day penalty', () => {
    const type = makeType({ metricType: 'manual_lower_is_better', direction: 'lower', missingDayPenalty: 8 });
    const r = computeScore(type, DAYS, [{ dayKey: '2024-05-01', value: 2, status: 'ok' }]);
    expect(r).toEqual({ score: 2 + 2 * 8, days: 1 });
  });

  it('lower-is-better falls back to maxPerDay when no penalty is configured', () => {
    const type = makeType({ metricType: 'manual_lower_is_better', direction: 'lower', maxPerDay: 24 });
    const r = computeScore(type, DAYS, []);
    expect(r).toEqual({ score: 72, days: 0 });
  });

  it('counts an out-of-window entry in the sum but never as a reported window day', () => {
    const type = makeType({ metricType: 'manual_lower_is_better', direction: 'lower', missingDayPenalty: 8 });
    // Timezone boundary: the 05-02 entry is outside a 1-day window. Its value counts, but it
    // must not cancel the penalty for 05-01, which was never reported.
    expect(computeScore(type, ['2024-05-01'], [{ dayKey: '2024-05-02', value: 1, status: 'ok' }])).toEqual({ score: 1 + 8, days: 1 });
    // Window day reported + boundary entry: no penalty, and no negative missing-day count.
    expect(
      computeScore(type, ['2024-05-01'], [
        { dayKey: '2024-05-01', value: 1, status: 'ok' },
        { dayKey: '2024-05-02', value: 1, status: 'ok' },
      ]),
    ).toEqual({ score: 2, days: 2 });
  });

  it('a participant who reported nothing inside the window pays the full penalty', () => {
    const type = makeType({ metricType: 'manual_lower_is_better', direction: 'lower', missingDayPenalty: 8 });
    const entry = (dayKey: string) => ({ dayKey, value: 1, status: 'ok' as const });
    const outsideOnly = ['2024-04-28', '2024-04-29', '2024-04-30'].map(entry);
    expect(computeScore(type, DAYS, outsideOnly)).toEqual({ score: 3 + 3 * 8, days: 3 });
    expect(computeScore(type, DAYS, DAYS.map(entry))).toEqual({ score: 3, days: 3 });
    const r = rankParticipants(type, DAYS, [
      { userId: 'ghost', entries: outsideOnly },
      { userId: 'honest', entries: DAYS.map(entry) },
    ]);
    expect(r.winnerId).toBe('honest');
  });

  it('duplicate day keys in the window do not double the penalty', () => {
    const type = makeType({ metricType: 'manual_lower_is_better', direction: 'lower', missingDayPenalty: 8 });
    expect(computeScore(type, ['2024-05-01', '2024-05-01'], [])).toEqual({ score: 8, days: 0 });
  });

  it('rounds float sums so ties compare equal', () => {
    const r = computeScore(makeType({ metricType: 'manual_count' }), DAYS, [
      { dayKey: '2024-05-01', value: 0.1, status: 'ok' },
      { dayKey: '2024-05-01', value: 0.2, status: 'ok' },
    ]);
    expect(r.score).toBe(0.3);
  });
});

describe('rankParticipants', () => {
  const inputs = (pairs: [string, number][]): ScoreInput[] =>
    pairs.map(([userId, value]) => ({ userId, entries: [{ dayKey: '2024-05-01', value, status: 'ok' }] }));

  it('ranks higher-is-better descending and picks a single winner', () => {
    const r = rankParticipants(makeType(), DAYS, inputs([['a', 100], ['b', 300], ['c', 200]]));
    expect(r.results.map((x) => [x.userId, x.rank, x.isWinner])).toEqual([
      ['b', 1, true],
      ['c', 2, false],
      ['a', 3, false],
    ]);
    expect(r.winnerId).toBe('b');
    expect(r.isTie).toBe(false);
  });

  it('ranks lower-is-better ascending with the missing-day penalty applied', () => {
    const type = makeType({ metricType: 'manual_lower_is_better', direction: 'lower', missingDayPenalty: 8 });
    const r = rankParticipants(type, DAYS, [
      {
        userId: 'reporter',
        entries: [
          { dayKey: '2024-05-01', value: 2, status: 'ok' },
          { dayKey: '2024-05-02', value: 3, status: 'ok' },
          { dayKey: '2024-05-03', value: 4, status: 'ok' },
        ],
      },
      { userId: 'slacker', entries: [{ dayKey: '2024-05-01', value: 1, status: 'ok' }] },
    ]);
    expect(r.results[0]).toMatchObject({ userId: 'reporter', score: 9, rank: 1, isWinner: true });
    expect(r.results[1]).toMatchObject({ userId: 'slacker', score: 17, rank: 2, isWinner: false });
    expect(r.winnerId).toBe('reporter');
  });

  it('shares rank 1 on a tie and returns winnerId null', () => {
    const r = rankParticipants(makeType(), DAYS, inputs([['a', 100], ['b', 100], ['c', 50]]));
    expect(r.isTie).toBe(true);
    expect(r.winnerId).toBeNull();
    expect(r.results.map((x) => [x.userId, x.rank, x.isWinner])).toEqual([
      ['a', 1, false],
      ['b', 1, false],
      ['c', 3, false],
    ]);
  });

  it('a tie below the top does not affect the winner', () => {
    const r = rankParticipants(makeType(), DAYS, inputs([['a', 100], ['b', 100], ['c', 500]]));
    expect(r.isTie).toBe(false);
    expect(r.winnerId).toBe('c');
    expect(r.results.map((x) => x.rank)).toEqual([1, 2, 2]);
  });

  it('everyone at zero is a tie', () => {
    const r = rankParticipants(makeType(), DAYS, [
      { userId: 'a', entries: [] },
      { userId: 'b', entries: [] },
    ]);
    expect(r).toMatchObject({ winnerId: null, isTie: true });
  });

  it('rejected entries are excluded and disputed ones included', () => {
    const r = rankParticipants(makeType({ metricType: 'manual_count' }), DAYS, [
      { userId: 'cheater', entries: [{ dayKey: '2024-05-01', value: 999, status: 'rejected' }] },
      { userId: 'pending', entries: [{ dayKey: '2024-05-01', value: 4, status: 'disputed' }] },
      { userId: 'honest', entries: [{ dayKey: '2024-05-01', value: 3, status: 'ok' }] },
    ]);
    expect(r.winnerId).toBe('pending');
    expect(r.results.map((x) => [x.userId, x.score])).toEqual([
      ['pending', 4],
      ['honest', 3],
      ['cheater', 0],
    ]);
  });

  it('handles empty input', () => {
    expect(rankParticipants(makeType(), DAYS, [])).toEqual({ results: [], winnerId: null, isTie: false });
  });

  it('is deterministic for equal score and days (userId order)', () => {
    const a = rankParticipants(makeType(), DAYS, inputs([['z', 5], ['m', 5], ['a', 5]]));
    const b = rankParticipants(makeType(), DAYS, inputs([['a', 5], ['z', 5], ['m', 5]]));
    expect(a.results.map((x) => x.userId)).toEqual(['a', 'm', 'z']);
    expect(b.results.map((x) => x.userId)).toEqual(['a', 'm', 'z']);
  });
});

describe('winMargin', () => {
  const higher = makeType();
  const lower = makeType({ direction: 'lower' });

  it('big when winner >= 2x loser', () => {
    expect(winMargin(higher, 100, 50)).toBe('big');
    expect(winMargin(higher, 100, 49)).toBe('big');
  });

  it('big when loser is 0 and winner > 0', () => {
    expect(winMargin(higher, 1, 0)).toBe('big');
  });

  it('close when difference <= 10% of winner', () => {
    expect(winMargin(higher, 100, 90)).toBe('close');
    expect(winMargin(higher, 100, 95)).toBe('close');
  });

  it('normal otherwise', () => {
    expect(winMargin(higher, 100, 89)).toBe('normal');
    expect(winMargin(higher, 100, 51)).toBe('normal');
  });

  it('treats an exact 10% margin on decimal scores as close (no float accidents)', () => {
    expect(winMargin(higher, 7, 6.3)).toBe('close'); // 7 - 6.3 = 0.7000000000000002 in IEEE-754
    expect(winMargin(higher, 2.1, 1.89)).toBe('close');
    expect(winMargin(higher, 0.3, 0.27)).toBe('close');
    expect(winMargin(higher, 7, 6.29)).toBe('normal');
    expect(winMargin(lower, 6.3, 7)).toBe('close');
    expect(winMargin(higher, 0.6, 0.3)).toBe('big');
  });

  it('never reports big for 0 vs 0', () => {
    expect(winMargin(higher, 0, 0)).toBe('close');
  });

  it('mirrors the thresholds for lower-is-better', () => {
    expect(winMargin(lower, 1, 2)).toBe('big');
    expect(winMargin(lower, 0, 3)).toBe('big');
    expect(winMargin(lower, 9.5, 10)).toBe('close');
    expect(winMargin(lower, 7, 10)).toBe('normal');
  });

  it('maps to taunt contexts', () => {
    expect(tauntContextForMargin('big')).toBe('win_big');
    expect(tauntContextForMargin('close')).toBe('win_close');
    expect(tauntContextForMargin('normal')).toBe('win');
  });
});

describe('formatting', () => {
  it('formats numbers tr-TR style', () => {
    expect(formatNumberTr(12430)).toBe('12.430');
    expect(formatNumberTr(1234.5)).toBe('1.234,5');
    expect(formatNumberTr(0.1 + 0.2)).toBe('0,3');
    expect(formatNumberTr(-1500.25)).toBe('-1.500,25');
    expect(formatNumberTr(999)).toBe('999');
    expect(formatNumberTr(0)).toBe('0');
    expect(formatNumberTr(Number.NaN)).toBe('0');
  });

  it('scoreLabel appends the unit', () => {
    expect(scoreLabel(makeType(), 12430)).toBe('12.430 adım');
    expect(scoreLabel(makeType({ unitTr: '' }), 5)).toBe('5');
  });
});
