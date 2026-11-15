/**
 * Small Unicode text helpers shared by the zod schemas and the banned-word filter.
 *
 * Engine independent: `Intl.Segmenter` is used when the runtime has it (Node, modern
 * browsers) and a code-point approximation that understands emoji sequences is the
 * fallback (Hermes builds without full Intl).
 */

/**
 * Invisible formatting code points that never render on their own: the C0 and C1
 * control characters, soft hyphen, Arabic letter mark, Mongolian vowel separator,
 * zero-width space / non-joiner, LRM/RLM, the bidi embeddings, overrides and
 * isolates, word joiner, invisible operators and the BOM. A right-to-left override
 * in a name turned the rest of every push line it appeared in backwards.
 *
 * ZWJ (U+200D) is deliberately NOT included — it glues emoji sequences (👨‍👩‍👧) together.
 * Neither are tab, line feed, vertical tab, form feed and carriage return: they are
 * whitespace, which `trim`, `singleLine` and the banned-word filter already handle,
 * and dropping them would glue "Ali\vVeli" into one word.
 */
export const INVISIBLE_CHARS_REGEX =
  /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Remove the characters matched by `INVISIBLE_CHARS_REGEX`. */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE_CHARS_REGEX, '');
}

/**
 * Turkish letters to their plain Latin twins (plus the circumflexed ones of
 * loanwords). Shared by the banned-word filter and `foldUsername`.
 */
export const TURKISH_FOLD: Record<string, string> = {
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

/**
 * The one spelling a username is stored, looked up and compared in: ASCII, lowercase,
 * no spaces. To a Turkish speaker ş IS a lowercase letter, so "Şeyma" becomes `seyma`
 * instead of being told to use "küçük harf".
 *
 * `toLowerCase()` alone turns "İsmail" into "i̇smail" (i + U+0307), which matched
 * nobody: a friend whose keyboard capitalised the first letter could not log in.
 * Stripping the combining marks after NFD drops that dot along with any other accent
 * (José → jose). Whatever is left may still be invalid ("a.b"); the schema decides.
 */
export function foldUsername(raw: string): string {
  return stripInvisible(raw)
    .toLowerCase()
    .replace(/[ışğüöçâîû]/g, (ch) => TURKISH_FOLD[ch] ?? ch)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '');
}

/**
 * Letters and symbols that draw nothing: the Hangul fillers (U+3164 is the "görünmez
 * nick" every Turkish gamer knows) and the blank braille pattern. Unicode files them
 * as a letter and a symbol, so they passed for a name on their own.
 */
const BLANK_GLYPHS_REGEX = /[\u115F\u1160\u3164\uFFA0\u2800]/g;

/** True when `text` contains at least one letter, digit, punctuation or symbol (emoji are symbols) that draws something. */
export function hasVisibleChar(text: string): boolean {
  return /[\p{L}\p{N}\p{P}\p{S}]/u.test(text.replace(BLANK_GLYPHS_REGEX, ''));
}

/**
 * One line: every run of whitespace (line breaks included) becomes a single space,
 * the ends trimmed. For what is shown in one line: names, titles, a push body.
 */
export function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

let graphemeSegmenter: Intl.Segmenter | null | undefined;

function getSegmenter(): Intl.Segmenter | null {
  if (graphemeSegmenter === undefined) {
    try {
      graphemeSegmenter =
        typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
          ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
          : null;
    } catch {
      graphemeSegmenter = null;
    }
  }
  return graphemeSegmenter;
}

/** Code points that attach to the previous grapheme instead of starting a new one. */
function isGraphemeExtender(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritical marks
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) || // enclosing marks (keycap U+20E3)
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors (emoji presentation)
    (cp >= 0x1f3fb && cp <= 0x1f3ff) || // skin tone modifiers
    (cp >= 0xe0020 && cp <= 0xe007f) || // tag characters (subdivision flags)
    (cp >= 0xe0100 && cp <= 0xe01ef) // variation selectors supplement
  );
}

/**
 * Grapheme count without `Intl.Segmenter`: ZWJ sequences, modifiers, variation
 * selectors, keycaps and regional-indicator flag pairs each count as one.
 */
export function approximateGraphemeCount(text: string): number {
  let count = 0;
  let joinNext = false;
  let openFlag = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x200d) {
      joinNext = true;
      continue;
    }
    if (isGraphemeExtender(cp)) continue;
    if (joinNext) {
      joinNext = false;
      continue;
    }
    const isRegionalIndicator = cp >= 0x1f1e6 && cp <= 0x1f1ff;
    if (isRegionalIndicator && openFlag) {
      openFlag = false;
      continue;
    }
    openFlag = isRegionalIndicator;
    count += 1;
  }
  return count;
}

/** Number of user-perceived characters (grapheme clusters) in `text`. */
export function countGraphemes(text: string): number {
  if (text.length === 0) return 0;
  const segmenter = getSegmenter();
  if (segmenter) {
    let count = 0;
    for (const _segment of segmenter.segment(text)) count += 1;
    return count;
  }
  return approximateGraphemeCount(text);
}
