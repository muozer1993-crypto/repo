/**
 * Turkish capitals on every engine and every phone.
 *
 * `textTransform: 'uppercase'` is not locale-aware on iOS or the web, and on
 * Android it follows the DEVICE language, so "Yedin" came out as "YEDIN" (read:
 * yedın) and "Hepsini" as "HEPSINI". Hermes has no reliable locale-specific
 * casing either, so the two letters that differ are mapped by hand first.
 */
export function upperTr(text: string): string {
  return text.replace(/i/g, 'İ').replace(/ı/g, 'I').toUpperCase();
}

const BACK_VOWELS = 'aıouâû';
const FRONT_VOWELS = 'eiöüî';

function isVowel(ch: string): boolean {
  return ch.length === 1 && (BACK_VOWELS.includes(ch) || FRONT_VOWELS.includes(ch));
}

/**
 * Names whose last "l" is the soft one of an Arabic loan: they take the front
 * suffix whatever their last vowel, "Kemal'e", "Hilal'e" (as "hilale" does).
 * The spelling cannot tell, and these are the ones a friend is likely to have.
 */
const SOFT_L_NAMES = new Set(['kemal', 'cemal', 'celal', 'bilal', 'hilal', 'nihal', 'ikbal', 'iclal']);

/**
 * A name in the dative, "kime?": Can'a, Gül'e, Ali'ye, Mustafa'ya.
 *
 * The suffix follows the name's last vowel, and a name ending in a vowel takes
 * a buffer "y". A fixed `'a` gave "Mehmet'a" and "Emre'a". Null when the name
 * does not end in a letter or has no Turkish vowel ("🔥", "MSN"): there is no
 * right suffix to guess, so the caller phrases around it ("… için").
 */
export function dativeTr(name: string): string | null {
  const trimmed = name.trim();
  // İ and I first: a plain toLowerCase turns "İ" into "i̇" and "I" into "i"
  const lower = trimmed.replace(/İ/g, 'i').replace(/I/g, 'ı').toLowerCase();
  const last = lower.charAt(lower.length - 1);
  if (!/[a-zçğıöşüâîû]/.test(last)) return null;
  const vowel = [...lower].reverse().find(isVowel);
  if (!vowel) return null;
  const lastWord = lower.slice(lower.lastIndexOf(' ') + 1).replace(/â/g, 'a');
  const suffix = BACK_VOWELS.includes(vowel) && !SOFT_L_NAMES.has(lastWord) ? 'a' : 'e';
  return `${trimmed}'${isVowel(last) ? 'y' : ''}${suffix}`;
}
