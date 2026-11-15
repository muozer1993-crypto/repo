import { describe, expect, it } from 'vitest';
import { approximateGraphemeCount, countGraphemes, foldUsername, hasVisibleChar, singleLine, stripInvisible } from '../text';

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

  it('removes bidi overrides and isolates and control characters, but keeps line breaks for the caller', () => {
    const rlo = String.fromCharCode(0x202e);
    expect(stripInvisible(`Ali${rlo}`)).toBe('Ali');
    expect(stripInvisible(String.fromCharCode(0x202a, 0x202b, 0x202c, 0x202d, 0x2066, 0x2067, 0x2068, 0x2069))).toBe('');
    expect(stripInvisible(`A${String.fromCharCode(0)}B${String.fromCharCode(0x1b)}C${String.fromCharCode(0x7f, 0x85, 0x9f)}`)).toBe('ABC');
    expect(stripInvisible('Ali\tVeli\nCan\r')).toBe('Ali\tVeli\nCan\r');
    // Turkish letters sit next to the C1 block and must survive it
    expect(stripInvisible('ÇĞİÖŞÜçğıöşü âîû')).toBe('ÇĞİÖŞÜçğıöşü âîû');
  });

  it('does not take the Hangul fillers or the blank braille pattern for something visible', () => {
    for (const blank of [0x3164, 0xffa0, 0x115f, 0x1160, 0x2800]) {
      expect(hasVisibleChar(String.fromCharCode(blank))).toBe(false);
      expect(hasVisibleChar(`${String.fromCharCode(blank)} ${String.fromCharCode(blank)}`)).toBe(false);
    }
    expect(hasVisibleChar(`${String.fromCharCode(0x3164)}a`)).toBe(true);
    expect(hasVisibleChar('한')).toBe(true);
  });
});

describe('singleLine', () => {
  it('folds every run of whitespace, line breaks included, into one space', () => {
    expect(singleLine('Ali\n\nVeli')).toBe('Ali Veli');
    expect(singleLine('  Ali \t Veli\r\n')).toBe('Ali Veli');
    expect(singleLine(`Ali${String.fromCharCode(0x2028)}Veli`)).toBe('Ali Veli');
    expect(singleLine(`👨${ZWJ}👩`)).toBe(`👨${ZWJ}👩`);
    expect(singleLine('\n')).toBe('');
  });
});

describe('foldUsername', () => {
  const COMBINING_DOT = String.fromCharCode(0x307);

  it('folds Turkish letters instead of leaving them for the regex to refuse', () => {
    expect(foldUsername('Şeyma')).toBe('seyma');
    expect(foldUsername('Çağrı_99')).toBe('cagri_99');
    expect(foldUsername('ÖMÜR')).toBe('omur');
    expect(foldUsername('Işık')).toBe('isik');
    expect(foldUsername('Âlim')).toBe('alim');
  });

  it('turns both capital i spellings into a plain i', () => {
    expect(foldUsername(' İSMAİL ')).toBe('ismail');
    // what toLowerCase() made of "İsmail", and what the 1.0 app still sends
    expect(foldUsername(`i${COMBINING_DOT}smail`)).toBe('ismail');
    expect('İsmail'.toLowerCase()).toBe(`i${COMBINING_DOT}smail`);
  });

  it('drops spaces, invisible characters and other accents', () => {
    expect(foldUsername('ali veli')).toBe('aliveli');
    expect(foldUsername(`ali${ZWSP}${SOFT_HYPHEN}`)).toBe('ali');
    expect(foldUsername(`ali${String.fromCharCode(0x202e)}`)).toBe('ali');
    expect(foldUsername('José')).toBe('jose');
  });

  it('leaves what is no letter at all for the schema to refuse', () => {
    expect(foldUsername('a.b')).toBe('a.b');
    expect(foldUsername('🍆🍆🍆')).toBe('🍆🍆🍆');
    expect(foldUsername('mustafa_42')).toBe('mustafa_42');
    expect(foldUsername(foldUsername('Şeyma'))).toBe('seyma');
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
