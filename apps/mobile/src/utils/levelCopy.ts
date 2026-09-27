import type { ParticipantView, VulgarityLevel } from '@koydum/shared';

/**
 * Copy that has no MICROCOPY key but still has to speak in all three registers.
 *
 * A "Nazik" user must never be handed level-3 wording (and the other way
 * round), so anything written inline goes through `byLevel` — and anything two
 * screens share (the taunt CTA, the rematch button) lives here so the label the
 * home card shows is the label the results screen shows.
 */
export function byLevel(level: VulgarityLevel, l1: string, l2: string, l3: string): string {
  if (level === 1) return l1;
  if (level === 3) return l3;
  return l2;
}

/** The button that opens the taunt picker (home card + results row). */
export const TAUNT_CTA: Record<VulgarityLevel, string> = {
  1: 'Mesaj Gönder',
  2: 'KOYDUM MU?',
  3: 'KOYDUM MU? 🍆',
};

/** Icons are part of the register too: level 1 gets none. */
export const TAUNT_CTA_ICON: Record<VulgarityLevel, string | undefined> = {
  1: '✉️',
  2: '🍆',
  3: '🍆',
};

/** "send one to everybody who lost" */
export const TAUNT_ALL: Record<VulgarityLevel, string> = {
  1: 'Hepsine gönder',
  2: 'HEPSİNE KOY',
  3: 'HEPSİNE KOY 🍆',
};

export const TAUNT_ALL_ICON: Record<VulgarityLevel, string | undefined> = {
  1: '✉️',
  2: '🍆',
  3: '🍆',
};

/** Chip on a loser who already got their taunt. */
export const TAUNT_DONE_CHIP: Record<VulgarityLevel, string> = {
  1: 'GÖNDERİLDİ',
  2: 'KOYDUN',
  3: 'KOYDUN 🍆',
};

/** Line under the loser list once every one of them has been taunted. */
export const TAUNT_ALL_DONE: Record<VulgarityLevel, string> = {
  1: 'Hepsine mesajını gönderdin ✅',
  2: 'Hepsine koydun ✅',
  3: 'Hepsine sapladın ✅🍆',
};

/**
 * `t('rematch_button', level)` is written for the loser ("Geri Koyacağım"),
 * which reads wrong on the winner's screen — they have nothing to take back.
 */
export const REMATCH_WINNER: Record<VulgarityLevel, string> = {
  1: 'Bir tur daha',
  2: 'Bir daha koyalım',
  3: 'Bir daha saplayalım 🍆',
};

/**
 * Whether saying no (or leaving) would leave nobody to race. The server then
 * cancels the çelınc on the spot (`cancelIfAbandoned`): fewer than two people
 * left who are in or could still say yes.
 */
export function endsWithoutMe(participants: Pick<ParticipantView, 'user' | 'status'>[], meId: string | null): boolean {
  const others = participants.filter(
    (p) => p.user.id !== meId && (p.status === 'accepted' || p.status === 'invited')
  );
  return others.length < 2;
}

/**
 * The question before a no to a çelınc invite (home card and the çelınc
 * screen), so a thumb that slipped does not throw it away. A declined invite
 * can be taken back from the çelınc screen, which Gelen still opens, unless
 * the no ends the çelınc (`endsWithoutMe`): then there is nothing to come back
 * to, and the question says that instead.
 */
export function declineQuestion(level: VulgarityLevel, endsIt: boolean): { title: string; body: string } {
  const title = byLevel(level, 'Daveti reddediyor musun?', 'Pas mı geçiyorsun?', 'Tırstın mı? 🐔');
  if (endsIt) {
    return {
      title,
      body: byLevel(
        level,
        'Başka rakip olmadığı için reddedersen çelınc iptal olur. Açan kişiye de haber gider.',
        'Tek rakip sensin, reddedersen çelınc yatar. Açana da haber gider.',
        'Tek rakip sensin, reddedersen çelınc yatar. Açan da tırstığını öğrenir 🐔'
      ),
    };
  }
  return {
    title,
    body: byLevel(
      level,
      "Reddedersen çelınc listenden kalkar, açan kişiye de haber gider. Fikrin değişirse Gelen'deki davetten çelınca girip yine katılabilirsin.",
      "Reddedersen listenden düşer, açana da haber gider. Fikrin değişirse Gelen'deki davetten girip yine katılırsın.",
      "Reddedersen listenden düşer, açan da tırstığını öğrenir 🐔 Fikrin değişirse Gelen'deki davetten girip yine katılırsın."
    ),
  };
}

/**
 * Toast once the session followed the server to its new address (the invite
 * screen and Ayarlar both do it), so the two say the same thing.
 */
export const SERVER_MOVED: Record<VulgarityLevel, string> = {
  1: 'Adres güncellendi, hesabın yerinde.',
  2: 'Tamamdır, yeni adrese geçtik. Hesabın yerinde.',
  3: 'Taşındık lan. Hesap da çelınclar da yerinde.',
};

/**
 * The app promises "nobody can talk to you above your level". That is true for
 * the ready-made templates (the server clamps them) but NOT for a friend's own
 * sentence, which only passes the banned-word filter. Say so wherever the
 * promise is made.
 */
export const CUSTOM_TAUNT_CEILING_NOTE =
  'Hazır laflar karşıdakinin seviyesini aşmaz. Kendi yazdığın cümle sadece yasaklı kelime filtresinden geçer, yazdığın gibi gider.';
