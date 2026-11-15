import { Colors } from '@/theme';

/**
 * The app is dark everywhere and gets read outdoors on cheap LCDs, so the text
 * colours are held to WCAG's 4.5:1 for small text against every ground they sit
 * on. A token nudged darker "to look calmer" fails here, not in the sun.
 */

/** WCAG 2 relative luminance of a #RRGGBB colour. */
function luminance(hex: string): number {
  const int = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(int >> 16) & 255, (int >> 8) & 255, int & 255].map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

const GROUNDS = { bg: Colors.bg, surface: Colors.surface, surfaceHigh: Colors.surfaceHigh };

describe('text contrast', () => {
  it('measures the way WCAG does', () => {
    expect(contrast(Colors.white, Colors.black)).toBeCloseTo(21, 5);
    expect(contrast(Colors.black, Colors.white)).toBeCloseTo(21, 5);
    expect(contrast(Colors.bg, Colors.bg)).toBe(1);
  });

  it.each(Object.entries(GROUNDS))('keeps muted and faint text readable on %s', (_name, ground) => {
    expect(contrast(Colors.textMuted, ground)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(Colors.textFaint, ground)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps faint a step quieter than muted', () => {
    expect(luminance(Colors.textFaint)).toBeLessThan(luminance(Colors.textMuted));
  });

  it('gives third place a colour that reads on the podium card and its pedestal', () => {
    expect(contrast(Colors.bronze, Colors.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(Colors.bronze, Colors.surfaceHigh)).toBeGreaterThanOrEqual(4.5);
  });
});
