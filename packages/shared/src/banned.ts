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
 *   2. lowercased with Turkish rules (I→ı, İ→i) and light leet-speak folded,
 *   3. two ambiguous Turkish stems marked (see below),
 *   4. Turkish letters folded to ASCII (ı→i, ş→s, ğ→g, ü→u, ö→o, ç→c), diacritics stripped,
 *   5. leftover digits and underscores turned into spaces so `\b` fires around "2ibne" / "_ibne",
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

import { INVISIBLE_CHARS_REGEX } from './text';

const TURKISH_FOLD: Record<string, string> = {
  ı: 'i',
  ş: 's',
  ğ: 'g',
  ü: 'u',
  ö: 'o',
  ç: 'c',
  â: 'a',
  î: 'i',
  û: 'u',
};

const LEET_FOLD: Record<string, string> = {
  '@': 'a',
  $: 's',
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
};

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
    .replace(/İ/g, 'i') // Turkish casing first: toLowerCase() would turn İ into "i̇" and I into "i"
    .replace(/I/g, 'ı')
    .toLowerCase()
    .replace(/[@$01345]/g, (ch) => LEET_FOLD[ch] ?? ch)
    .replace(INNOCENT_SIK_REGEX, 'syk')
    .replace(PIC_REGEX, 'pich')
    .replace(/[ışğüöçâîû]/g, (ch) => TURKISH_FOLD[ch] ?? ch)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip any remaining diacritics
    .replace(/[0-9_]/g, ' ') // not folded by leet → word separators, so \b works
    .replace(/\s+/g, ' ')
    .trim();
}

// Family nouns that are an insult on their own once they carry a "your" possessive.
const FAMILY_SUFFIX = '(?:i|in|ini|inin|a|e|la|le|dan|den|da|de|im|iz|izi|izin|iza|ize|lar|lari|larin|larini|lara)?';

// Verb stems used to "complete" ambiguous family words (karın, ailen, soyun ...).
const SEX_VERB = '(?:sik|sok(?:ay|ar)|becer)';

const ETHNIC_GROUP = '(?:kurt|kurd|ermeni|rum|yahudi|arap|arab|yunan|suriyeli|afgan|cingene|roman|alevi|sunni|zenci|laz|cerkez)';

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
  /\bpic(?:h|sin|siniz|in|i|ler|lerin|leri|kurusu|kurusun)\b/,
  /\bkahpenin\W+(?:evlad|cocu|dol)\w*/,
  /\bdol(?:un|u|lerin|leri)\W+(?:bozuk|bozugu)\w*/,
  /\bveled(?:i)?\W*zina\w*/,

  // --- threats of violence / sexual violence -------------------------------
  /\boldur\w*/, // öldürürüm, öldüreceğim, öldürcem, öldürmek
  /\bgeber\w*/, // geber, gebertirim, geberesice
  /\bkes(?:erim|ecegim|icem|cem|iyim|ecem)\b/,
  /\bbogar(?:im|iz|cam|cem|acagim)\b/,
  // "boğazını sıkarım / keserim" — but not "boğazın(a) sıkıştı" (stuck in your throat)
  /\bbogazin\w*\W*(?:kes|s[iy]k(?!is))\w*/,
  // Verb forms only: "bıçaklar keskin" (knives) and "bıçakla kesmek" (cut with a knife) pass
  /\bbicakla(?:rim|riz|yacagim|yacagiz|yacam|yacaz|yacak|cam|cem|dim|dik|mak|yim|yayim|yalim)\b/,
  /\bseni\W+bicakla\w*/,
  /\bbicakla\w*\W+seni\b/,
  /\bkursun\w*\W*(?:s[iy]k|yersin|yiyeceksin|dizer|dizerim)\w*/,
  /\bkafa(?:ni|nizi|sini)\W*(?:kir|kopar|ez|patlat|ucur|dagit|yar)\w*/,
  // Future/aorist threat forms only: "canını çıkardım koşarken" (wore you out) is an idiom
  /\bcan(?:ini|inizi)\W*(?:al|yak|cikar)(?:ir|ar|acag|acak|cam|cem|icam|icem|tir|sin)\w*/,
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
