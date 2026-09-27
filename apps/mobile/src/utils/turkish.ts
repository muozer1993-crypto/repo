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
