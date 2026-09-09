/**
 * UI copy and badges.
 *
 * Every string comes in three vulgarity levels; `t()` picks the one matching
 * the reader's setting, so the same screen reads differently for the friend
 * who wants "nazik" and the one who wants "ağır abi".
 */
import type { BadgeDef, BadgeStatKey, BadgeStats, MicrocopyEntry, MicrocopyKey, VulgarityLevel } from './types';

export const MICROCOPY: Record<MicrocopyKey, MicrocopyEntry> = {
  "home_empty": { level1: "Henüz çelınc yok. Bir arkadaşını davet et, ilk yarışı başlat.", level2: "Ortalık bomboş lan. Kimseye koymadın, kimse sana koymadı. Bir çelınc aç.", level3: "Burası çöl gibi. Ne koyan var ne yiyen. Aç bir çelınc, birine sapla 🍆" },
  "create_challenge_cta": { level1: "Çelınc Başlat", level2: "Çelınc Aç Lan", level3: "Koymaya Başla 🍆" },
  "invite_friends_cta": { level1: "Arkadaş Davet Et", level2: "Kankaları Çağır", level3: "Kurban Getir" },
  "challenge_pending_you": { level1: "Bu çelınc seni bekliyor. Kabul et, yarış başlasın.", level2: "Sana meydan okundu lan. Kabul et ya da korkak ol.", level3: "Biri sana koymak istiyor. Kabul et, kim kime koyacak görelim 🍆" },
  "challenge_active_leading": { level1: "Öndesin! Böyle devam, farkı koru.", level2: "Öndesin lan, koyuyorsun. Gevşeme, akşam bildirim atacağız.", level3: "Saplıyorsun 🍆 Sakın durma, sonuna kadar götür." },
  "challenge_active_losing": { level1: "Biraz gerideyiz. Küçük bir gayretle toparlanır.", level2: "Geridesin lan. Böyle giderse yiyeceksin, kalk hareket et.", level3: "Yemeye doğru gidiyorsun. Kalk yoksa akşam sapır sapır 🍆" },
  "challenge_finished_won": { level1: "Tebrikler, kazandın! Arkadaşına nazik bir mesaj gönderebilirsin.", level2: "Koydun lan! Şimdi kaybedene bir bildirim yolla, tadını çıkar.", level3: "SAPLADIN 🍆 Kaybeden şu an kıvranıyor. Bildirimi seç, hesabı kapat." },
  "challenge_finished_lost": { level1: "Bu sefer olmadı. Rövanş isteyebilirsin.", level2: "Yedin kanka. Şimdi bildirim gelecek, dişini sık.", level3: "Yedin. Sapır sapır 🍆 Bildirim yolda, kabullen ve rövanş iste." },
  "shame_screen_title": { level1: "Bu tur senin değil", level2: "REZİL OLDUN", level3: "SAPLANDIN 🍆" },
  "shame_screen_subtitle": { level1: "Kazanan sana küçük bir not bıraktı.", level2: "Kazanan sana bir laf soktu. Oku ve ders al.", level3: "Yediğin resmi olarak tescillendi. Kazananın mesajı aşağıda." },
  "taunt_picker_title": { level1: "Bir mesaj seç", level2: "Hangi lafı sokalım?", level3: "Nasıl saplayalım? 🍆" },
  "taunt_sent_confirmation": { level1: "Mesajın gönderildi.", level2: "Laf sokuldu, bildirim gitti.", level3: "Saplandı. Şu an telefonu titriyor 🍆" },
  "poke_button": { level1: "Dürt", level2: "Kalk Yürü Lan", level3: "Dürt, Sıkı Dursun" },
  "rematch_button": { level1: "Rövanş İste", level2: "Rövanş Lan", level3: "Geri Koyacağım" },
  "add_friend_empty": { level1: "Henüz arkadaş yok. Kullanıcı adıyla ekle.", level2: "Kankan yok mu lan? Kullanıcı adını yaz, ekle.", level3: "Kurban listesi boş. Birini ekle, sonra sapla 🍆" },
  "focus_start": { level1: "Odak seansını başlat. Uygulamadan çıkarsan seans biter.", level2: "Odak seansı başlıyor. Çıkarsan seans yanar, sen de yanarsın.", level3: "Telefonu bırak lan. Çıkarsan seans gider, sonra da sen yersin 🍆" },
  "focus_abandoned": { level1: "Seans yarıda kaldı. Bir daha dene.", level2: "Kaçtın lan. Seans yandı, ekran seni yendi.", level3: "Dayanamadın. Seans gitti, telefon sana koydu 🍆" },
  "focus_done": { level1: "Seans tamamlandı, harika!", level2: "Seans bitti. Telefona koydun lan, aferin.", level3: "Bitirdin. Telefona sapladın, bu sefer o yedi 🍆" },
  "checkin_late": { level1: "Bugünün check-in saati geçti. Yarın erken davran.", level2: "Geç kaldın lan. Bugün sayılmadı, yarın erken kalk.", level3: "Uyudun kaldın, gün gitti. Yarın erken kalk yoksa saplanırsın 🍆" },
  "checkin_ok": { level1: "Check-in alındı. Güne erken başladın!", level2: "Check-in tamam. Erken kalktın, koydun.", level3: "Kalktın, tescillendi. Hâlâ uyuyanlara sapladın 🍆" },
  "proof_needed": { level1: "Bu giriş için bir fotoğraf kanıtı ekleyebilirsin.", level2: "Kanıt yok mu lan? Fotoğraf at, yoksa kimse inanmaz.", level3: "Fotoğraf yoksa palavra. Kanıt ekle, itiraz yeme." },
  "dispute_button": { level1: "İtiraz Et", level2: "Yalan Lan, İtiraz", level3: "Palavra, İtiraz" },
  "profile_record": { level1: "Kişisel rekor", level2: "En iyi koyuş", level3: "Rekor saplama 🍆" },
  "onboarding_1": { level1: "Arkadaşlarınla çelınc aç: adım, odak, erken kalkma, su, sayfa.", level2: "Kankalarla çelınc aç lan: adım at, telefonu bırak, erken kalk.", level3: "Kankalarla çelınc aç. Adım, odak, erken kalkma. Kim kime koyacak? 🍆" },
  "onboarding_2": { level1: "Skorlar otomatik veya beyanla sayılır. Arkadaşlar itiraz edebilir.", level2: "Skorlar sayılır. Yalan atarsan kankalar itiraz eder, rezil olursun.", level3: "Herkesin skoru sayılır. Yalan atan itiraz yer, itiraz yiyen saplanır." },
  "onboarding_3": { level1: "Kazanan ödülü alır ve kaybedene nazik bir mesaj gönderir.", level2: "Kazanan 'KOYDUM MU?' der, kaybedene bildirim gider. Yedin, rezil oldun.", level3: "Kazanan 'KOYDUM MU?' der, kaybedenin telefonuna 🍆 iner. Hazır mısın?" },
  "notification_daily_reminder": { level1: "Bugünkü çelıncını unutma. Küçük bir adım bile sayılır.", level2: "Bugün ne yaptın lan? Skor sıfır, kalk bir şeyler yap.", level3: "Skor sıfır. Kankalar bakıyor. Kalk yoksa akşam sapır sapır 🍆" },
  "login_title": { level1: "Tekrar hoş geldin", level2: "Gel bakalım", level3: "Kim geldi lan?" },
  "register_title": { level1: "Aramıza katıl", level2: "Kayıt ol, koymaya başla", level3: "Kayıt ol: kurban ol ya da sapla 🍆" },
  "settings_vulgarity_label": { level1: "Adamlık seviyesi: Nazik", level2: "Adamlık seviyesi: Delikanlı", level3: "Adamlık seviyesi: Ağır Abi" },
  "logout_confirm": { level1: "Çıkış yapmak istediğine emin misin?", level2: "Kaçıyor musun lan? Çıkış yapmak istediğine emin misin?", level3: "Kaçıyorsun ha? Çıkarsan kankalar 'yedi kaçtı' diyecek. Emin misin?" },
};

/** Reads a copy string at the given level. */
export function t(key: MicrocopyKey, level: VulgarityLevel): string {
  const entry = MICROCOPY[key];
  if (!entry) return '';
  if (level === 1) return entry.level1;
  if (level === 3) return entry.level3;
  return entry.level2;
}

export const BADGES: readonly BadgeDef[] = [
  { key: "first_blood", nameTr: "İlk Koyuş", emoji: "🍆", descriptionTr: "İlk çelıncını kazandın. Kaybeden ilk bildirimini aldı.", rule: "wins>=1" },
  { key: "serial_winner", nameTr: "Seri Koyucu", emoji: "🔥", descriptionTr: "5 çelınc kazandın. Grup artık seninle çelınc açmadan önce iki kere düşünüyor.", rule: "wins>=5" },
  { key: "agir_abi", nameTr: "Ağır Abi", emoji: "👑", descriptionTr: "20 çelınc kazandın. Grup senin, koltuk senin, laf hakkı senin.", rule: "wins>=20" },
  { key: "first_bite", nameTr: "İlk Lokma", emoji: "🍽️", descriptionTr: "İlk çelıncını kaybettin. Herkes bir yerden başlar, sen yiyerek başladın.", rule: "losses>=1" },
  { key: "open_buffet", nameTr: "Açık Büfe", emoji: "🥄", descriptionTr: "10 çelınc kaybettin. Yemeye doyamadın, tabağın hiç boş kalmadı.", rule: "losses>=10" },
  { key: "loudmouth", nameTr: "Laf Sokucu", emoji: "🗣️", descriptionTr: "10 bildirim gönderdin. Ağzından bal damlıyor, hem de acı biberli.", rule: "tauntsSent>=10" },
  { key: "thick_skin", nameTr: "Kalın Deri", emoji: "🛡️", descriptionTr: "10 bildirim yedin ve hâlâ buradasın. Saygı duyuyoruz.", rule: "tauntsReceived>=10" },
  { key: "walker", nameTr: "Yürüyen Efsane", emoji: "🚶", descriptionTr: "Tek günde 15.000 adım. Kaz gibi değil, at gibi yürüdün.", rule: "stepsSingleDayMax>=15000" },
  { key: "no_legs_left", nameTr: "Ayak Yok Artık", emoji: "🏃", descriptionTr: "Tek günde 25.000 adım. Telefonun bile yoruldu, sen yorulmadın.", rule: "stepsSingleDayMax>=25000" },
  { key: "marathoner", nameTr: "Evi Yok mu Bunun?", emoji: "🏅", descriptionTr: "Tek günde 40.000 adım. Nereye gidiyorsun, evin yok mu senin?", rule: "stepsSingleDayMax>=40000" },
  { key: "focus_beast", nameTr: "Odak Canavarı", emoji: "🧘", descriptionTr: "Toplam 300 dakika odak seansı. Telefon sana koyamadı, sen ona koydun.", rule: "focusTotalMinutes>=300" },
  { key: "mountain_monk", nameTr: "Dağ Keşişi", emoji: "🏔️", descriptionTr: "Toplam 1000 dakika odak. Telefon seni aradı, sen açmadın.", rule: "focusTotalMinutes>=1000" },
  { key: "rooster", nameTr: "Horoz", emoji: "🐓", descriptionTr: "7 gün üst üste zamanında check-in. Güneşten önce kalktın, herkes hâlâ uyuyordu.", rule: "checkinsStreakMax>=7" },
  { key: "dawn_guard", nameTr: "Şafak Nöbetçisi", emoji: "🌅", descriptionTr: "30 gün üst üste zamanında check-in. Horoz artık saati senden soruyor.", rule: "checkinsStreakMax>=30" },
  { key: "lie_detector", nameTr: "Yalan Dedektörü", emoji: "🕵️", descriptionTr: "3 itiraz kazandın. Sana kimse palavra sıkamıyor.", rule: "disputesWon>=3" },
  { key: "revenge_master", nameTr: "Rövanş Ustası", emoji: "🔁", descriptionTr: "3 rövanş kazandın. Yediğini iade etmeyi biliyorsun, hem de faiziyle.", rule: "revengeWins>=3" },
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

export function getBadge(key: string): BadgeDef | undefined {
  return BADGES.find((badge) => badge.key === key);
}
