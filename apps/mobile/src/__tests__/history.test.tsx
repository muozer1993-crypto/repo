import type { ChallengeSummary, ParticipantView } from '@koydum/shared';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ChallengeCard } from '@/components/ChallengeCard';
import { outcomeOf } from '@/utils/history';

/** Collects every string rendered anywhere in the tree. */
function textIn(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(textIn);
  if (node && typeof node === 'object' && 'children' in node) {
    return textIn((node as { children: unknown }).children);
  }
  return [];
}

function player(id: string, name: string, score: number, rank: number): ParticipantView {
  return {
    user: { id, username: name.toLowerCase(), displayName: name, avatarEmoji: '🔥', createdAt: '2026-09-01T00:00:00.000Z' },
    status: 'accepted',
    score,
    days: 7,
    rank,
    lastEntryAt: null,
    isWinner: false,
  };
}

/** Ali and Veli kept all 7 days of a check-off çelınc, Can 4; `meId` reads it. */
function tiedAtTop(meId: string): ChallengeSummary {
  const participants = [player('ali', 'Ali', 7, 1), player('veli', 'Veli', 7, 1), player('can', 'Can', 4, 3)];
  return {
    challenge: {
      id: 'c-1',
      creatorId: 'ali',
      typeKey: 'sosyal_medya_orucu',
      metricType: 'daily_boolean',
      direction: 'higher',
      unit: 'gün',
      title: 'Sosyal Medya Orucu',
      startsAt: '2026-09-07T00:00:00.000Z',
      endsAt: '2026-09-13T20:59:59.999Z',
      status: 'finished',
      rewardText: null,
      penaltyText: 'Kaybeden döner ısmarlar',
      deadlineTime: null,
      dailyTarget: null,
      proofRequired: false,
      createdAt: '2026-09-07T00:00:00.000Z',
      finalizedAt: '2026-09-13T21:00:00.000Z',
      winnerId: null,
      isTie: true,
      rematchOfId: null,
    },
    participants,
    me: participants.find((p) => p.user.id === meId) ?? null,
    unreadTaunts: 0,
  };
}

describe('outcomeOf', () => {
  it('files a shared first place under Berabere and the place behind it under Yediklerim', () => {
    expect(outcomeOf(tiedAtTop('ali'), 'ali')).toBe('tie');
    expect(outcomeOf(tiedAtTop('veli'), 'veli')).toBe('tie');
    expect(outcomeOf(tiedAtTop('can'), 'can')).toBe('lost');
  });

  it('files nothing for somebody who never played it', () => {
    const summary = tiedAtTop('can');
    const invited = { ...summary, me: { ...summary.me!, status: 'invited' as const, rank: 0 } };
    expect(outcomeOf(invited, 'can')).toBe('none');
  });
});

describe('ChallengeCard on a finished tie', () => {
  function cardText(meId: string): string {
    let tree: ReactTestRenderer;
    act(() => {
      tree = create(<ChallengeCard summary={tiedAtTop(meId)} level={2} meId={meId} />);
    });
    return textIn(tree!.toJSON()).join(' ');
  }

  it('says YEDİN to whoever finished behind it, as history files it', () => {
    const text = cardText('can');
    expect(text).toContain('YEDİN');
    expect(text).toContain('🏁 Bitti');
    expect(text).not.toContain('BERABERE');
    expect(text).not.toContain('🤝');
  });

  it('says BERABERE to the co-leaders', () => {
    const text = cardText('ali');
    expect(text).toContain('BERABERE');
    expect(text).toContain('🤝 Berabere');
    expect(text).not.toContain('YEDİN');
  });
});
