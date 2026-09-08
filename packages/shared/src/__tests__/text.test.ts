import { describe, expect, it } from 'vitest';
import { approximateGraphemeCount, countGraphemes, hasVisibleChar, stripInvisible } from '../text';

const ZWJ = String.fromCharCode(0x200d);
const ZWSP = String.fromCharCode(0x200b);
const SOFT_HYPHEN = String.fromCharCode(0xad);
const VS16 = String.fromCharCode(0xfe0f);
const KEYCAP = String.fromCharCode(0x20e3);

describe('stripInvisible / hasVisibleChar', () => {
  it('removes zero-width and soft-hyphen characters but keeps ZWJ (emoji glue)', () => {
    expect(stripInvisible(`a${ZWSP}b${SOFT_HYPHEN}c${String.fromCharCode(0xfeff, 0x200c, 0x2060)}d`)).toBe('abcd');
    expect(stripInvisible(`👨${ZWJ}👩`)).toBe(`👨${ZWJ}👩`);
    expect(stripInvisible('')).toBe('');
  });

  it('detects visible content', () => {
    expect(hasVisibleChar('a')).toBe(true);
    expect(hasVisibleChar('🍆')).toBe(true);
    expect(hasVisibleChar('7')).toBe(true);
    expect(hasVisibleChar('!')).toBe(true);
    expect(hasVisibleChar('ş')).toBe(true);
    expect(hasVisibleChar('')).toBe(false);
    expect(hasVisibleChar('   ')).toBe(false);
    expect(hasVisibleChar(ZWJ + ZWSP)).toBe(false);
  });
});

describe('countGraphemes', () => {
  const cases: [string, number][] = [
    ['', 0],
    ['abcd', 4],
    ['🍆', 1],
    ['👍🏽', 1],
    ['🇹🇷', 1],
    ['🇹🇷🇩🇪', 2],
    [`👨${ZWJ}👩${ZWJ}👧`, 1],
    [`👨🏻${ZWJ}👩🏻${ZWJ}👧🏻${ZWJ}👦🏻`, 1],
    [`1${VS16}${KEYCAP}`, 1],
    ['🍆🔥💀👑', 4],
    [`e${String.fromCharCode(0x301)}`, 1],
    [`❤${VS16}`, 1],
  ];

  it.each(cases)('counts %j as %i grapheme(s) with Intl.Segmenter and with the fallback', (text, expected) => {
    expect(countGraphemes(text)).toBe(expected);
    expect(approximateGraphemeCount(text)).toBe(expected);
  });

  it('uses Intl.Segmenter on this runtime', () => {
    expect(typeof Intl.Segmenter).toBe('function');
  });
});
