/* eslint-disable import/first -- the jest.mock calls must run before the module under test */
/**
 * The screen-time sync is the twin of the steps sync: on a phone that can read
 * screen time it posts the last days and refreshes the çelınc queries; on any
 * other phone it is a quiet no-op, never an error the caller has to handle.
 */

jest.mock('@/services/screenTime', () => ({
  getScreenTimeAvailability: jest.fn(async () => ({ available: false, reason: 'ios' })),
  getDailyScreenMinutes: jest.fn(async () => []),
}));

import { QueryClient } from '@tanstack/react-query';

import type { ApiClient } from '@/lib/api';
import { getDailyScreenMinutes, getScreenTimeAvailability } from '@/services/screenTime';
import { syncScreenTimeNow } from '@/services/screenTimeSync';

const availability = getScreenTimeAvailability as unknown as jest.Mock;
const dailyMinutes = getDailyScreenMinutes as unknown as jest.Mock;

function fakeClient() {
  const syncScreenTime = jest.fn(async (days: { dayKey: string; minutes: number }[]) => ({ updated: days.length }));
  return { client: { syncScreenTime } as unknown as ApiClient, syncScreenTime };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('syncScreenTimeNow', () => {
  it('does nothing on a phone that cannot read screen time', async () => {
    availability.mockResolvedValue({ available: false, reason: 'ios' });
    const { client, syncScreenTime } = fakeClient();
    const queryClient = new QueryClient();
    const spy = jest.spyOn(queryClient, 'invalidateQueries');

    const result = await syncScreenTimeNow({ client, queryClient });
    expect(result).toEqual({ updated: 0, days: 0 });
    expect(syncScreenTime).not.toHaveBeenCalled();
    expect(dailyMinutes).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  it('posts what the phone reported, capped at a day, and refreshes the çelınc queries', async () => {
    availability.mockResolvedValue({ available: true, source: 'usage_stats' });
    dailyMinutes.mockResolvedValue([
      { dayKey: '2026-01-05', minutes: 187 },
      { dayKey: '2026-01-04', minutes: 2000 },
    ]);
    const { client, syncScreenTime } = fakeClient();
    const queryClient = new QueryClient();
    const spy = jest.spyOn(queryClient, 'invalidateQueries');
    const refreshMe = jest.fn(async () => undefined);

    const result = await syncScreenTimeNow({ client, queryClient, refreshMe });
    expect(syncScreenTime).toHaveBeenCalledWith([
      { dayKey: '2026-01-05', minutes: 187 },
      { dayKey: '2026-01-04', minutes: 1440 },
    ]);
    expect(result).toEqual({ updated: 2, days: 2 });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['challenges'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['challenge'] });
    expect(refreshMe).toHaveBeenCalledTimes(1);
  });

  it('asks the device for a week by default and never sends more than the server accepts', async () => {
    availability.mockResolvedValue({ available: true, source: 'usage_stats' });
    dailyMinutes.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => ({ dayKey: `2026-01-${String(20 - i).padStart(2, '0')}`, minutes: i }))
    );
    const { client, syncScreenTime } = fakeClient();

    await syncScreenTimeNow({ client, queryClient: new QueryClient() });
    expect(dailyMinutes).toHaveBeenCalledWith(7);
    expect(syncScreenTime.mock.calls[0][0]).toHaveLength(14);
  });

  it('reports an empty device honestly instead of calling the server', async () => {
    availability.mockResolvedValue({ available: true, source: 'usage_stats' });
    dailyMinutes.mockResolvedValue([]);
    const { client, syncScreenTime } = fakeClient();

    const result = await syncScreenTimeNow({ client, queryClient: new QueryClient() });
    expect(result).toEqual({ updated: 0, days: 0 });
    expect(syncScreenTime).not.toHaveBeenCalled();
  });
});
