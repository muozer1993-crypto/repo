import { describe, expect, it } from 'vitest';

import { BADGES, CHALLENGE_TYPES, MICROCOPY, MICROCOPY_KEYS, TAGLINE, TAUNTS } from '../index';
import { badgeEarned, evaluateBadges, t } from '../copy';
import { CATEGORY_LABELS_TR, getChallengeType, requireChallengeType } from '../catalog';
import { containsBanned } from '../banned';
import { pickTaunt, renderTaunt, resolveTauntForRecipient, tauntsFor } from '../taunts';
import type { BadgeStats, TauntContext, VulgarityLevel } from '../types';

const CONTEXTS: TauntContext[] = ['win', 'win_big', 'win_close', 'tie', 'poke', 'streak', 'revenge'];
const LEVELS: VulgarityLevel[] = [1, 2, 3];

const emptyStats: BadgeStats = {
  wins: 0,
  losses: 0,
  ties: 0,
  tauntsSent: 0,
  tauntsReceived: 0,
  stepsSingleDayMax: 0,
  focusTotalMinutes: 0,
  checkinsStreakMax: 0,
  disputesWon: 0,
  challengesPlayed: 0,
  pokesSent: 0,
};

describe('challenge catalog', () => {
  it('has enough types and unique snake_case keys', () => {
    expect(CHALLENGE_TYPES.length).toBeGreaterThanOrEqual(16);
    const keys = CHALLENGE_TYPES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('keeps direction consistent with the metric type', () => {
    for (const type of CHALLENGE_TYPES) {
      const expected = type.metricType === 'manual_lower_is_better' ? 'lower' : 'higher';
      expect({ key: type.key, direction: type.direction }).toEqual({ key: type.key, direction: expected });
    }
  });

  it('gives every check-in type a deadline and every lower-is-better type a penalty', () => {
    for (const type of CHALLENGE_TYPES) {
      if (type.metricType === 'checkin_deadline') {
        expect(type.defaultDeadlineTime).toMatch(/^\d{2}:\d{2}$/);
      }
      if (type.metricType === 'manual_lower_is_better') {
        expect(type.missingDayPenalty).toBeGreaterThan(0);
      }
    }
  });

  it('bounds every type with sane caps', () => {
    for (const type of CHALLENGE_TYPES) {
      expect(type.maxPerEntry).toBeGreaterThan(0);
      expect(type.maxPerDay).toBeGreaterThanOrEqual(type.maxPerEntry);
      expect(type.defaultDurationDays).toBeGreaterThanOrEqual(1);
      expect(type.defaultDurationDays).toBeLessThanOrEqual(60);
    }
  });

  it('labels every category it uses', () => {
    for (const type of CHALLENGE_TYPES) {
      expect(CATEGORY_LABELS_TR[type.category]).toBeTruthy();
    }
  });

  it('looks types up by key', () => {
    const first = CHALLENGE_TYPES[0];
    expect(getChallengeType(first.key)).toEqual(first);
    expect(getChallengeType('yok_boyle_bir_sey')).toBeUndefined();
    expect(() => requireChallengeType('yok_boyle_bir_sey')).toThrow();
  });
});

describe('taunts', () => {
  it('covers every context at every level', () => {
    for (const context of CONTEXTS) {
      for (const level of LEVELS) {
        expect(TAUNTS.filter((x) => x.context === context && x.level === level).length).toBeGreaterThan(0);
      }
    }
  });

  it('has unique ids and stays inside the notification size budget', () => {
    const ids = TAUNTS.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const taunt of TAUNTS) {
      expect(taunt.title.length).toBeLessThanOrEqual(30);
      expect(taunt.body.length).toBeLessThanOrEqual(160);
    }
  });

  it('only uses known placeholders', () => {
    const allowed = new Set([
      'winner', 'loser', 'metric', 'winnerScore', 'loserScore', 'diff', 'unit', 'challenge',
    ]);
    for (const taunt of TAUNTS) {
      for (const match of `${taunt.title} ${taunt.body}`.matchAll(/\{([a-zA-Z]+)\}/g)) {
        expect({ id: taunt.id, key: match[1], known: allowed.has(match[1]) }).toEqual({
          id: taunt.id,
          key: match[1],
          known: true,
        });
      }
    }
  });

  it('never ships banned content', () => {
    for (const taunt of TAUNTS) {
      expect({ id: taunt.id, banned: containsBanned(`${taunt.title} ${taunt.body}`) }).toEqual({
        id: taunt.id,
        banned: false,
      });
    }
  });

  it('renders every placeholder it is given', () => {
    const rendered = renderTaunt(
      { title: 'KOYDUM MU?', body: '{winner} sana {diff} {unit} fark attı. {loser} yedin.' },
      {
        winner: 'Mustafa',
        loser: 'Ali',
        metric: 'adım',
        winnerScore: '12.430',
        loserScore: '4.201',
        diff: '8.229',
        unit: 'adım',
        challenge: 'Adım Yarışı',
      }
    );
    expect(rendered.body).toBe('Mustafa sana 8.229 adım fark attı. Ali yedin.');
  });

  it('picks deterministically with a seed', () => {
    expect(pickTaunt('win', 3, 7).id).toBe(pickTaunt('win', 3, 7).id);
  });

  it('never returns a template above the recipient ceiling', () => {
    for (const level of LEVELS) {
      expect(tauntsFor('win', level).every((x) => x.level <= level)).toBe(true);
    }
    const harsh = TAUNTS.find((x) => x.level === 3 && x.context === 'win');
    const resolved = resolveTauntForRecipient(harsh?.id, 'win', 1, 3);
    expect(resolved.level).toBeLessThanOrEqual(1);
  });
});

describe('copy and badges', () => {
  it('defines all microcopy keys at three levels', () => {
    for (const key of MICROCOPY_KEYS) {
      const entry = MICROCOPY[key];
      expect(entry).toBeDefined();
      expect(entry.level1.length).toBeGreaterThan(0);
      expect(entry.level2.length).toBeGreaterThan(0);
      expect(entry.level3.length).toBeGreaterThan(0);
    }
    expect(t('home_empty', 1)).toBe(MICROCOPY.home_empty.level1);
    expect(t('home_empty', 3)).toBe(MICROCOPY.home_empty.level3);
    expect(TAGLINE.level2.length).toBeGreaterThan(0);
  });

  it('keeps polite copy free of the loud words', () => {
    for (const key of MICROCOPY_KEYS) {
      expect({ key, level1: MICROCOPY[key].level1 }).toEqual({
        key,
        level1: expect.not.stringMatching(/\b(lan|koydum|sapla|yedin)\b/i) as unknown as string,
      });
    }
  });

  it('awards no badge on an empty profile', () => {
    expect(evaluateBadges(emptyStats)).toEqual([]);
  });

  it('evaluates every badge rule against a known stat key', () => {
    const loaded: BadgeStats = {
      wins: 999,
      losses: 999,
      ties: 999,
      tauntsSent: 999,
      tauntsReceived: 999,
      stepsSingleDayMax: 999_999,
      focusTotalMinutes: 999_999,
      checkinsStreakMax: 999,
      disputesWon: 999,
      challengesPlayed: 999,
      pokesSent: 999,
    };
    for (const badge of BADGES) {
      expect({ key: badge.key, earned: badgeEarned(badge, loaded) }).toEqual({ key: badge.key, earned: true });
    }
    expect(evaluateBadges(loaded).length).toBe(BADGES.length);
  });

  it('only references stat keys that SPEC 1.5 defines', () => {
    const known = new Set(Object.keys(emptyStats));
    for (const badge of BADGES) {
      for (const clause of badge.rule.split('&&')) {
        const key = /^[a-zA-Z_]+/.exec(clause.trim())?.[0] ?? '';
        expect({ badge: badge.key, key, known: known.has(key) }).toEqual({ badge: badge.key, key, known: true });
      }
    }
  });

  it('revenge_master needs wins AND losses (no revengeWins stat exists in SPEC 1.5/1.7)', () => {
    expect(evaluateBadges({ ...emptyStats, wins: 3 })).not.toContain('revenge_master');
    expect(evaluateBadges({ ...emptyStats, losses: 3 })).not.toContain('revenge_master');
    expect(evaluateBadges({ ...emptyStats, wins: 3, losses: 3 })).toContain('revenge_master');
  });

  it('awards exactly the badges whose threshold is met', () => {
    const stats: BadgeStats = { ...emptyStats, wins: 5, tauntsSent: 10 };
    const earned = evaluateBadges(stats);
    expect(earned).toContain('first_blood');
    expect(earned).toContain('serial_winner');
    expect(earned).toContain('loudmouth');
    expect(earned).not.toContain('agir_abi');
  });
});
