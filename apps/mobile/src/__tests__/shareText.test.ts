import { resultShareText, type ResultShareInput } from '@/utils/shareText';

const TUNNEL = 'https://tatli-koydum.trycloudflare.com/davet/KOY123';

/** Ali won a four-way step çelınc; the reader (Mustafa) came second. */
function input(overrides: Partial<ResultShareInput> = {}): ResultShareInput {
  return {
    level: 2,
    title: 'Haftalık Adım',
    typeEmoji: '🚶',
    range: '7 Eylül – 10 Eylül',
    ranked: [
      { rank: 1, name: 'Ali', score: '15.000 adım' },
      { rank: 2, name: 'Mustafa', score: '12.430 adım' },
      { rank: 3, name: 'Veli', score: '3.000 adım' },
      { rank: 4, name: 'Cem', score: '1.200 adım' },
    ],
    isTie: false,
    winnerName: 'Ali',
    iWon: false,
    myRank: 2,
    link: TUNNEL,
    ...overrides,
  };
}

describe('resultShareText', () => {
  it('writes the podium in finishing order, medals first and a number after the third', () => {
    expect(resultShareText(input())).toBe(
      [
        '🚶 Haftalık Adım bitti (7 Eylül – 10 Eylül)',
        '🥇 Ali · 15.000 adım',
        '🥈 Mustafa · 12.430 adım',
        '🥉 Veli · 3.000 adım',
        '4. Cem · 1.200 adım',
        '',
        'Bu sefer Ali koydu, yedik.',
        `Sıradakine sen de gel: ${TUNNEL}`,
      ].join('\n')
    );
  });

  it('hands both co-leaders of a tie a gold medal and names no winner', () => {
    const text = resultShareText(
      input({
        ranked: [
          { rank: 1, name: 'Ali', score: '9.000 adım' },
          { rank: 1, name: 'Mustafa', score: '9.000 adım' },
        ],
        isTie: true,
        winnerName: null,
        myRank: 1,
      })
    );
    expect(text).toContain('🥇 Ali · 9.000 adım\n🥇 Mustafa · 9.000 adım');
    expect(text).toContain('Berabere bitti, kimse koyamadı.');
    expect(text).not.toContain('Ali koydu');
  });

  it('speaks at the sender’s level', () => {
    expect(resultShareText(input({ level: 1 }))).toContain('Kazanan Ali, tebrikler.');
    expect(resultShareText(input({ level: 3 }))).toContain('Bu sefer Ali sapladı, yedik 🍆');
    expect(resultShareText(input({ level: 3, isTie: true, winnerName: null, myRank: 1 }))).toContain(
      'Berabere bitti, ortada sahipsiz bir 🍆 kaldı.'
    );
    // without the link, whose host says "koydum" on its own
    const nazik = resultShareText(input({ level: 1, link: null }));
    expect(nazik).not.toContain('🍆');
    expect(nazik).not.toMatch(/koy|yedik/);
  });

  it('owns up to the loss when the sender finished behind a shared first place', () => {
    const behind = (level: 1 | 2 | 3) =>
      resultShareText(
        input({
          level,
          ranked: [
            { rank: 1, name: 'Ali', score: '9.000 adım' },
            { rank: 1, name: 'Veli', score: '9.000 adım' },
            { rank: 3, name: 'Mustafa', score: '3.000 adım' },
          ],
          isTie: true,
          winnerName: null,
          myRank: 3,
        })
      );
    expect(behind(1)).toContain('Ali ve Veli berabere kaldı, ben 3. oldum.');
    expect(behind(2)).toContain('Ali ve Veli berabere kaldı, ben 3. oldum, yedik.');
    expect(behind(3)).toContain('Ali ve Veli berabere kaldı, ben 3. oldum, 🍆 bana kaldı.');
    for (const level of [1, 2, 3] as const) expect(behind(level)).not.toContain('Berabere bitti');
  });

  it('gloats in the first person when the sender won', () => {
    const text = resultShareText(input({ iWon: true, winnerName: 'Mustafa' }));
    expect(text).toContain('Koydum, geçmiş olsun.');
    expect(text).not.toContain('yedik');
  });

  it('leaves out a link only the same Wi-Fi or this very phone could open', () => {
    for (const link of ['http://192.168.1.20:4000/davet/KOY123', 'http://localhost:4000/davet/KOY123']) {
      const text = resultShareText(input({ link }));
      expect(text).not.toContain(link);
      expect(text).not.toContain('sen de gel');
      expect(text.endsWith('Bu sefer Ali koydu, yedik.')).toBe(true);
    }
    expect(resultShareText(input({ link: null }))).not.toContain('sen de gel');
  });

  it('leaves the dates out rather than writing empty brackets', () => {
    expect(resultShareText(input({ range: '' })).split('\n')[0]).toBe('🚶 Haftalık Adım bitti');
  });
});
