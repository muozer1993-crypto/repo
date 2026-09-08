import { minusMinutes } from '@/services/reminders';

describe('reminder scheduling maths', () => {
  it('subtracts minutes from a HH:mm deadline', () => {
    expect(minusMinutes('07:00', 30)).toEqual({ hour: 6, minute: 30 });
    expect(minusMinutes('23:00', 45)).toEqual({ hour: 22, minute: 15 });
    expect(minusMinutes('09:15', 15)).toEqual({ hour: 9, minute: 0 });
  });

  it('wraps around midnight', () => {
    expect(minusMinutes('00:10', 30)).toEqual({ hour: 23, minute: 40 });
    expect(minusMinutes('00:00', 1)).toEqual({ hour: 23, minute: 59 });
  });

  it('rejects nonsense', () => {
    expect(minusMinutes('24:00', 30)).toBeNull();
    expect(minusMinutes('7:00', 30)).toBeNull();
    expect(minusMinutes('', 30)).toBeNull();
  });
});
