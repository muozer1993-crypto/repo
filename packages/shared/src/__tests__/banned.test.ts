import { describe, expect, it } from 'vitest';
import { BANNED_PATTERNS, containsBanned, findBanned, normalizeForBanned } from '../banned';

const SOFT_HYPHEN = String.fromCharCode(0xad);
const ZWSP = String.fromCharCode(0x200b);

describe('normalizeForBanned', () => {
  it('folds Turkish letters, case and leet-speak', () => {
    expect(normalizeForBanned('ŞĞÜÖÇIİ şğüöçıi')).toBe('sguocii sguocii');
    expect(normalizeForBanned('  Çok   boşluk\n var ')).toBe('cok bosluk var');
    expect(normalizeForBanned('an@n 4n4n')).toBe('anan anan');
    expect(normalizeForBanned('')).toBe('');
  });

  it('keeps the innocent sık- stem apart from the sik- verb when the dotless ı is there', () => {
    expect(normalizeForBanned('Sıkıntı SIKINTI sıkıldım sıkıştı sıkı sıkma sıkça sık')).toBe('sykinti sykinti sykildim sykisti syki sykma sykca syk');
    expect(normalizeForBanned('sıkeyim SIKEYIM sıktım SIKTIM sikeyim siktir sikinti')).toBe('sikeyim sikeyim siktim siktim sikeyim siktir sikinti');
  });

  it('marks piç (with ç) so bare ASCII pic stays an English word', () => {
    expect(normalizeForBanned('piç PİÇ PIÇ p1ç piçi pic picture')).toBe('pich pich pich pich pici pic picture');
  });

  it('turns digits and underscores into separators and drops soft hyphens', () => {
    expect(normalizeForBanned('an_an 2ibne anan9 k1r0')).toBe('an an ibne anan kiro');
    expect(normalizeForBanned(`an${SOFT_HYPHEN}an a${ZWSP}nan`)).toBe('anan anan');
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
    for (const text of [
      'amk', 'lan', 'sikeyim', 'yedin mi lan', 'koydum mu amk', 'mal', 'yarrak gibi koştun', 'ananas', 'bacım nasıl', 'karın ağrısı', 'kurt', 'ailen nasıl', 'sülalesi', 'yezidi', 'engelli', 'seni öldü', 'Kalk lan yürü', '', '   ',
      // sık- (boredom / tightness / squeezing) after a family word is not the sik- verb
      'ailen sıkıntıda mı', 'oğlun sıkıldı mı', 'kızın sıkıştı', 'karın sıkı', 'soyun sıkıcı', 'AİLEN SIKINTIDA MI', 'sıkıntı yok', 'çok sıkıcı bir çelinç', 'boğazın sıkıştı', 'boğazına sıkıştı',
      // knives and pictures and traditions
      'bıçaklar keskin', 'bıçakla kesmek', 'pic', 'resim pic attım', 'anane', 'ananevi',
      // idioms in the past tense: wore you out / gave you a hard time
      'canını çıkardım koşarken', 'canını yaktım koşuda',
    ]) {
      expect(containsBanned(text), text).toBe(false);
    }
  });

  it('survives leet-speak and separators inside words', () => {
    expect(containsBanned('an@nı')).toBe(true);
    expect(containsBanned('4nan')).toBe(true);
    expect(containsBanned('ibn3')).toBe(true);
    expect(containsBanned(`an${ZWSP}an`)).toBe(true); // zero-width space
    expect(containsBanned(`an${SOFT_HYPHEN}an`)).toBe(true); // soft hyphen
    for (const text of ['_ibne', '2ibne', '9ibne', 'anan2', 'anan9', 'ibne_', 'göt-veren', 'göt_veren', 'göt.veren', 'geri-zekalı', 'orospu-çocuğu', 'kız-kardeşin', 'engelli-mi', 'down_sendromlu', 'K1R0', 'p1ç']) {
      expect(containsBanned(text), text).toBe(true);
    }
  });

  it('still blocks the sik / piç / threat forms it must, in every spelling', () => {
    for (const text of [
      'ananı sikeyim', 'ANANI SIKEYIM', 'karını siktim', 'KARINI SIKTIM', 'ailen sikilsin', 'kızını sikerim', 'karını sıkeyim',
      'boğazını sıkarım', 'boğazını keserim', 'kurşun sıkarım', 'kurşun yersin',
      'canını alırım', 'canını çıkarırım', 'canını yakacağım', 'canını çıkartırım',
      'seni bıçaklarım', 'bıçaklayacağım seni', 'bıçaklarım seni', 'seni bıçakla',
      'piç', 'PİÇ', 'PIÇ', 'piçi', 'piçsin', 'piç kurusu', 'pic kurusu', 'picsin', 'kürt piçi', 'ananı', 'anana',
    ]) {
      expect(containsBanned(text), text).toBe(true);
    }
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
