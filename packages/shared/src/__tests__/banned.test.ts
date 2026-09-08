import { describe, expect, it } from 'vitest';
import { BANNED_PATTERNS, containsBanned, findBanned, normalizeForBanned } from '../banned';

describe('normalizeForBanned', () => {
  it('folds Turkish letters, case and leet-speak', () => {
    expect(normalizeForBanned('ŞĞÜÖÇIİ şğüöçıi')).toBe('sguocii sguocii');
    expect(normalizeForBanned('  Çok   boşluk\n var ')).toBe('cok bosluk var');
    expect(normalizeForBanned('an@n 4n4n')).toBe('anan anan');
    expect(normalizeForBanned('')).toBe('');
  });
});

describe('containsBanned', () => {
  it('blocks family insults in any casing, including Turkish capital I / İ', () => {
    for (const text of ['ananı', 'ANANI', 'ANANİ', 'anANı', 'Anan', 'anneni', 'ananızı', 'bacını', 'Bacın', 'BACINI', 'avradını', 'sülaleni', 'orospu çocuğu', 'Orospu Cocugu', 'karını sikeyim', 'aileni sikeyim', 'piç']) {
      expect(containsBanned(text), text).toBe(true);
    }
  });

  it('blocks threats of violence and sexual violence', () => {
    for (const text of ['seni öldürürüm', 'ÖLDÜRCEM', 'gebertirim', 'geber', 'kafanı kırarım', 'ırzına geçerim', 'tecavüz', 'bıçaklarım seni']) {
      expect(containsBanned(text), text).toBe(true);
    }
  });

  it('blocks slurs against protected groups', () => {
    for (const text of ['ibne', 'İBNE', 'götveren', 'göt veren', 'gerizekalı', 'geri zekalı', 'mongol', 'spastik', 'özürlü', 'gavur', 'kıro', 'kürt köpeği', 'ermeni dölü', 'pis suriyeli', 'çıfıt', 'kızılbaş']) {
      expect(containsBanned(text), text).toBe(true);
    }
  });

  it('allows generic swearing and everyday words', () => {
    for (const text of ['amk', 'lan', 'sikeyim', 'yedin mi lan', 'koydum mu amk', 'mal', 'yarrak gibi koştun', 'ananas', 'bacım nasıl', 'karın ağrısı', 'kurt', 'ailen nasıl', 'sülalesi', 'yezidi', 'engelli', 'seni öldü', 'Kalk lan yürü', '', '   ']) {
      expect(containsBanned(text), text).toBe(false);
    }
  });

  it('survives leet-speak and separators inside words', () => {
    expect(containsBanned('an@nı')).toBe(true);
    expect(containsBanned('4nan')).toBe(true);
    expect(containsBanned('ibn3')).toBe(true);
    expect(containsBanned('an​an')).toBe(true); // zero-width space
  });
});

describe('findBanned', () => {
  it('returns the normalized fragments that matched, de-duplicated', () => {
    expect(findBanned('ANANI sikeyim, ananı!')).toEqual(['anani']);
    expect(findBanned('seni öldürürüm ibne')).toEqual(['oldururum', 'ibne']);
    expect(findBanned('koydum mu amk')).toEqual([]);
  });

  it('is stateless between calls', () => {
    expect(containsBanned('ibne')).toBe(true);
    expect(containsBanned('ibne')).toBe(true);
    expect(findBanned('ibne ibne')).toEqual(['ibne']);
  });
});

describe('BANNED_PATTERNS', () => {
  it('are non-global regexes written for normalized ASCII text', () => {
    expect(BANNED_PATTERNS.length).toBeGreaterThan(30);
    for (const p of BANNED_PATTERNS) {
      expect(p.global, p.source).toBe(false);
      expect(p.source).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});
