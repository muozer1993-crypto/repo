/**
 * Small Unicode text helpers shared by the zod schemas and the banned-word filter.
 *
 * Engine independent: `Intl.Segmenter` is used when the runtime has it (Node, modern
 * browsers) and a code-point approximation that understands emoji sequences is the
 * fallback (Hermes builds without full Intl).
 */

/**
 * Invisible formatting code points that never render on their own: soft hyphen,
 * Arabic letter mark, Mongolian vowel separator, zero-width space / non-joiner,
 * LRM/RLM, word joiner, invisible operators and the BOM.
 *
 * ZWJ (U+200D) is deliberately NOT included — it glues emoji sequences (👨‍👩‍👧) together.
 */
export const INVISIBLE_CHARS_REGEX = /[\u00AD\u061C\u180E\u200B\u200C\u200E\u200F\u2060-\u2064\uFEFF]/g;

/** Remove the characters matched by `INVISIBLE_CHARS_REGEX`. */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE_CHARS_REGEX, '');
}

/** True when `text` contains at least one letter, digit, punctuation or symbol (emoji are symbols). */
export function hasVisibleChar(text: string): boolean {
  return /[\p{L}\p{N}\p{P}\p{S}]/u.test(text);
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
