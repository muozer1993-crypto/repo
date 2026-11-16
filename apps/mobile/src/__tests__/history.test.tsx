import type { ChallengeStatus, ChallengeSummary, ParticipantStatus, ParticipantView } from '@koydum/shared';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ChallengeCard } from '@/components/ChallengeCard';
import { liveRivalry, outcomeOf } from '@/utils/history';

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

/**
 * Ali's çelınc `id`, Ali in it and first; Veli is in it as `veli`, second when
 * he plays and at rank 0 (as the server lists him) when he does not.
 */
function withVeli(id: string, status: ChallengeStatus, veli: ParticipantStatus): ChallengeSummary {
  const base = tiedAtTop('ali');
  const me = player('ali', 'Ali', 5, 1);
  const him = { ...player('veli', 'Veli', veli === 'accepted' ? 3 : 0, veli === 'accepted' ? 2 : 0), status: veli };
  return {
    ...base,
    challenge: { ...base.challenge, id, title: id, status, finalizedAt: null, isTie: false },
    participants: [me, him],
    me,
  };
}

describe('liveRivalry', () => {
  it('tells a çelınc Veli was only asked to as not joined yet', () => {
    const rivalry = liveRivalry([withVeli('adim', 'active', 'invited')], 'ali', 'veli');
    expect(rivalry?.summary.challenge.id).toBe('adim');
    expect(rivalry?.joined).toBe(false);
  });

  it('knows nothing of one he left or said no to', () => {
    expect(liveRivalry([withVeli('adim', 'active', 'left')], 'ali', 'veli')).toBeNull();
    expect(liveRivalry([withVeli('adim', 'pending', 'declined')], 'ali', 'veli')).toBeNull();
  });

  it('knows nothing of one I am only asked to myself', () => {
    const summary = withVeli('adim', 'active', 'accepted');
    const mine = { ...summary.participants[0]!, status: 'invited' as const, rank: 0 };
    expect(liveRivalry([{ ...summary, participants: [mine, summary.participants[1]!], me: mine }], 'ali', 'veli')).toBeNull();
  });

  it('picks the one we are both in over an invite he is sitting on', () => {
    const rivalry = liveRivalry(
      [withVeli('davet', 'active', 'invited'), withVeli('ortak', 'active', 'accepted')],
      'ali',
      'veli'
    );
    expect(rivalry?.summary.challenge.id).toBe('ortak');
    expect(rivalry?.joined).toBe(true);
  });

  it('takes a shared one still waiting to start over a running invite, and the running invite only without it', () => {
    const shared = withVeli('ortak', 'pending', 'accepted');
    const invite = withVeli('davet', 'active', 'invited');
    expect(liveRivalry([invite, shared], 'ali', 'veli')).toEqual({ summary: shared, joined: true });
    expect(liveRivalry([withVeli('bekleyen', 'pending', 'invited'), invite], 'ali', 'veli')).toEqual({
      summary: invite,
      joined: false,
    });
  });

  it('puts a shared one under way before one of ours still waiting to start', () => {
    const rivalry = liveRivalry(
      [withVeli('yakinda', 'pending', 'accepted'), withVeli('suruyor', 'active', 'accepted')],
      'ali',
      'veli'
    );
    expect(rivalry?.summary.challenge.id).toBe('suruyor');
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

describe('ChallengeCard on a finished win or loss', () => {
  /** Ali kept all 7 days, Veli 5: Ali won outright. */
  function decided(meId: string): ChallengeSummary {
    const base = tiedAtTop('ali');
    const participants = [player('ali', 'Ali', 7, 1), player('veli', 'Veli', 5, 2)];
    return {
      ...base,
      challenge: { ...base.challenge, isTie: false, winnerId: 'ali' },
      participants,
      me: participants.find((p) => p.user.id === meId) ?? null,
    };
  }

  function cardText(meId: string, level: 1 | 2 | 3): string {
    let tree: ReactTestRenderer;
    act(() => {
      tree = create(<ChallengeCard summary={decided(meId)} level={level} meId={meId} />);
    });
    return textIn(tree!.toJSON()).join(' ');
  }

  it('says KAZANDIN and KAYBETTİN to a "Nazik" reader, as the result screen does', () => {
    const won = cardText('ali', 1);
    expect(won).toContain('KAZANDIN');
    expect(won).not.toContain('KOYDUN');
    const lost = cardText('veli', 1);
    expect(lost).toContain('KAYBETTİN');
    expect(lost).not.toContain('YEDİN');
  });

  it('keeps KOYDUN and YEDİN from level 2 up', () => {
    for (const level of [2, 3] as const) {
      expect(cardText('ali', level)).toContain('KOYDUN');
      expect(cardText('veli', level)).toContain('YEDİN');
    }
  });
});

/**
 * Ali's step race, 9.000 to Veli's 6.000, still `active`: the phones' settle
 * hour or an itiraz's proof window holds it open past `endsAt`.
 */
function stepRace(endsAt: string, meId: string): ChallengeSummary {
  const base = tiedAtTop('ali');
  const participants = [player('ali', 'Ali', 9000, 1), player('veli', 'Veli', 6000, 2)];
  return {
    ...base,
    challenge: {
      ...base.challenge,
      typeKey: 'adim_yarisi',
      metricType: 'auto_steps',
      unit: 'adım',
      title: 'Adım Yarışı',
      endsAt,
      status: 'active',
      finalizedAt: null,
      isTie: false,
      penaltyText: null,
    },
    participants,
    me: participants.find((p) => p.user.id === meId) ?? null,
  };
}

describe('ChallengeCard after the end while the result waits', () => {
  function cardText(summary: ChallengeSummary, meId: string, level: 1 | 2 | 3): string {
    let tree: ReactTestRenderer;
    act(() => {
      tree = create(<ChallengeCard summary={summary} level={level} meId={meId} />);
    });
    const text = textIn(tree!.toJSON()).join(' ');
    // the countdown keeps ticking otherwise, past the end of the test
    act(() => tree.unmount());
    return text;
  }

  const endedAt = () => new Date(Date.now() - 5 * 60_000).toISOString();

  it('stops nagging the one behind, but still says where he stands', () => {
    const text = cardText(stepRace(endedAt(), 'veli'), 'veli', 3);
    expect(text).toContain('⏳ Sonuç bekleniyor');
    expect(text).toContain('GERİDESİN');
    expect(text).not.toContain('Geridesin');
    expect(text).not.toContain('yersin');
  });

  it('stops cheering the one ahead, but still says where she stands', () => {
    const text = cardText(stepRace(endedAt(), 'ali'), 'ali', 1);
    expect(text).toContain('⏳ Sonuç bekleniyor');
    expect(text).toContain('ÖNDESİN');
    expect(text).not.toContain('Öndesin');
    expect(text).not.toContain('Böyle devam');
  });

  it('keeps the line while the race still runs', () => {
    const endsAt = new Date(Date.now() + 60 * 60_000).toISOString();
    expect(cardText(stepRace(endsAt, 'veli'), 'veli', 3)).toContain('Geridesin. Kalk yoksa akşam yersin');
    expect(cardText(stepRace(endsAt, 'ali'), 'ali', 1)).toContain('Öndesin, aferin. Böyle devam.');
  });

  it('drops it when the end passes with the card on screen', () => {
    const now = new Date('2026-09-10T20:59:59.000Z').getTime();
    jest.useFakeTimers({ now });
    try {
      let tree: ReactTestRenderer;
      act(() => {
        tree = create(<ChallengeCard summary={stepRace(new Date(now + 1000).toISOString(), 'veli')} level={3} meId="veli" />);
      });
      expect(textIn(tree!.toJSON()).join(' ')).toContain('Geridesin. Kalk yoksa akşam yersin');

      act(() => {
        jest.advanceTimersByTime(1500);
      });
      const text = textIn(tree!.toJSON()).join(' ');
      expect(text).toContain('⏳ Sonuç bekleniyor');
      expect(text).toContain('GERİDESİN');
      expect(text).not.toContain('Geridesin');
      act(() => tree.unmount());
    } finally {
      jest.useRealTimers();
    }
  });
});
