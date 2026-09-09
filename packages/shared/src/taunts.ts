/**
 * Taunt templates — the "KOYDUM MU?" payloads.
 *
 * Levels: 1 nazik, 2 delikanlı, 3 ağır abi ("adamlık seviyesi" in the UI). The
 * RECIPIENT's maximum level always
 * wins, so a level 3 sender writing to a level 1 friend gets a level 1
 * template (see `clampLevel` and the server's taunt route).
 */
import { clampLevel } from './levels';
import type { TauntContext, TauntTemplate, TauntVars, VulgarityLevel } from './types';

export const TAUNTS: readonly TauntTemplate[] = [
  { id: "l1_win_01", level: 1, context: "win", title: "Sonuç geldi", body: "{winner} kazandı. {winnerScore} - {loserScore} {unit}. Rövanş düğmesi hemen altta." },
  { id: "l1_win_02", level: 1, context: "win", title: "Bu tur ona gitti", body: "{challenge} bitti. {winner} {winnerScore} {unit} yaptı, sen {loserScore}. Arada {diff} {unit} var." },
  { id: "l1_win_03", level: 1, context: "win", title: "İyi denemeydi", body: "{winner} {metric} çelıncını {winnerScore} - {loserScore} kazandı. Bir dahakine bakarız." },
  { id: "l1_win_04", level: 1, context: "win", title: "Küçük bir hatırlatma", body: "{winner} {challenge} çelıncını kazandı. Sen {loserScore} {unit} yaptın, o {winnerScore}." },
  { id: "l1_win_05", level: 1, context: "win", title: "Kazanan {winner}", body: "{winner} {winnerScore} {unit}, sen {loserScore}. Fark {diff}." },
  { id: "l1_win_06", level: 1, context: "win", title: "Bu sefer {winner}", body: "{loser}, {winner} seni {diff} {unit} farkla geçti. Yarın tekrar dene." },
  { id: "l1_win_07", level: 1, context: "win", title: "Bitti", body: "{challenge} sona erdi. {winner} {winnerScore}, {loser} {loserScore}. Kazanana tebrikler." },
  { id: "l1_win_08", level: 1, context: "win", title: "Kazanan belli oldu", body: "{winner} {winnerScore} {unit}, {loser} {loserScore}. Bu sefer alkış ona." },
  { id: "l1_winbig_01", level: 1, context: "win_big", title: "Fark biraz açıldı", body: "{winner} {winnerScore}, sen {loserScore}. Aradaki {diff} {unit} tek başına bir çelınc olurdu." },
  { id: "l1_winbig_02", level: 1, context: "win_big", title: "Fark büyük", body: "{winner} {challenge} çelıncını {winnerScore} - {loserScore} kazandı." },
  { id: "l1_winbig_03", level: 1, context: "win_big", title: "Ayrı liglerdesiniz", body: "Sen {loserScore} {unit}, {winner} {winnerScore}. {metric} konusunda ondan bir iki tüyo alsan iyi olur." },
  { id: "l1_winbig_04", level: 1, context: "win_big", title: "Tribünden izledin", body: "{challenge} çelıncında {winner} {winnerScore} yaptı, sen {loserScore}." },
  { id: "l1_winclose_01", level: 1, context: "win_close", title: "Kıl payı", body: "{winner} seni sadece {diff} {unit} ile geçti. Bir dahakine senindir." },
  { id: "l1_winclose_02", level: 1, context: "win_close", title: "Fotofiniş", body: "{winnerScore} - {loserScore}. {winner} son metrelerde öne geçti." },
  { id: "l1_winclose_03", level: 1, context: "win_close", title: "Az kaldı {loser}", body: "{diff} {unit} fark var. {winner} zor kazandı." },
  { id: "l1_winclose_04", level: 1, context: "win_close", title: "Son anda", body: "{winner} son anda öne geçti: {winnerScore} - {loserScore}. Sen de iyiydin." },
  { id: "l1_tie_01", level: 1, context: "tie", title: "Berabere", body: "{winner} ve {loser} tam {winnerScore} {unit} ile eşit bitirdi. Kimsenin diyeceği bir şey yok." },
  { id: "l1_tie_02", level: 1, context: "tie", title: "Eşitlik", body: "{challenge} berabere bitti: {winnerScore} - {loserScore}. İsterseniz rövanş açın." },
  { id: "l1_poke_01", level: 1, context: "poke", title: "Küçük bir dürtme", body: "{winner} seni dürttü. {challenge} devam ediyor, sen {loserScore} {unit} seviyesindesin." },
  { id: "l1_poke_02", level: 1, context: "poke", title: "Koltuk rahat mı?", body: "{winner} {winnerScore} {unit} yapmış, sen {loserScore}. Biraz kıpırdanmanın vakti geldi." },
  { id: "l1_poke_03", level: 1, context: "poke", title: "Hatırlatma", body: "{challenge} hâlâ açık. {winner} bugün çalıştı, sıra sende." },
  { id: "l1_poke_04", level: 1, context: "poke", title: "İyi misin?", body: "{loser}, {metric} tablosunda uzun süredir hareket yok. {winner} merak etti." },
  { id: "l1_poke_05", level: 1, context: "poke", title: "Arayı kapat", body: "{winner} ile aranda {diff} {unit} var. Bugün biraz gayret edersen kapanır." },
  { id: "l1_poke_06", level: 1, context: "poke", title: "Bakan var", body: "{winner} skoruna baktı: {loserScore} {unit}. Yorum yok." },
  { id: "l1_poke_07", level: 1, context: "poke", title: "Bir öneri", body: "{winner} {diff} {unit} önde. Kalk bi su iç bence, sonra da biraz yürü." },
  { id: "l1_streak_01", level: 1, context: "streak", title: "Seri devam ediyor", body: "{winner} {challenge} çelıncını yine kazandı. {loser}, bu artık alışkanlık oldu." },
  { id: "l1_streak_02", level: 1, context: "streak", title: "Yine {winner}", body: "{winner} üst üste kazanıyor. {winnerScore} - {loserScore}." },
  { id: "l1_revenge_01", level: 1, context: "revenge", title: "Rövanş alındı", body: "{winner} geçen seferin hesabını sordu: {winnerScore} - {loserScore}. Sıra sende {loser}." },
  { id: "l1_revenge_02", level: 1, context: "revenge", title: "Ödeştiniz", body: "{winner} {challenge} rövanşını kazandı. {winnerScore} - {loserScore}." },
  { id: "l2_win_01", level: 2, context: "win", title: "Koydu", body: "{winner} koydu: {winnerScore} {unit} karşısında {loserScore}. Afiyet olsun {loser}." },
  { id: "l2_win_02", level: 2, context: "win", title: "Yedin kanka", body: "{winner} {challenge} çelıncında sana {diff} {unit} fark attı. Hani sen iddialıydın?" },
  { id: "l2_win_03", level: 2, context: "win", title: "Ağır mı geldi?", body: "{winner} {winnerScore} {unit} yaptı, sen {loserScore}. {metric} sana ağır geldi galiba lan." },
  { id: "l2_win_04", level: 2, context: "win", title: "Skor konuştu", body: "{winner} {winnerScore}, sen {loserScore}. Yedin {loser}." },
  { id: "l2_win_05", level: 2, context: "win", title: "Rezil oldun {loser}", body: "{winner} bütün grubun önünde sana {diff} {unit} fark attı." },
  { id: "l2_win_06", level: 2, context: "win", title: "Sürünmüşsün", body: "{winner} {winnerScore} {unit} yapmış, sen {loserScore}. Nereye kayboldun?" },
  { id: "l2_win_07", level: 2, context: "win", title: "Bahaneni hazırla", body: "{winner} {challenge} çelıncını aldı: {winnerScore} - {loserScore}. Grup birazdan soracak." },
  { id: "l2_win_08", level: 2, context: "win", title: "Olmadı", body: "{loser} {loserScore} {unit} yaptı, {winner} {winnerScore}. {diff} {unit} fark, yedin." },
  { id: "l2_winbig_01", level: 2, context: "win_big", title: "Silindir gibi geçti", body: "{winner} {winnerScore}, sen {loserScore}. Arada {diff} {unit} var {loser}. Buna çelınc denmez." },
  { id: "l2_winbig_02", level: 2, context: "win_big", title: "Sen katıldın mı?", body: "{winner} {challenge} çelıncında uçmuş, sen {loserScore} {unit} ile kalmışsın. Telefonu evde mi unuttun lan?" },
  { id: "l2_winbig_03", level: 2, context: "win_big", title: "Özenle koydu", body: "{winner} sana {diff} {unit} fark attı {loser}. Adam üşenmemiş, özene özene koymuş." },
  { id: "l2_winbig_04", level: 2, context: "win_big", title: "Skorun ne öyle?", body: "{winner} {winnerScore} yaptı, sen {loserScore}. {metric} çelıncını tek başına oynamış." },
  { id: "l2_winclose_01", level: 2, context: "win_close", title: "Kıl payı yedin", body: "{winner} seni {diff} {unit} ile geçti. Az kalmıştı." },
  { id: "l2_winclose_02", level: 2, context: "win_close", title: "Ucundan koydu", body: "{winnerScore} - {loserScore}. {winner} son anda geçti {loser}." },
  { id: "l2_winclose_03", level: 2, context: "win_close", title: "Rahatlamıştın galiba", body: "{winner} son anda {diff} {unit} öne geçti. Tam rahatlamıştın lan." },
  { id: "l2_winclose_04", level: 2, context: "win_close", title: "Burun farkı", body: "{winner} {winnerScore}, sen {loserScore}. Fark burun kadar ama burnun sürtüldü {loser}." },
  { id: "l2_tie_01", level: 2, context: "tie", title: "Kimse koyamadı", body: "{winnerScore} - {loserScore}. Berabere. Bir daha oynayın." },
  { id: "l2_tie_02", level: 2, context: "tie", title: "Sıkıcı oldu", body: "{winner} ve {loser} eşit bitirdi. Bu uygulama bunun için yapılmadı lan." },
  { id: "l2_poke_01", level: 2, context: "poke", title: "Kalk yürü", body: "{winner} {winnerScore} {unit} yapmış, sen {loserScore} ile yatıyorsun. Koltuğa yapıştın." },
  { id: "l2_poke_02", level: 2, context: "poke", title: "Dürtüldün", body: "{winner} seni dürttü. {challenge} bitmedi, {metric} tarafında bir hareket göreyim." },
  { id: "l2_poke_03", level: 2, context: "poke", title: "Hayatta mısın {loser}?", body: "Sabahtan beri {loserScore} {unit}. {winner} soruyor: nabız var mı lan?" },
  { id: "l2_poke_04", level: 2, context: "poke", title: "Aradaki fark {diff}", body: "{winner} ile aranda {diff} {unit} var. Böyle giderse akşam {winner} imzalı bir bildirim gelir." },
  { id: "l2_poke_05", level: 2, context: "poke", title: "Kanepe önde", body: "{loser}, {metric} tarafında kıpırtı yok. {winner} soruyor: kanepeyle mi çelınc yapıyorsun, benimle mi?" },
  { id: "l2_poke_06", level: 2, context: "poke", title: "Bir hareket gör", body: "{winner} {winnerScore} ile geziyor, sen {loserScore} ile oturuyorsun. Kalk biraz." },
  { id: "l2_poke_07", level: 2, context: "poke", title: "Belli oldu", body: "Kanka sen bugün zokayı yiyeceksin, yine belli oldu. {winner} {winnerScore}, sen {loserScore} {unit}." },
  { id: "l2_poke_08", level: 2, context: "poke", title: "Kalk bi su iç", body: "{winner} {diff} {unit} önde. Kalk bi su iç bence, ondan sonra da kıpırda biraz." },
  { id: "l2_streak_01", level: 2, context: "streak", title: "Yine koydu", body: "{winner} üst üste kazanıyor. {winnerScore} - {loserScore}. Alışıyorsun galiba {loser}." },
  { id: "l2_streak_02", level: 2, context: "streak", title: "Seri devam", body: "{winner} bir daha koydu. {loser} her seferinde yiyor, sofra hiç kalkmıyor lan." },
  { id: "l2_revenge_01", level: 2, context: "revenge", title: "Rövanşı aldı", body: "{winner} geçen sefer yemişti, bu sefer koydu: {winnerScore} - {loserScore}. Hesap kapandı {loser}." },
  { id: "l2_revenge_02", level: 2, context: "revenge", title: "Ödeştik", body: "{winner} {challenge} rövanşında {diff} {unit} fark attı. Geçen seferki lafları geri al {loser}." },
  { id: "l3_win_01", level: 3, context: "win", title: "KOYDUM MU?", body: "{winner} sana sapır sapır sapladı 🍆 {winnerScore} {unit} karşısında {loserScore} {unit}. Yedin {loser}." },
  { id: "l3_win_02", level: 3, context: "win", title: "Dağıttı", body: "{winner} {challenge} çelıncında seni dağıttı: {winnerScore} - {loserScore}. Otur da dinlen {loser}." },
  { id: "l3_win_03", level: 3, context: "win", title: "Sapır sapır", body: "{winner} sana {diff} {unit} fark attı. Sapır sapır {loser}." },
  { id: "l3_win_04", level: 3, context: "win", title: "Yattın kaldın", body: "{winner} {winnerScore} {unit} yaptı, sen {loserScore}. Bütün grup izledi." },
  { id: "l3_win_05", level: 3, context: "win", title: "Girdi çıktı", body: "{winner} {challenge} çelıncına girip koydu. Sen hâlâ {loserScore} {unit} ile yatıyorsun {loser}." },
  { id: "l3_win_06", level: 3, context: "win", title: "Paytak paytak", body: "{winnerScore} - {loserScore}. {winner} yürüdü, sen paytak paytak dolaştın." },
  { id: "l3_win_07", level: 3, context: "win", title: "Kıvran biraz", body: "{winner} sana {diff} {unit} fark attı. Yut bakalım {loser} 🍆" },
  { id: "l3_win_08", level: 3, context: "win", title: "Yastık ister misin?", body: "{winner} {winnerScore} {unit} yaptı, sen {loserScore} ile altta kaldın. Rahat mısın {loser}?" },
  { id: "l3_winbig_01", level: 3, context: "win_big", title: "Dibine kadar", body: "{winner} {winnerScore}, sen {loserScore}. {diff} {unit} fark lan. Yedin {loser}, dibine kadar." },
  { id: "l3_winbig_02", level: 3, context: "win_big", title: "Tren geçti üstünden", body: "{winner} {challenge} çelıncında {diff} {unit} fark attı. Sen katılmadın, ezildin." },
  { id: "l3_winbig_03", level: 3, context: "win_big", title: "Sen ne yaptın lan?", body: "{winnerScore} karşısında {loserScore}. {winner} {metric} çelıncında koştururken sen telefonu buzdolabına mı koydun?" },
  { id: "l3_winbig_04", level: 3, context: "win_big", title: "Utanmadın mı?", body: "{winner} sana o kadar koydu ki {diff} {unit} farkını yazarken biz utandık {loser}." },
  { id: "l3_winclose_01", level: 3, context: "win_close", title: "Ucundan sapladı", body: "{winner} {diff} {unit} ile geçti. Ucundan da olsa yedin {loser}." },
  { id: "l3_winclose_02", level: 3, context: "win_close", title: "Kapıda yedin", body: "{winnerScore} - {loserScore}. Kurtuluyordun, {winner} son anda yakaladı {loser}." },
  { id: "l3_winclose_03", level: 3, context: "win_close", title: "Bir gayret eksik", body: "{winner} seni {diff} {unit} ile geçti lan. Bir hareket daha etseydin olmayacaktı." },
  { id: "l3_winclose_04", level: 3, context: "win_close", title: "90+5", body: "{winner} son dakikada koydu: {winnerScore} - {loserScore}. Erken sevinmiştin {loser}." },
  { id: "l3_tie_01", level: 3, context: "tie", title: "Kimse koyamadı", body: "{winnerScore} - {loserScore}. Berabere lan. Ortadaki 🍆 sahipsiz kaldı." },
  { id: "l3_tie_02", level: 3, context: "tie", title: "Eşit bitti", body: "{winner} ve {loser} aynı skorda kaldı. Rövanş açın." },
  { id: "l3_poke_01", level: 3, context: "poke", title: "Kalk yürü lan!", body: "{winner} {winnerScore} {unit} yapmış, sen {loserScore}. Koltuğa yapıştın, akşama yersin." },
  { id: "l3_poke_02", level: 3, context: "poke", title: "Dürtüldün {loser}", body: "{winner} seni dürttü. {diff} {unit} geride yatıyorsun. Gece bildirim gelir 🍆" },
  { id: "l3_poke_03", level: 3, context: "poke", title: "Donmuşsun", body: "{loser}, {loserScore} {unit} ile donup kalmışsın. {winner} çoktan gitti." },
  { id: "l3_poke_04", level: 3, context: "poke", title: "Kanepe sana koydu", body: "{winner} {winnerScore} ile geziyor, sen {loserScore} ile yatıyorsun. Sırada {winner} var." },
  { id: "l3_poke_05", level: 3, context: "poke", title: "Arayı kapat", body: "{diff} {unit} geridesin. {winner} şimdiden bildirimi yazıyor, kalk da silsin." },
  { id: "l3_poke_06", level: 3, context: "poke", title: "Son şans", body: "{metric} çelıncında sabahtan beri {loserScore} yaptın {loser}. {winner} diyor ki kıpırda, son şans 🍆" },
  { id: "l3_poke_07", level: 3, context: "poke", title: "Eşek gibi anırırım", body: "Sen bugün {winnerScore} {unit} yap, eşek gibi anırmazsam adam değilim {loser}." },
  { id: "l3_poke_08", level: 3, context: "poke", title: "Zokayı yiyeceksin", body: "Kanka sen bugün zokayı yiyeceksin, yine belli oldu 🍆 {diff} {unit} geridesin." },
  { id: "l3_streak_01", level: 3, context: "streak", title: "Yine sapladı 🍆", body: "{winner} üst üste kazandı: {winnerScore} - {loserScore}. {loser} yine yedi." },
  { id: "l3_streak_02", level: 3, context: "streak", title: "Gelenek oldu", body: "{winner} bir daha koydu. {loser} kaçıncı olduğunu unuttu bile." },
  { id: "l3_revenge_01", level: 3, context: "revenge", title: "Rövanşta sapladı", body: "{winner} geçen sefer yemişti. Bu sefer {diff} {unit} ile geri koydu {loser}." },
  { id: "l3_revenge_02", level: 3, context: "revenge", title: "Soğuk yedin", body: "{winner} bekledi ve {challenge} rövanşında sapladı: {winnerScore} - {loserScore}." },
] as const;

export const TAGLINE = {
  level1: "Arkadaşlarınla yarış. Kazanan laf hakkını alır.",
  level2: "Kankana koy, yoksa sen yersin.",
  level3: "Ya koyarsın ya yersin 🍆",
} as const;

const PLACEHOLDER = /\{(winner|loser|metric|winnerScore|loserScore|diff|unit|challenge)\}/g;

/** Fills {winner}, {loserScore}, ... leaving unknown placeholders untouched. */
export function renderTaunt(
  template: Pick<TauntTemplate, 'title' | 'body'>,
  vars: TauntVars
): { title: string; body: string } {
  const fill = (text: string): string =>
    text.replace(PLACEHOLDER, (_match, key: keyof TauntVars) => vars[key] ?? _match);
  return { title: fill(template.title), body: fill(template.body) };
}

/** Every template at or below `maxLevel` for the given context. */
export function tauntsFor(context: TauntContext, maxLevel: VulgarityLevel): TauntTemplate[] {
  return TAUNTS.filter((t) => t.context === context && t.level <= maxLevel);
}

/** Templates exactly at one level, falling back to lower levels when empty. */
export function tauntsAtLevel(context: TauntContext, level: VulgarityLevel): TauntTemplate[] {
  const exact = TAUNTS.filter((t) => t.context === context && t.level === level);
  return exact.length > 0 ? exact : tauntsFor(context, level);
}

export function getTaunt(id: string): TauntTemplate | undefined {
  return TAUNTS.find((t) => t.id === id);
}

/**
 * Picks a template. With a `seed` the choice is deterministic, which keeps the
 * server's automatic picks reproducible in tests.
 */
export function pickTaunt(
  context: TauntContext,
  level: VulgarityLevel,
  seed?: number
): TauntTemplate {
  const pool = tauntsAtLevel(context, level);
  if (pool.length === 0) {
    // every context has at least one level 1 template, but never crash on the
    // hot path: fall back to the first template of any context
    return TAUNTS[0];
  }
  if (seed === undefined) return pool[Math.floor(Math.random() * pool.length)];
  const index = Math.abs(Math.trunc(seed)) % pool.length;
  return pool[index];
}

/**
 * Resolves the template a sender's choice becomes for a specific recipient:
 * the level is clamped down, and a template above the recipient's ceiling is
 * swapped for one of the same context at the level they allow.
 */
export function resolveTauntForRecipient(
  requestedId: string | undefined,
  context: TauntContext,
  recipientMax: VulgarityLevel,
  seed?: number
): TauntTemplate {
  const requested = requestedId ? getTaunt(requestedId) : undefined;
  if (requested && requested.level <= recipientMax) return requested;
  const level = requested ? clampLevel(requested.level, recipientMax) : recipientMax;
  return pickTaunt(requested?.context ?? context, level, seed);
}

/** Formats a score the way the taunt copy expects: 12.430 in tr-TR. */
export function formatScore(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.abs(value % 1) < 1e-9 ? Math.round(value) : Math.round(value * 10) / 10;
  return rounded.toLocaleString('tr-TR');
}
