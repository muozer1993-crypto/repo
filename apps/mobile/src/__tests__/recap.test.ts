import { parseRecapData } from '@/utils/recap';

const GOOD = {
  weekKey: '2026-01-11',
  weekStart: '2026-01-05',
  weekEnd: '2026-01-11',
  wins: 2,
  losses: 1,
  ties: 0,
  steps: 22200,
  active: 1,
  highlights: ['👑 Haftanın kralı sensin.', '', 42],
};

describe('parseRecapData', () => {
  it('keeps the numbers and the ready-made lines', () => {
    expect(parseRecapData(GOOD)).toEqual({
      weekStart: '2026-01-05',
      weekEnd: '2026-01-11',
      wins: 2,
      losses: 1,
      ties: 0,
      steps: 22200,
      active: 1,
      highlights: ['👑 Haftanın kralı sensin.'],
    });
  });

  it('refuses anything it cannot draw, so the inbox shows the plain text instead', () => {
    expect(parseRecapData(null)).toBeNull();
    expect(parseRecapData('recap')).toBeNull();
    expect(parseRecapData({ ...GOOD, wins: 'iki' })).toBeNull();
    expect(parseRecapData({ ...GOOD, steps: -5 })).toBeNull();
    expect(parseRecapData({ ...GOOD, weekStart: '2026-02-30' })).toBeNull();
  });

  it('treats missing extras as empty', () => {
    const { active: _active, highlights: _highlights, ...bare } = GOOD;
    expect(parseRecapData(bare)).toMatchObject({ active: 0, highlights: [] });
  });
});
