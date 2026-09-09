/**
 * UI copy and badges.
 *
 * Every string comes in three vulgarity levels; `t()` picks the one matching
 * the reader's setting, so the same screen reads differently for the friend
 * who wants "nazik" and the one who wants "ağır abi".
 */
import {
  BADGE_FAMILIES,
  type BadgeDef,
  type BadgeStatKey,
  type BadgeStats,
  type MicrocopyEntry,
  type MicrocopyKey,
  type VulgarityLevel,
} from './types';

export const MICROCOPY: Record<MicrocopyKey, MicrocopyEntry> = {
  "home_empty": { level1: "Henüz çelınc yok", level2: "Ortalık boş", level3: "Kimse kimseye koymuyor" },
  "create_challenge_cta": { level1: "Çelınc Başlat", level2: "Çelınc Aç", level3: "Koymaya Başla" },
  "invite_friends_cta": { level1: "Arkadaş Davet Et", level2: "Kankaları Çağır", level3: "Kurban Getir" },
  "challenge_pending_you": { level1: "Bu çelınc seni bekliyor. Kabul edersen başlar.", level2: "Sana çelınc geldi. Kabul et bakalım.", level3: "Biri sana koymak istiyor. Kabul et de görelim." },
  "challenge_active_leading": { level1: "Öndesin. Böyle devam et.", level2: "Öndesin lan. Sakın gevşeme.", level3: "Şu an sen koyuyorsun. Gevşersen adam geri alır." },
  "challenge_active_losing": { level1: "Biraz gerideysin. Küçük bir gayret yeter.", level2: "Geridesin. Böyle giderse yiyeceksin.", level3: "Geridesin. Kalk yoksa akşam yersin 🍆" },
  "challenge_finished_won": { level1: "Kazandın, tebrikler. İstersen arkadaşına bir mesaj gönder.", level2: "Koydun lan. Kaybedene bir laf gönder.", level3: "SAPLADIN. Bildirimi seç, gitsin." },
  "challenge_finished_lost": { level1: "Bu sefer olmadı. Rövanş isteyebilirsin.", level2: "Yedin. Birazdan bildirim gelecek.", level3: "Yedin işte. Bildirim yolda, aç da oku." },
  "shame_screen_title": { level1: "Bu tur senin değil", level2: "YEDİN", level3: "SAPLANDIN 🍆" },
  "shame_screen_subtitle": { level1: "Kazanan sana bir not bıraktı.", level2: "Kazanan sana laf soktu, aşağıda.", level3: "Kazanan sana koydu. Mesajı aşağıda." },
  "taunt_picker_title": { level1: "Bir mesaj seç", level2: "Hangi lafı sokalım?", level3: "Nasıl saplayalım?" },
  "taunt_sent_confirmation": { level1: "Mesajın gönderildi.", level2: "Laf gitti.", level3: "Gitti. Şu an okuyor 🍆" },
  "poke_button": { level1: "Dürt", level2: "Dürt Bakalım", level3: "Dürt Şunu" },
  "rematch_button": { level1: "Rövanş İste", level2: "Rövanş İstiyorum", level3: "Geri Koyacağım" },
  "add_friend_empty": { level1: "Henüz arkadaşın yok. Kullanıcı adıyla ekleyebilirsin.", level2: "Liste boş. Kullanıcı adını yaz, ekle.", level3: "Kurban listesi boş. Birini ekle de başlayalım." },
  "focus_start": { level1: "Odak seansı başlıyor. Uygulamadan çıkarsan seans biter.", level2: "Odak başlıyor. Çıkarsan seans yanar.", level3: "Telefonu bırak lan. Çıkarsan seans gider." },
  "focus_abandoned": { level1: "Seans yarıda kaldı. Yeniden deneyebilirsin.", level2: "Kaçtın. Seans yandı.", level3: "Dayanamadın. Telefon sana koydu." },
  "focus_done": { level1: "Seans tamamlandı. Güzel iş.", level2: "Seans bitti. Telefona koydun.", level3: "Bitirdin. Bu sefer telefon yedi." },
  "checkin_late": { level1: "Bugünün check-in saati geçti. Yarın deneriz.", level2: "Geç kaldın, bugün sayılmadı.", level3: "Uyuyakaldın, gün gitti lan." },
  "checkin_ok": { level1: "Check-in alındı. Erken kalkmışsın.", level2: "Check-in tamam. Erken kalktın, koydun.", level3: "Kalktın demek. Check-in yazıldı 🍆" },
  "proof_needed": { level1: "Bu giriş için fotoğraf gerekiyor.", level2: "Fotoğraf lazım. Yoksa kimse inanmaz.", level3: "Fotoğrafı at lan, palavraya kimse inanmıyor." },
  "dispute_button": { level1: "İtiraz Et", level2: "Yalan Bu", level3: "Palavra Bu" },
  "profile_record": { level1: "Kişisel rekor", level2: "En iyi koyuş", level3: "Rekor saplama 🍆" },
  "onboarding_1": { level1: "Arkadaşlarınla çelınc aç: adım, odak, erken kalkma, su.", level2: "Kankalarla çelınc aç. Adım at, telefonu bırak, erken kalk.", level3: "Kankalarla çelınc aç. Bakalım kim kime koyacak." },
  "onboarding_2": { level1: "Skorlar otomatik ya da beyanla sayılır. Arkadaşların itiraz edebilir.", level2: "Skorlar sayılır. Yalan atarsan kankalar itiraz eder.", level3: "Her skor sayılır. Sayıyı şişirirsen itiraz yersin." },
  "onboarding_3": { level1: "Kazanan ödülü alır, kaybedene bir mesaj gider.", level2: "Kazanan 'KOYDUM MU?' der, kaybedenin telefonu öter.", level3: "Kazanan 'KOYDUM MU?' der, kaybedenin telefonuna 🍆 iner." },
  "notification_daily_reminder": { level1: "Bugünkü çelıncı unutma.", level2: "Bugün skorun sıfır. Kalk bir şeyler yap.", level3: "Skorun sıfır lan. Kankalar bakıyor." },
  "login_title": { level1: "Tekrar hoş geldin", level2: "Gel bakalım", level3: "Kim geldi lan?" },
  "register_title": { level1: "Aramıza katıl", level2: "Kayıt ol, başlayalım", level3: "Kayıt ol, kurbanını seç" },
  "settings_vulgarity_label": { level1: "Adamlık seviyesi: Nazik", level2: "Adamlık seviyesi: Delikanlı", level3: "Adamlık seviyesi: Ağır Abi" },
  "logout_confirm": { level1: "Çıkış yapmak istediğine emin misin?", level2: "Çıkış yapıyorsun. Emin misin?", level3: "Çıkarsan 'yedi kaçtı' derler. Emin misin?" },
};

/** Reads a copy string at the given level. */
export function t(key: MicrocopyKey, level: VulgarityLevel): string {
  const entry = MICROCOPY[key];
  if (!entry) return '';
  if (level === 1) return entry.level1;
  if (level === 3) return entry.level3;
  return entry.level2;
}

/**
 * The badge ladders.
 *
 * Names are the point: nobody screenshots "Achievement Unlocked: 5 Wins", but
 * people do send each other "Saplama Mühendisi". Each family climbs, and the
 * profile only ever shows the rungs you have plus the next one — see
 * `badgeLadder`.
 */
export const BADGES: readonly BadgeDef[] = [
  // koyuş — the whole point of the app
  { key: "koyus_1", family: "koyus", tier: 1, nameTr: "Çırak Saplamacı", emoji: "🍆", descriptionTr: "İlk çelıncını kazandın.", rule: "wins>=1" },
  { key: "koyus_2", family: "koyus", tier: 2, nameTr: "Saplamacı", emoji: "🔥", descriptionTr: "5 çelınc kazandın.", rule: "wins>=5" },
  { key: "koyus_3", family: "koyus", tier: 3, nameTr: "Usta Saplamacı", emoji: "👑", descriptionTr: "20 çelınc kazandın. Grupta sözün geçiyor.", rule: "wins>=20" },
  { key: "koyus_4", family: "koyus", tier: 4, nameTr: "Saplama Mühendisi", emoji: "🎓", descriptionTr: "50 çelınc kazandın. Bu iş artık meslek.", rule: "wins>=50" },

  // yiyiş — losing is content too
  { key: "yiyis_1", family: "yiyis", tier: 1, nameTr: "Ağzının Tadını Aldın", emoji: "🍽️", descriptionTr: "İlk çelıncını kaybettin.", rule: "losses>=1" },
  { key: "yiyis_2", family: "yiyis", tier: 2, nameTr: "Açık Büfe", emoji: "🥄", descriptionTr: "10 çelınc kaybettin. Tabağın hiç boş kalmıyor.", rule: "losses>=10" },
  { key: "yiyis_3", family: "yiyis", tier: 3, nameTr: "Abone Oldun", emoji: "🧾", descriptionTr: "30 çelınc kaybettin. Artık aidat gibi ödüyorsun.", rule: "losses>=30" },

  // adım
  { key: "adim_1", family: "adim", tier: 1, nameTr: "Yürüyen Adam", emoji: "🚶", descriptionTr: "Tek günde 15.000 adım attın.", rule: "stepsSingleDayMax>=15000" },
  { key: "adim_2", family: "adim", tier: 2, nameTr: "Ayakkabı Katili", emoji: "👟", descriptionTr: "Tek günde 25.000 adım. Ayakkabı dayanmıyor.", rule: "stepsSingleDayMax>=25000" },
  { key: "adim_3", family: "adim", tier: 3, nameTr: "Evi Yok Bunun", emoji: "🏅", descriptionTr: "Tek günde 40.000 adım. Nereye gidiyorsun sen?", rule: "stepsSingleDayMax>=40000" },

  // odak
  { key: "odak_1", family: "odak", tier: 1, nameTr: "Telefonu Bıraktın", emoji: "🧘", descriptionTr: "Toplam 300 dakika odaklandın.", rule: "focusTotalMinutes>=300" },
  { key: "odak_2", family: "odak", tier: 2, nameTr: "Dağ Keşişi", emoji: "🏔️", descriptionTr: "Toplam 1.000 dakika odaklandın. Bildirimler seni bekliyor.", rule: "focusTotalMinutes>=1000" },
  { key: "odak_3", family: "odak", tier: 3, nameTr: "Aradı, Açmadın", emoji: "📵", descriptionTr: "Toplam 3.000 dakika odaklandın. Telefon sana küstü.", rule: "focusTotalMinutes>=3000" },

  // erken kalkma
  { key: "erken_1", family: "erken", tier: 1, nameTr: "Horoz", emoji: "🐓", descriptionTr: "7 gün üst üste zamanında kalktın.", rule: "checkinsStreakMax>=7" },
  { key: "erken_2", family: "erken", tier: 2, nameTr: "Horozdan Erken", emoji: "🌅", descriptionTr: "30 gün üst üste erken kalktın.", rule: "checkinsStreakMax>=30" },
  { key: "erken_3", family: "erken", tier: 3, nameTr: "Güneşi Sen Kaldırıyorsun", emoji: "☀️", descriptionTr: "100 gün üst üste erken kalktın.", rule: "checkinsStreakMax>=100" },

  // itiraz
  { key: "itiraz_1", family: "itiraz", tier: 1, nameTr: "Yalan Dedektörü", emoji: "🕵️", descriptionTr: "3 itiraz kazandın.", rule: "disputesWon>=3" },
  { key: "itiraz_2", family: "itiraz", tier: 2, nameTr: "Savcı", emoji: "⚖️", descriptionTr: "10 itiraz kazandın. Yanında kimse sayı şişiremiyor.", rule: "disputesWon>=10" },

  // rövanş
  { key: "rovans_1", family: "rovans", tier: 1, nameTr: "Faiziyle Aldı", emoji: "🔁", descriptionTr: "3 rövanş kazandın. Yediğini geri veriyorsun.", rule: "revengeWins>=3" },
  { key: "rovans_2", family: "rovans", tier: 2, nameTr: "Unutmayan Adam", emoji: "🐘", descriptionTr: "10 rövanş kazandın.", rule: "revengeWins>=10" },
] as const;

const RULE = /^([a-zA-Z_]+)\s*(>=|<=|==|>|<)\s*(-?\d+(?:\.\d+)?)$/;

/** Evaluates one clause of a badge rule, e.g. "wins>=5". */
function evaluateClause(clause: string, stats: BadgeStats): boolean {
  const match = RULE.exec(clause.trim());
  if (!match) return false;
  const [, key, op, rawValue] = match;
  const actual = stats[key as BadgeStatKey];
  if (typeof actual !== 'number') return false;
  const expected = Number(rawValue);
  switch (op) {
    case '>=':
      return actual >= expected;
    case '>':
      return actual > expected;
    case '<=':
      return actual <= expected;
    case '<':
      return actual < expected;
    case '==':
      return actual === expected;
    default:
      return false;
  }
}

/** Rules are clauses joined by "&&". An unparseable rule never awards a badge. */
export function badgeEarned(badge: BadgeDef, stats: BadgeStats): boolean {
  const clauses = badge.rule.split('&&').filter((clause) => clause.trim().length > 0);
  if (clauses.length === 0) return false;
  return clauses.every((clause) => evaluateClause(clause, stats));
}

export function evaluateBadges(stats: BadgeStats): string[] {
  return BADGES.filter((badge) => badgeEarned(badge, stats)).map((badge) => badge.key);
}

/** The single stat a rung is measured on, e.g. "wins>=5" → "wins". */
export function badgeStatKey(badge: BadgeDef): BadgeStatKey | null {
  const match = RULE.exec(badge.rule.split('&&')[0].trim());
  return match ? (match[1] as BadgeStatKey) : null;
}

/** The number a rung asks for, e.g. "wins>=5" → 5. */
export function badgeTarget(badge: BadgeDef): number {
  const match = RULE.exec(badge.rule.split('&&')[0].trim());
  return match ? Number(match[3]) : 0;
}

export interface BadgeRung {
  badge: BadgeDef;
  earned: boolean;
  /** the lowest rung of this family still unclimbed — the one worth chasing */
  next: boolean;
  /** 0..1 towards `target` */
  progress: number;
  current: number;
  target: number;
}

/**
 * What the profile shows: every rung already earned, plus exactly one locked
 * rung per family — the next one.
 *
 * Showing all 22 at once tells a new user "here are twenty things you have not
 * done". Showing the next one tells them what to do tonight, and the rung
 * after that only exists once they have earned the right to see it.
 */
export function badgeLadder(stats: BadgeStats, earnedKeys?: readonly string[]): BadgeRung[] {
  const earned = earnedKeys
    ? new Set(earnedKeys)
    : new Set(BADGES.filter((badge) => badgeEarned(badge, stats)).map((badge) => badge.key));

  const rungs: BadgeRung[] = [];
  for (const family of BADGE_FAMILIES) {
    const ladderOfFamily = BADGES.filter((badge) => badge.family === family).sort(
      (a, b) => a.tier - b.tier
    );
    let nextTaken = false;
    for (const badge of ladderOfFamily) {
      const has = earned.has(badge.key);
      if (!has && nextTaken) break; // everything above the next rung stays hidden
      const key = badgeStatKey(badge);
      const target = badgeTarget(badge);
      const current = key && typeof stats[key] === 'number' ? stats[key] : 0;
      rungs.push({
        badge,
        earned: has,
        next: !has,
        progress: target > 0 ? Math.max(0, Math.min(1, current / target)) : has ? 1 : 0,
        current,
        target,
      });
      if (!has) nextTaken = true;
    }
  }
  return rungs;
}

/** How high someone has climbed on one ladder (0 = not started). */
export function badgeLevel(family: BadgeDef['family'], earnedKeys: readonly string[]): number {
  const earned = new Set(earnedKeys);
  return BADGES.filter((badge) => badge.family === family && earned.has(badge.key)).reduce(
    (top, badge) => Math.max(top, badge.tier),
    0
  );
}

export function getBadge(key: string): BadgeDef | undefined {
  return BADGES.find((badge) => badge.key === key);
}
