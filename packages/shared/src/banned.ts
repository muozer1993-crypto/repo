/**
 * Content filter for custom taunts.
 *
 * Policy (friends-only crude banter is the product; this is the hard floor):
 *   ALLOWED  generic swearing directed at the loser ("amk", "lan", "sikeyim", "yarrak", "mal"...)
 *   BLOCKED  family insults (anne / bacı / aile / sülale / avrat ...),
 *            threats of violence and sexual violence (öldür*, gebert*, ırz*, tecavüz*),
 *            slurs against protected groups (ethnicity, religion, sexual orientation, disability).
 *
 * Every pattern is written against NORMALIZED text (see `normalizeForBanned`):
 *   1. invisible characters removed (zero-width, soft hyphen, variation selectors...),
 *      and Cyrillic/Greek lookalike letters folded to Latin ("аnаn" with Cyrillic а),
 *   2. lowercased with Turkish rules (I→ı, İ→i) and light leet-speak folded,
 *   3. two ambiguous Turkish stems marked (see below),
 *   4. Turkish letters folded to ASCII (ı→i, ş→s, ğ→g, ü→u, ö→o, ç→c), diacritics stripped,
 *   5. leftover digits and underscores turned into spaces so `\b` fires around "2ibne" / "_ibne",
 *      and a single symbol squeezed between two letters removed ("a.n.a.n", "i-b-n-e"),
 *   6. whitespace collapsed.
 * Because the text is ASCII by then, `\b` behaves. Compound patterns use `\W*` / `\W+`
 * between words so "göt-veren", "göt veren" and "götveren" are the same thing.
 *
 * Two Turkish-specific folds keep innocent words apart from insults that only differ by
 * a dotted/dotless i or by ç:
 *   - `sık-` (sıkıntı, sıkıldı, sıkıştı, sıkı, sıkma, sıkça...) becomes `syk` when it is
 *     spelled with a dotless ı AND continues with back-vowel harmony, so it no longer
 *     collides with the `sik-` verb stem after folding. "sıkeyim"/"sıktım" keep the
 *     `sik` reading (front-vowel or consonant+front-vowel continuation), and plain ASCII
 *     "sikinti" stays ambiguous — nothing can tell it apart.
 *   - `piç` (spelled with ç) becomes `pich`, so a bare ASCII "pic" (English "pic") passes
 *     while "piç", "PIÇ", "piçi", "piçsin", "piç kurusu" are caught.
 */

import { INVISIBLE_CHARS_REGEX, TURKISH_FOLD } from './text';

const LEET_FOLD: Record<string, string> = {
  '@': 'a',
  $: 's',
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
};

/**
 * Cyrillic and Greek letters that look exactly like Latin ones. Typing "ibne"
 * with a Cyrillic і is the oldest trick against a word filter.
 */
const CONFUSABLE_FOLD: Record<string, string> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ѕ: 's', ј: 'j', к: 'k', м: 'm', т: 't', н: 'h', в: 'b',
  А: 'a', Е: 'e', О: 'o', Р: 'p', С: 'c', У: 'y', Х: 'x', І: 'i', Ѕ: 's', Ј: 'j', К: 'k', М: 'm', Т: 't', Н: 'h', В: 'b',
  α: 'a', ο: 'o', ε: 'e', ι: 'i', κ: 'k', ν: 'v', τ: 't', υ: 'u', ρ: 'p', χ: 'x',
  Α: 'a', Ο: 'o', Ε: 'e', Ι: 'i', Κ: 'k', Ν: 'n', Τ: 't', Υ: 'y', Ρ: 'p', Χ: 'x',
};
const CONFUSABLE_REGEX = new RegExp(`[${Object.keys(CONFUSABLE_FOLD).join('')}]`, 'g');

/** ZWJ and emoji variation selectors — glue for emoji, noise for word matching. */
const EMOJI_GLUE_REGEX = new RegExp('[\\u200D\\uFE00-\\uFE0F]', 'g');

const TURKISH_LOWER_LETTER = 'a-zçğıiöşüâîû';

/** `sık` (dotless ı) followed by back-vowel harmony or the end of the word → innocent. */
const INNOCENT_SIK_REGEX = new RegExp(`sık(?=[mçl]?(?:[ıa]|(?![${TURKISH_LOWER_LETTER}])))`, 'g');

/** `piç` / `pıç` spelled with ç at the end of a word → `pich`. */
const PIC_REGEX = new RegExp(`p[iı]ç(?![${TURKISH_LOWER_LETTER}])`, 'g');

export function normalizeForBanned(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  return text
    .replace(INVISIBLE_CHARS_REGEX, '')
    .replace(EMOJI_GLUE_REGEX, '')
    .replace(CONFUSABLE_REGEX, (ch) => CONFUSABLE_FOLD[ch] ?? ch)
    .replace(/İ/g, 'i') // Turkish casing first: toLowerCase() would turn İ into "i̇" and I into "i"
    .replace(/I/g, 'ı')
    .toLowerCase()
    .replace(/[@$01345]/g, (ch) => LEET_FOLD[ch] ?? ch)
    .replace(INNOCENT_SIK_REGEX, 'syk')
    .replace(PIC_REGEX, 'pich')
    .replace(/[ışğüöçâîû]/g, (ch) => TURKISH_FOLD[ch] ?? ch)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip any remaining diacritics
    .replace(/[0-9_]/g, ' ') // not folded by leet → word separators, so \b works
    // "a.n.a.n", "i-b-n-e": one symbol between two letters is not a word break.
    // Capture + lookahead only (no lookbehind, no \p{}) so Hermes runs it.
    .replace(/([a-z])[^a-z0-9\s](?=[a-z])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// Family nouns that are an insult on their own once they carry a "your" possessive.
const FAMILY_SUFFIX = '(?:i|in|ini|inin|a|e|la|le|dan|den|da|de|im|iz|izi|izin|iza|ize|lar|lari|larin|larini|lara)?';

// Verb stems used to "complete" ambiguous family words (karın, ailen, soyun ...).
const SEX_VERB = '(?:sik|sok(?:ay|ar)|becer)';

const ETHNIC_GROUP = '(?:kurt|kurd|ermeni|rum|yahudi|arap|arab|yunan|suriyeli|afgan|cingene|roman|alevi|sunni|zenci|laz|cerkez)';

// Threats that are also everyday Turkish for a hard workout or a habit to quit:
// "Şekeri keseceğim", "öldürücü antrenman", "geberene kadar koş", "kafa dağıtmak",
// "canını yakacak bir antrenman". A çelınc's title and stakes take them unless
// they also name someone (`containsBannedTitle`); a laf and a name never do.
// "öldürürüm" and "gebertirim" (killing someone) are not among them.
const OLDURUCU = /\boldurucu\w*/; // öldürücü: deadly, "öldürücü antrenman"
const GEBER = /\bgeber(?!t)\w*/; // geber, geberene kadar, geberesice
const KES = /\bkes(?:erim|ecegim|icem|cem|iyim|ecem)\b/;
const KAFA_DAGIT = /\bkafa(?:ni|nizi|sini)\W*dagit\w*/;
const CAN_YAK = /\bcan(?:ini|inizi)\W*yak(?:ir|ar|acag|acak|cam|cem|icam|icem|tir|sin)\w*/;
const THREAT_IDIOMS: readonly RegExp[] = [OLDURUCU, GEBER, KES, KAFA_DAGIT, CAN_YAK];
/** Someone a threat would be aimed at: "seni keserim", "kaybedeni keser". */
const AIMED_AT_SOMEONE = /\b(?:seni|sizi|senin|sizin|onu|onlari|kaybedeni|kazanani|kaybedenleri|kazananlari)\b/;

export const BANNED_PATTERNS: RegExp[] = [
  // --- family insults ------------------------------------------------------
  // "anane" (tradition) is excluded: the dative of "anan" is "anana" by vowel harmony.
  new RegExp(`\\b(?!anane\\b)(?:anan|annen|ananiz|anneniz|anacigin|anacigini)${FAMILY_SUFFIX}\\b`),
  new RegExp(`\\b(?:bacin|baciniz|kizkardesin|kizkardesiniz)${FAMILY_SUFFIX}\\b`),
  /\bkiz\W*kardesin\w*/,
  /\bavra[dt](?:ini|ina|inin|in|i|imi)?\b/,
  /\bana\W+avra[dt]\w*/,
  new RegExp(`\\b(?:sulalen|sulaleniz)${FAMILY_SUFFIX}\\b`),
  new RegExp(`\\b(?:karin|karini|karina|ailen|aileni|aileniz|ailenizi|soyun|soyunu|sopunu|ecdadin|ecdadini|olun|olunu|olulerin|olulerini|olmusun|olmusunu|dedeni|nineni|kizini|kizin|oglunu|oglun)\\W+${SEX_VERB}\\w*`),
  /\boros[bp]u\W*(?:cocu|evlad|dol)\w*/,
  /\borsp?u\W*(?:cocu|evlad)\w*/,
  // Bare ASCII "pic" is not enough (English "pic"); "piç" itself normalizes to "pich".
  /\bpic(?:(?:h|sin|siniz|in|i|ler|lerin|leri)\b|\W*kurus\w*)/,
  /\bkahpenin\W+(?:evlad|cocu|dol)\w*/,
  /\bdol(?:un|u|lerin|leri)\W+(?:bozuk|bozugu)\w*/,
  /\bveled(?:i)?\W*zina\w*/,

  // --- threats of violence / sexual violence -------------------------------
  /\boldur(?!ucu)\w*/, // öldürürüm, öldüreceğim, öldürcem, öldürmek
  OLDURUCU,
  /\bgebert\w*/, // gebertirim, gebertecem
  GEBER,
  KES,
  /\bbogar(?:im|iz|cam|cem|acagim)\b/,
  // "boğazını sıkarım / keserim" — but not "boğazın(a) sıkıştı" (stuck in your throat)
  /\bbogazin\w*\W*(?:kes|s[iy]k(?!is))\w*/,
  // Verb forms only: "bıçaklar keskin" (knives) and "bıçakla kesmek" (cut with a knife) pass
  /\bbicakla(?:rim|riz|yacagim|yacagiz|yacam|yacaz|yacak|cam|cem|dim|dik|mak|yim|yayim|yalim)\b/,
  /\bseni\W+bicakla\w*/,
  /\bbicakla\w*\W+seni\b/,
  /\bkursun\w*\W*(?:s[iy]k|yersin|yiyeceksin|dizer|dizerim)\w*/,
  /\bkafa(?:ni|nizi|sini)\W*(?:kir|kopar|ez|patlat|ucur|yar)\w*/,
  KAFA_DAGIT,
  // Future/aorist threat forms only: "canını çıkardım koşarken" (wore you out) is an idiom
  /\bcan(?:ini|inizi)\W*(?:al|cikar)(?:ir|ar|acag|acak|cam|cem|icam|icem|tir|sin)\w*/,
  CAN_YAK,
  /\bkan(?:ini|inizi)\W*(?:ic|akit|dok)\w*/,
  /\bmezar(?:ina|a)\W*(?:sok|gom|koy)\w*/,
  /\bgom(?:erim|ecegim|cem|icem|ecem)\W+seni\b/,
  /\bseni\W+gom(?:erim|ecegim|cem|icem|ecem)\b/,
  /\birz\w*/, // ırzına geçmek
  /\btecavuz\w*/,

  // --- slurs against protected groups --------------------------------------
  // Ethnicity / nationality: "<group> dölü/tohumu/piçi/köpeği/bozuntusu"
  new RegExp(`\\b(?:${ETHNIC_GROUP.slice(3, -1)}|turk)\\W*(?:dol|tohum|pic|kopeg|kopek|bozuntu|it[il]|ibne|serefsiz|pislig|pislik)\\w*`),
  new RegExp(`\\b(?:pis|serefsiz|kahrolsun|geberesi|gebersin|lanet\\W*olsun|hain)\\W+${ETHNIC_GROUP}\\w*`),
  /\bkiro\w*/,
  /\bzenci\w*/,
  /\bcifit\w*/,
  /\bgavur\w*/,
  /\bkafir\w*/,
  /\bkizilbas\w*/,
  /\byezi[dt]\b/,
  /\bdinsiz\w*/,
  /\bimansiz\w*/,
  // Sexual orientation / gender identity
  /\bibne\w*/,
  /\bgot\W*veren\w*/,
  /\bnonos\w*/,
  /\bpust\w*/,
  /\bhomo\b/,
  /\bhomolar\w*/,
  /\bsapkin\w*/,
  // Disability
  /\bgeri\W*zekal\w*/,
  /\bmongol\w*/,
  /\bspastik\w*/,
  /\bozurlu\w*/,
  /\btopal\w*/,
  /\bkotur\w*/,
  /\bengelli\W*(?:misin|mi|gibi)\b/,
  /\bdown\W*(?:sendrom|lu|li)\w*/,
];

const GLOBAL_PATTERNS: RegExp[] = BANNED_PATTERNS.map((p) => new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`));

/** All banned fragments found in `text` (normalized form, de-duplicated, in order). */
export function findBanned(text: string): string[] {
  const normalized = normalizeForBanned(text);
  if (!normalized) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const pattern of GLOBAL_PATTERNS) {
    for (const match of normalized.matchAll(pattern)) {
      const hit = match[0].trim();
      if (hit && !seen.has(hit)) {
        seen.add(hit);
        found.push(hit);
      }
    }
  }
  return found;
}

export function containsBanned(text: string): boolean {
  const normalized = normalizeForBanned(text);
  if (!normalized) return false;
  return BANNED_PATTERNS.some((p) => p.test(normalized));
}

/**
 * Real Turkish surnames that share a stem with a slur above (`topal…`, `kiro…`,
 * `gavur…`, `kotur…`, `zenci…`, `irz…`). A name is not a taunt: "Mehmet Topal" or
 * "Ayşe Kıroğlu" must be able to sign up. Only these whole words, as
 * `normalizeForBanned` leaves them, are spared, so the slur inside a sentence
 * ("topallar", "kiro herif") still trips the filter.
 */
const SPARED_SURNAME =
  /^(?:topal(?:li|oglu|ogullari)?|kir(?:oglu|ogullari)|gavur(?:oglu|ogullari)|kotur(?:oglu|ogullari)|zencir(?:ci|kiran)?|irzik)$/;

/** Where a name or a title breaks into words: spaces, and a username's underscores. */
const WORD_BREAK = /[\s_]+/;

/**
 * One word of a name or a title is a spared surname, also with a number typed
 * onto it ("mehmet_topal35": a leet 3 or 5 would otherwise glue a letter on) or
 * a suffix after an apostrophe ("Topal'ın çelıncı"). The digits go only at the
 * end and only for this test: "ibn3" still reads "ibne" everywhere else.
 */
function isSparedSurname(word: string): boolean {
  const bare = word.replace(/['\u2019][a-zA-Zçğıöşüâîû]*$/, '').replace(/[0-9]+$/, '');
  return bare.length > 0 && SPARED_SURNAME.test(normalizeForBanned(bare));
}

function withoutSparedSurnames(text: string): string {
  return text
    .split(WORD_BREAK)
    .filter((word) => !isSparedSurname(word))
    .join(' ');
}

/**
 * `containsBanned` for somebody's name (a display name or a username): the
 * spared surnames are left out before the patterns run, everything else in the
 * name is checked as usual.
 */
export function containsBannedName(text: string): boolean {
  return containsBanned(withoutSparedSurnames(text));
}

/**
 * `containsBanned` for a çelınc's title, reward or penalty. The spared surnames
 * pass as in a name ("Topal vs Kıroğlu"), and the threats that are everyday
 * workout talk (`THREAT_IDIOMS`: "Sigarayı kesicem", "Öldürücü 10K haftası",
 * "Kafanı dağıt yürüyüşü") count only when the text also names someone
 * ("Seni keserim"). Every family insult and slur is checked as usual.
 */
export function containsBannedTitle(text: string): boolean {
  const normalized = normalizeForBanned(withoutSparedSurnames(text));
  if (!normalized) return false;
  const aimed = AIMED_AT_SOMEONE.test(normalized);
  return BANNED_PATTERNS.some((pattern) => (aimed || !THREAT_IDIOMS.includes(pattern)) && pattern.test(normalized));
}

/**
 * `name` with its spared surnames swapped for "Kanka" and every other word kept:
 * a laf's finished sentence is checked with this, so "{loser}'a koydum" goes to
 * Veli Topal while the rest of a name ("Karını" + "{winner} sikerim") is read
 * with the laf around it. `keepFirst` / `keepLast` leave the first or last word
 * as it is, where the laf glues letters onto it ("{loser}lar" makes "Topallar").
 */
export function maskSparedSurnames(name: string, options: { keepFirst?: boolean; keepLast?: boolean } = {}): string {
  const parts = name.split(/([\s_]+)/);
  return parts
    .map((part, index) => {
      if (index % 2 === 1 || !isSparedSurname(part)) return part;
      if ((options.keepFirst && index === 0) || (options.keepLast && index === parts.length - 1)) return part;
      return 'Kanka';
    })
    .join('');
}
