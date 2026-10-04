import type { VulgarityLevel } from '@koydum/shared';

import { byLevel } from '@/utils/levelCopy';
import { isLocalNetworkUrl, isLoopbackUrl } from '@/utils/url';

/** By rank, not by place: a tie hands out two 🥇, on the podium and in the shared text alike. */
export const MEDALS = ['🥇', '🥈', '🥉'];

export interface ResultShareInput {
  level: VulgarityLevel;
  title: string;
  typeEmoji: string;
  /** "7 Eylül – 10 Eylül", or '' when the dates would not parse */
  range: string;
  /** the players who raced, in finishing order, each score already written with its unit */
  ranked: { rank: number; name: string; score: string }[];
  isTie: boolean;
  winnerName: string | null;
  iWon: boolean;
  /** my invite link (hooks/useInviteLink), null before /me has the code */
  link: string | null;
}

/**
 * The message "Gruba at" hands to the share sheet: the podium as text plus my
 * invite link, so the friends in the WhatsApp group who are not on KOYDUM yet
 * get a way in. A screenshot carries the gloat but not the link.
 *
 * Only what the results screen already shows goes out (display names and
 * scores of the players who raced), and the verdict speaks at the sender's
 * level, since it is the sender's own message.
 */
export function resultShareText(input: ResultShareInput): string {
  const { level } = input;
  const lines = [
    input.range
      ? `${input.typeEmoji} ${input.title} bitti (${input.range})`
      : `${input.typeEmoji} ${input.title} bitti`,
    ...input.ranked.map((player) => `${placeOf(player.rank)} ${player.name} · ${player.score}`),
  ];

  const verdict = verdictLine(input);
  if (verdict) lines.push('', verdict);

  // a home-network or localhost link opens nowhere the group is, so it stays out
  // (Kankalar says why next to the invite code)
  const link = input.link;
  if (link && !isLoopbackUrl(link) && !isLocalNetworkUrl(link)) {
    lines.push(
      byLevel(
        level,
        `Sen de katılmak istersen: ${link}`,
        `Sıradakine sen de gel: ${link}`,
        `Sıradakine sen de gel, bakalım kim kime saplıyor 🍆 ${link}`
      )
    );
  }
  return lines.join('\n');
}

function placeOf(rank: number): string {
  const medal = rank >= 1 ? MEDALS[rank - 1] : undefined;
  return medal ?? `${rank}.`;
}

function verdictLine({ level, isTie, iWon, winnerName }: ResultShareInput): string | null {
  if (isTie) {
    return byLevel(
      level,
      'Berabere bitti.',
      'Berabere bitti, kimse koyamadı.',
      'Berabere bitti, ortada sahipsiz bir 🍆 kaldı.'
    );
  }
  if (iWon) return byLevel(level, 'Bu sefer kazanan benim.', 'Koydum, geçmiş olsun.', 'Sapladım, geçmiş olsun 🍆');
  if (!winnerName) return null;
  // only a player can share, so whoever is not the winner here lost with the rest
  return byLevel(
    level,
    `Kazanan ${winnerName}, tebrikler.`,
    `Bu sefer ${winnerName} koydu, yedik.`,
    `Bu sefer ${winnerName} sapladı, yedik 🍆`
  );
}
