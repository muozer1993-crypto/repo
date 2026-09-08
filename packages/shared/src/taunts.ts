/**
 * Taunt templates — the "KOYDUM MU?" payloads.
 *
 * Levels: 1 nazik, 2 argo, 3 ağır abi. The RECIPIENT's maximum level always
 * wins, so a level 3 sender writing to a level 1 friend gets a level 1
 * template (see `clampLevel` and the server's taunt route).
 */
import { clampLevel } from './levels';
import type { TauntContext, TauntTemplate, TauntVars, VulgarityLevel } from './types';

export const TAUNTS: readonly TauntTemplate[] = [
  { id: "l1_win_01", level: 1, context: "win", title: "Sonuç geldi!", body: "{winner} bu sefer seni geçti: {winnerScore} vs {loserScore} {unit}. Rövanş düğmesi hemen altta, çekinme." },
  { id: "l1_win_02", level: 1, context: "win", title: "Bu tur ona gitti", body: "{challenge} bitti. {winner}: {winnerScore} {unit}, sen: {loserScore} {unit}. Aradaki {diff} {unit} sana ev ödevi." },
  { id: "l1_win_03", level: 1, context: "win", title: "Podyum bilgisi", body: "{winner} birinci oldu, sen katılım belgesi aldın. {metric}: {winnerScore} – {loserScore}. Alkışlar sana da, biraz kısık." },
  { id: "l1_win_04", level: 1, context: "win", title: "Küçük bir hatırlatma", body: "{winner} {challenge} çelincini kazandı. Sen {loserScore} {unit} yaptın, gayet iyi. Ama {winnerScore} biraz daha iyi." },
  { id: "l1_win_05", level: 1, context: "win", title: "Kazanan: {winner}", body: "{winner} {winnerScore} {unit} ile bitirdi. Sen {loserScore} {unit} ile tam arkasındaydın. Yani {diff} {unit} arkasında." },
  { id: "l1_win_06", level: 1, context: "win", title: "Fark {diff} {unit}", body: "{loser}, {winner} seni {diff} {unit} ile geçti. Üzülme, yarın yeni gün. Ama bugün onun günü, sen sadece davetlisin." },
  { id: "l1_win_07", level: 1, context: "win", title: "Kazanan belli", body: "{challenge} sona erdi. {winner} zirveye çıktı, {loser} manzarayı izledi. {winnerScore} – {loserScore}. Manzara güzel miydi?" },
  { id: "l1_win_08", level: 1, context: "win", title: "Skor tabelası", body: "{winner} {winnerScore} {unit} · {loser} {loserScore} {unit}. Bu kez alkış ona, bir dahakine belki sana. Belki." },
  { id: "l1_winbig_01", level: 1, context: "win_big", title: "Fark biraz açıldı", body: "{winner} {winnerScore} {unit}, sen {loserScore} {unit}. Aradaki {diff} {unit} tek başına ayrı bir çelinç olurdu." },
  { id: "l1_winbig_02", level: 1, context: "win_big", title: "Ders niteliğinde", body: "{winner} {challenge} çelincinde resmen ders anlattı: {winnerScore} vs {loserScore}. Sen arka sırada uyumuşsun." },
  { id: "l1_winbig_03", level: 1, context: "win_big", title: "Farklı liglerdesiniz", body: "{winner} senin {loserScore} {unit} skoruna bakıp {winnerScore} yaptı. {metric} konusunda bir oturup konuşsanız iyi olur." },
  { id: "l1_winbig_04", level: 1, context: "win_big", title: "Seyirci koltuğu", body: "{winner}: {winnerScore}. Sen: {loserScore}. {challenge} yarışında bir yarışmacı vardı, bir de seyirci. Tahmin et hangisisin." },
  { id: "l1_winclose_01", level: 1, context: "win_close", title: "Kıl payı!", body: "{winner} seni sadece {diff} {unit} ile geçti. Bu kadar yakından kaybetmek de bir yetenek. Bir dahakine senin." },
  { id: "l1_winclose_02", level: 1, context: "win_close", title: "Fotofiniş", body: "{winnerScore} – {loserScore}. {winner} burnunun ucuyla kazandı. Burnun biraz daha uzun olsaydı bugün sendin." },
  { id: "l1_winclose_03", level: 1, context: "win_close", title: "Az kaldı {loser}", body: "{diff} {unit} fark. Son bir küçük gayret bu işi döndürürdü. {winner} bunu biliyordu, sen de artık biliyorsun." },
  { id: "l1_winclose_04", level: 1, context: "win_close", title: "Nefes nefese bitti", body: "{winner} son anda öne geçti: {winnerScore} vs {loserScore}. Sen de gayet iyiydin, sadece o birazcık daha iyiydi." },
  { id: "l1_tie_01", level: 1, context: "tie", title: "Berabere!", body: "{winner} ve {loser} tam {winnerScore} {unit} ile eşit. Kimse kimseye bir şey diyemiyor. Şimdilik." },
  { id: "l1_tie_02", level: 1, context: "tie", title: "İkiniz de birinci", body: "{challenge} berabere bitti: {winnerScore} – {loserScore}. Ne kazanan var ne kaybeden. Sıkıcı ama adil. Rövanş düzeltir." },
  { id: "l1_poke_01", level: 1, context: "poke", title: "Küçük bir dürtme", body: "{winner} seni dürttü: {challenge} devam ediyor, sen şu an {loserScore} {unit} seviyesindesin. Hadi, biraz hareket!" },
  { id: "l1_poke_02", level: 1, context: "poke", title: "Koltuk seni çağırıyor mu?", body: "{winner} {winnerScore} {unit} yapmış, sen {loserScore}. Kalk biraz kıpırdan, koltuk bir yere kaçmıyor." },
  { id: "l1_poke_03", level: 1, context: "poke", title: "Nazik bir hatırlatma", body: "{challenge} hâlâ açık. {winner} çalışıyor, sen dinleniyorsun. Rollerin yer değiştirme vakti geldi." },
  { id: "l1_poke_04", level: 1, context: "poke", title: "Hayat işareti?", body: "{loser}, {metric} tablosunda uzun süredir kıpırdanma yok. {winner} merak etti: iyi misin, yoksa sadece çok mu rahatsın?" },
  { id: "l1_poke_05", level: 1, context: "poke", title: "Arayı kapat", body: "{winner} ile aranda {diff} {unit} var. Bugün biraz gayret, yarın hikâye başka olur. Hikâyeyi sen yaz." },
  { id: "l1_poke_06", level: 1, context: "poke", title: "Bakışlar üzerinde", body: "{winner} skorunu kontrol etti ve gülümsedi. {loserScore} {unit}. Bu gülümsemeyi silmek sana kalmış." },
  { id: "l1_streak_01", level: 1, context: "streak", title: "Seri devam ediyor", body: "{winner} {challenge} çelincini yine kazandı. Üst üste. {loser}, bu artık bir alışkanlık: onun için kazanmak, senin için izlemek." },
  { id: "l1_streak_02", level: 1, context: "streak", title: "Yine mi {winner}?", body: "Evet, yine. {winnerScore} – {loserScore}. {winner} seri yapıyor, sen seyir yapıyorsun. Seyir de güzel ama seri daha güzel." },
  { id: "l1_revenge_01", level: 1, context: "revenge", title: "Rövanş alındı", body: "{winner} geçen seferin hesabını sordu: {winnerScore} vs {loserScore}. {loser}, top tekrar sende." },
  { id: "l1_revenge_02", level: 1, context: "revenge", title: "Hesap kapandı", body: "{winner} bu kez kazandı ve defter kapandı. {challenge} skoru: {winnerScore} – {loserScore}. Ödeştiniz, yeni sayfa." },
  { id: "l2_win_01", level: 2, context: "win", title: "Koydu lan", body: "{winner} koydu lan: {winnerScore} {unit} karşısında {loserScore}. Yedin {loser}, afiyet olsun." },
  { id: "l2_win_02", level: 2, context: "win", title: "Yedin kanka", body: "{winner} seni {challenge} çelincinde {diff} {unit} ile paketledi. Hani sen iddialıydın? İddia kaldı, sen yedin." },
  { id: "l2_win_03", level: 2, context: "win", title: "Ağır geldi galiba", body: "{winner} {winnerScore} {unit} yaptı, sen {loserScore}. {metric} sana ağır geldi galiba lan, hafifini mi versek?" },
  { id: "l2_win_04", level: 2, context: "win", title: "Skor konuştu", body: "{winnerScore} – {loserScore}. {winner} konuştu, sen dinledin. Bir dahakine sesini çıkar {loser}, susan yiyor." },
  { id: "l2_win_05", level: 2, context: "win", title: "Rezil oldun {loser}", body: "{winner} bütün grubun önünde seni {diff} {unit} ile geçti. Grup gördü, biz gördük, sen de gördün. Kimse unutmayacak." },
  { id: "l2_win_06", level: 2, context: "win", title: "Sürünmüşsün lan", body: "{winner} {winnerScore} {unit}, sen {loserScore}. Sen yürümemişsin, sürünmüşsün lan. Yerde iz kalmış." },
  { id: "l2_win_07", level: 2, context: "win", title: "Bahane hazır mı?", body: "{winner} {challenge} çelincini aldı: {winnerScore} vs {loserScore}. Bahaneni hazırla lan, grup birazdan soracak." },
  { id: "l2_win_08", level: 2, context: "win", title: "Denedin, olmadı", body: "{loser}, sen {loserScore} {unit} ile bir şey denedin, olmadı. {winner} {winnerScore} ile yaptı. Fark {diff}, yedin." },
  { id: "l2_winbig_01", level: 2, context: "win_big", title: "Silindir geçti lan", body: "{winner} {winnerScore}, sen {loserScore}. {diff} {unit} fark. Bu çelinç değil, üstünden silindir geçti. Yedin {loser}." },
  { id: "l2_winbig_02", level: 2, context: "win_big", title: "Sen katıldın mı ki?", body: "{winner} {challenge} çelincinde uçtu, sen {loserScore} {unit} ile kaldın. Telefonu evde mi unuttun lan?" },
  { id: "l2_winbig_03", level: 2, context: "win_big", title: "Özenle koydu", body: "{winner} {diff} {unit} fark attı. Bu kadar da olmaz {loser}, adam sana koydu, hem de özenle, hem de imzalı." },
  { id: "l2_winbig_04", level: 2, context: "win_big", title: "Skorun utandı", body: "{winnerScore} yanında {loserScore} ne lan? {winner} kazanmadı, {metric} nasıl yapılır sana ders verdi. Ücretsiz." },
  { id: "l2_winclose_01", level: 2, context: "win_close", title: "Kıl payı yedin", body: "{winner} seni {diff} {unit} ile geçti lan. Bir gayret daha etseydin dönerdi. Etmedin, yedin. Az yedin ama yedin." },
  { id: "l2_winclose_02", level: 2, context: "win_close", title: "Ucundan koydu", body: "{winnerScore} – {loserScore}. {winner} tam ucundan koydu ama koydu. Ucu da sayılır {loser}, hakem devam dedi." },
  { id: "l2_winclose_03", level: 2, context: "win_close", title: "Kurtardın sanmıştın", body: "{winner} son dakikada {diff} {unit} öne geçti. Rahatlamıştın lan, tam o sırada koydu. Rahatlamak yasak." },
  { id: "l2_winclose_04", level: 2, context: "win_close", title: "Burun farkı", body: "{winner} {winnerScore}, sen {loserScore}. Bu fark burun farkı ama burnun sürtüldü {loser}. Yere, güzelce." },
  { id: "l2_tie_01", level: 2, context: "tie", title: "Kimse koyamadı", body: "{winnerScore} – {loserScore}. Berabere lan. Ne sen koydun ne o. Bir daha oynayın, birine koyulsun." },
  { id: "l2_tie_02", level: 2, context: "tie", title: "Sıkıcı bir sonuç", body: "{winner} ve {loser} eşit bitirdi. Kimse yemedi lan. Bu uygulama bunun için yapılmadı, rövanş açın." },
  { id: "l2_poke_01", level: 2, context: "poke", title: "Kalk yürü lan", body: "{winner} {winnerScore} {unit} yapmış, sen {loserScore} ile yatıyorsun. Kalk, koltuğa yapıştın, koltuk da şikâyetçi." },
  { id: "l2_poke_02", level: 2, context: "poke", title: "Dürtüldün", body: "{winner} seni dürttü: {challenge} bitmedi lan, sen bittin. Hadi biraz {metric} göreyim." },
  { id: "l2_poke_03", level: 2, context: "poke", title: "Hayatta mısın {loser}?", body: "Sabahtan beri {loserScore} {unit}. {winner} soruyor: nabız var mı lan, yoksa telefonu kediye mi verdin?" },
  { id: "l2_poke_04", level: 2, context: "poke", title: "Aradaki fark {diff}", body: "{winner} ile aranda {diff} {unit} var. Böyle giderse akşam bildirim gelecek: konusu sen, yazarı {winner}." },
  { id: "l2_poke_05", level: 2, context: "poke", title: "Kanepe seni yendi", body: "{loser}, {metric} skorun donmuş. {winner} diyor ki: kanepeyle çelinç yapmıyoruz lan, benimle yapıyorsun. Kalk." },
  { id: "l2_poke_06", level: 2, context: "poke", title: "Bir hareket gör", body: "{winner} {winnerScore} ile geziyor, sen {loserScore} ile oturuyorsun. Oturarak kimse kazanmadı lan. Kalk da en azından ayakta ye." },
  { id: "l2_streak_01", level: 2, context: "streak", title: "Yine koydu lan", body: "{winner} üst üste kazanıyor. {winnerScore} – {loserScore}. {loser}, yemeye abone mi oldun? Aboneliği iptal et." },
  { id: "l2_streak_02", level: 2, context: "streak", title: "Seri devam", body: "{winner} bir daha koydu. Bu artık seri değil, gelenek. {loser} her seferinde yiyor lan, sofra hiç kalkmıyor." },
  { id: "l2_revenge_01", level: 2, context: "revenge", title: "Rövanşı aldı lan", body: "{winner} geçen sefer yemişti, bu sefer koydu: {winnerScore} vs {loserScore}. Hesap kapandı {loser}, faiziyle." },
  { id: "l2_revenge_02", level: 2, context: "revenge", title: "Ödeştik", body: "{winner} {challenge} rövanşında {diff} {unit} fark attı. Geçen seferki laflarını geri al {loser}, hepsini tek tek." },
  { id: "l3_win_01", level: 3, context: "win", title: "KOYDUM MU?", body: "{winner} sana sapır sapır sapladı 🍆 {winnerScore} {unit} karşısında {loserScore} {unit}. Yedin {loser}, sindir." },
  { id: "l3_win_02", level: 3, context: "win", title: "Kökledi lan", body: "{winner} {challenge} çelincinde sana kökledi: {winnerScore} vs {loserScore}. Fidan diksen bu kadar kökleşmezdi {loser}." },
  { id: "l3_win_03", level: 3, context: "win", title: "Sapır sapır", body: "{winner} {diff} {unit} fark attı. Sapır sapır 🍆 {loser}, o duyduğun ses senin yediğin ses. Alış." },
  { id: "l3_win_04", level: 3, context: "win", title: "Rezil rüsva oldun", body: "{winner} {winnerScore} {unit} yaptı, sen {loserScore}. Bütün grup izledi, sen yattın kaldın. Hem de sonuna kadar." },
  { id: "l3_win_05", level: 3, context: "win", title: "Girdi çıktı", body: "{winner} {challenge} çelincine girdi, koydu, çıktı. Sen hâlâ {loserScore} {unit} ile yatıyorsun {loser}. Kapıyı da açık bıraktı." },
  { id: "l3_win_06", level: 3, context: "win", title: "Kaz gibi yürüdün", body: "{winnerScore} – {loserScore}. {winner} yürüdü, sen paytak paytak {loserScore} yaptın. Kaz bile utandı lan, sürü seni reddetti." },
  { id: "l3_win_07", level: 3, context: "win", title: "Kıvrandın mı?", body: "{winner} sana {diff} {unit} fark attı. Kıvran biraz {loser}, sonra yut. Yutmak da yemenin parçası 🍆" },
  { id: "l3_win_08", level: 3, context: "win", title: "Koydu, yerleştirdi", body: "{winner} {winnerScore} {unit} ile koydu, {loserScore} üstüne güzelce yerleştirdi 🍆 {loser}, rahat mısın, yastık ister misin?" },
  { id: "l3_winbig_01", level: 3, context: "win_big", title: "Dip yaptı 🍆", body: "{winner} {winnerScore}, sen {loserScore}. {diff} {unit} fark lan, bu koymak değil, dip yapmak. Yedin {loser}, dibine kadar." },
  { id: "l3_winbig_02", level: 3, context: "win_big", title: "Tren geçti üstünden", body: "{winner} {challenge} çelincinde sana {diff} {unit} fark attı. Sen katılmadın, ezildin. Tren geçti lan, vagonlar hâlâ geçiyor." },
  { id: "l3_winbig_03", level: 3, context: "win_big", title: "Sen ne yaptın lan?", body: "{winnerScore} karşısında {loserScore}? {winner} {metric} yaptı, sen sanırım telefonu buzdolabına koydun. Dolap bile daha çok kıpırdadı." },
  { id: "l3_winbig_04", level: 3, context: "win_big", title: "Sistem bile utandı", body: "{winner} sana o kadar koydu ki {diff} {unit} farkı yazmaya sistem utandı 🍆🍆 {loser}, yedin, hem de tabağı yaladın." },
  { id: "l3_winclose_01", level: 3, context: "win_close", title: "Ucundan ama sapladı", body: "{winner} {diff} {unit} ile geçti. Tam ucundan ama sapladı lan 🍆 Ucundan yiyen de yemiş sayılır {loser}, tüzük böyle." },
  { id: "l3_winclose_02", level: 3, context: "win_close", title: "Az kalsın kurtuluyordun", body: "{winnerScore} – {loserScore}. Kurtuluyordun ama {winner} son anda yakaladı ve koydu. Kapıda yedin {loser}, kapıda." },
  { id: "l3_winclose_03", level: 3, context: "win_close", title: "Bir gayret eksik", body: "{winner} seni {diff} {unit} ile geçti lan. Bir gayret daha etseydin... etmedin, sapladı 🍆 Tembelliğin bedeli bu." },
  { id: "l3_winclose_04", level: 3, context: "win_close", title: "90+5 golü", body: "{winner} 90+5'te koydu: {winnerScore} vs {loserScore}. Erken sevinmiştin lan {loser}, erken sevinen yer, kural bu." },
  { id: "l3_tie_01", level: 3, context: "tie", title: "Kimse kimseye koyamadı", body: "{winnerScore} – {loserScore}. Berabere lan. İkiniz de ne koydunuz ne yediniz. Ortada 🍆 duruyor, biri sahiplensin." },
  { id: "l3_tie_02", level: 3, context: "tie", title: "Sahipsiz 🍆", body: "{winner} ve {loser} eşit bitirdi. Kimse saplayamadı, 🍆 buzdolabında bekliyor. Rövanş şart lan, bayatlamadan." },
  { id: "l3_poke_01", level: 3, context: "poke", title: "Kalk yürü lan!", body: "{winner} {winnerScore} {unit} yapmış, sen {loserScore}. Koltuğa yapıştın, kalk yoksa akşam saplanacak 🍆" },
  { id: "l3_poke_02", level: 3, context: "poke", title: "Dürtüldün {loser}", body: "{winner} seni dürttü. {diff} {unit} geride yatıyorsun. Böyle giderse gece bildirim gelecek, üstünde 🍆 olan cinsten." },
  { id: "l3_poke_03", level: 3, context: "poke", title: "Donmuşsun lan", body: "{loser}, {loserScore} {unit} ile donmuşsun. {winner} soruyor: yaşıyor musun, yoksa yemeye mi hazırlanıyorsun? 🍆" },
  { id: "l3_poke_04", level: 3, context: "poke", title: "Kanepe sana koydu", body: "{winner} {winnerScore} ile geziyor, sen {loserScore} ile yatıyorsun. Kanepe sana koydu bile, sırada {winner} var 🍆" },
  { id: "l3_poke_05", level: 3, context: "poke", title: "Arayı kapat lan", body: "{diff} {unit} geride kaldın. {winner} şimdiden 🍆 bildirimi yazıyor. Kalk da yazdığı boşa gitsin, silmek zorunda kalsın." },
  { id: "l3_poke_06", level: 3, context: "poke", title: "Son şans", body: "{loser}, {metric} skorun sabahtan beri {loserScore}. {winner} diyor ki: kıpırda lan, saplanmadan önce son şans 🍆" },
  { id: "l3_streak_01", level: 3, context: "streak", title: "Yine sapladı 🍆", body: "{winner} üst üste kazandı: {winnerScore} – {loserScore}. {loser}, bu artık seri değil, sen onun düzenli müşterisisin." },
  { id: "l3_streak_02", level: 3, context: "streak", title: "Seri koyuş", body: "{winner} bir daha koydu lan. Bu kaçıncı? Sen sayamıyorsun çünkü her seferinde yiyorsun {loser}. O çentik atıyor." },
  { id: "l3_revenge_01", level: 3, context: "revenge", title: "Rövanşta sapladı", body: "{winner} geçen sefer yemişti, hatırlıyor musun? Bu sefer {diff} {unit} ile geri koydu 🍆 Faiziyle ödeştiniz {loser}." },
  { id: "l3_revenge_02", level: 3, context: "revenge", title: "İntikam soğuk yenir", body: "{winner} bekledi, bekledi, {challenge} rövanşında {winnerScore} vs {loserScore} ile sapladı. Soğuk soğuk yedin lan." },
] as const;

export const TAGLINE = {
  level1: "Arkadaşlarınla yarış, kendini geliştir, kazanana laf hakkı.",
  level2: "Kankana koy ya da ye. Adım at, telefonu bırak, rezil olma.",
  level3: "Ya koyarsın ya yersin. Üçüncü yol yok 🍆",
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
