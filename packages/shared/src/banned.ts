/**
 * Content filter for custom taunts.
 *
 * Policy (friends-only crude banter is the product; this is the hard floor):
 *   ALLOWED  generic swearing directed at the loser ("amk", "lan", "sikeyim", "yarrak", "mal"...)
 *   BLOCKED  family insults (anne / bacı / aile / sülale / avrat ...),
 *            threats of violence and sexual violence (öldür*, gebert*, ırz*, tecavüz*),
 *            slurs against protected groups (ethnicity, religion, sexual orientation, disability).
 *
 * Every pattern is written against NORMALIZED text (see `normalizeForBanned`): lowercase,
 * Turkish letters folded to ASCII (ı/İ→i, ş→s, ğ→g, ü→u, ö→o, ç→c), light leet-speak
 * folded, whitespace collapsed. Because the text is ASCII by then, `\b` behaves.
 */

const TURKISH_FOLD: Record<string, string> = {
  ı: 'i',
  İ: 'i',
  I: 'i',
  ş: 's',
  Ş: 's',
  ğ: 'g',
  Ğ: 'g',
  ü: 'u',
  Ü: 'u',
  ö: 'o',
  Ö: 'o',
  ç: 'c',
  Ç: 'c',
  â: 'a',
  Â: 'a',
  î: 'i',
  Î: 'i',
  û: 'u',
  Û: 'u',
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

export function normalizeForBanned(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  return text
    .replace(/[ıİIşŞğĞüÜöÖçÇâÂîÎûÛ]/g, (ch) => TURKISH_FOLD[ch] ?? ch)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip any remaining diacritics
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, '') // zero-width characters
    .replace(/[@$01345]/g, (ch) => LEET_FOLD[ch] ?? ch)
    .replace(/\s+/g, ' ')
    .trim();
}

// Family nouns that are an insult on their own once they carry a "your" possessive.
const FAMILY_SUFFIX = '(?:i|in|ini|inin|a|e|la|le|dan|den|da|de|im|iz|izi|izin|iza|ize|lar|lari|larin|larini|lara)?';

// Verb stems used to "complete" ambiguous family words (karın, ailen, soyun ...).
const SEX_VERB = '(?:sik|s[i]k|sikey|siker|sikt|sikiy|sikim|sokay|sokar|becer)';

export const BANNED_PATTERNS: RegExp[] = [
  // --- family insults ------------------------------------------------------
  new RegExp(`\\b(?:anan|annen|ananiz|anneniz|anacigin|anacigini)${FAMILY_SUFFIX}\\b`),
  new RegExp(`\\b(?:bacin|baciniz|kizkardesin|kizkardesiniz)${FAMILY_SUFFIX}\\b`),
  /\bkiz\s*kardesin\w*/,
  /\bavra[dt](?:ini|ina|inin|in|i|imi)?\b/,
  /\bana\s+avra[dt]\w*/,
  new RegExp(`\\b(?:sulalen|sulaleniz)${FAMILY_SUFFIX}\\b`),
  new RegExp(`\\b(?:karin|karini|karina|ailen|aileni|aileniz|ailenizi|soyun|soyunu|sopunu|ecdadin|ecdadini|olun|olunu|olulerin|olulerini|olmusun|olmusunu|dedeni|nineni|kizini|kizin|oglunu|oglun)\\s+${SEX_VERB}\\w*`),
  /\boros[bp]u\s*(?:cocu|evlad|dol)\w*/,
  /\borsp?u\s*(?:cocu|evlad)\w*/,
  /\bpic(?:sin|siniz|in|i|ler|lerin|kurusu|kurusun)?\b/,
  /\bkahpenin\s+(?:evlad|cocu|dol)\w*/,
  /\bdol(?:un|u|lerin|leri)\s+(?:bozuk|bozugu)\w*/,
  /\bveled(?:i)?\s*zina\w*/,

  // --- threats of violence / sexual violence -------------------------------
  /\boldur\w*/, // öldürürüm, öldüreceğim, öldürcem, öldürmek
  /\bgeber\w*/, // geber, gebertirim, geberesice
  /\bkes(?:erim|ecegim|icem|cem|iyim|ecem)\b/,
  /\bbogar(?:im|iz|cam|cem|acagim)\b/,
  /\bbogazin\w*\s*(?:kes|sik)\w*/,
  /\bbicakla\w*/,
  /\bkursun\w*\s*(?:s[i]k|yersin|yiyeceksin|dizer|dizerim|sikar)\w*/,
  /\bkafa(?:ni|nizi|sini)\s*(?:kir|kopar|ez|patlat|ucur|dagit|yar)\w*/,
  /\bcan(?:ini|inizi)\s*(?:al|yak|cikar)\w*/,
  /\bkan(?:ini|inizi)\s*(?:ic|akit|dok)\w*/,
  /\bmezar(?:ina|a)\s*(?:sok|gom|koy)\w*/,
  /\bgom(?:erim|ecegim|cem|icem|ecem)\s+seni\b/,
  /\bseni\s+gom(?:erim|ecegim|cem|icem|ecem)\b/,
  /\birz\w*/, // ırzına geçmek
  /\btecavuz\w*/,

  // --- slurs against protected groups --------------------------------------
  // Ethnicity / nationality: "<group> dölü/tohumu/piçi/köpeği/bozuntusu"
  /\b(?:kurt|kurd|ermeni|rum|yahudi|arap|arab|yunan|suriyeli|afgan|cingene|roman|alevi|sunni|zenci|laz|cerkez|turk)\s*(?:dol|tohum|pic|kopeg|kopek|bozuntu|it[il]|ibne|serefsiz|pislig|pislik)\w*/,
  /\b(?:pis|serefsiz|kahrolsun|geberesi|gebersin|lanet\s*olsun|hain)\s+(?:kurt|kurd|ermeni|rum|yahudi|arap|arab|yunan|suriyeli|afgan|cingene|roman|alevi|sunni|zenci|laz|cerkez)\w*/,
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
  /\bgot\s*veren\w*/,
  /\bnonos\w*/,
  /\bpust\w*/,
  /\bhomo\b/,
  /\bhomolar\w*/,
  /\bsapkin\w*/,
  // Disability
  /\bgeri\s*zekal\w*/,
  /\bmongol\w*/,
  /\bspastik\w*/,
  /\bozurlu\w*/,
  /\btopal\w*/,
  /\bkotur\w*/,
  /\bengelli\s*(?:misin|mi|gibi)\b/,
  /\bdown\s*(?:sendrom|lu|li)\w*/,
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
