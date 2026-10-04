/* eslint-disable import/first -- the jest.mock call must run before the store is imported */
/**
 * Logging out takes the account's phone-side alarms with it: a phone handed
 * to someone else, or signed into another account, must not keep ringing
 * "30 dakikan kaldı" for the old account's check-ins for two more weeks.
 */
const mockCancelAllReminders = jest.fn(async () => {});
jest.mock('@/services/reminders', () => ({ cancelAllReminders: () => mockCancelAllReminders() }));

import type { Me } from '@koydum/shared';

import { useAuth } from '@/store/auth';

const ME = { id: 'me-1', username: 'mustafa', displayName: 'Mustafa' } as Me;

describe('logout', () => {
  it("cancels the phone's own reminders", async () => {
    useAuth.setState({ token: 'tok', me: ME });
    global.fetch = jest.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;

    await useAuth.getState().logout();

    expect(useAuth.getState().token).toBeNull();
    expect(mockCancelAllReminders).toHaveBeenCalledTimes(1);
  });

  it('still logs out when cancelling the alarms fails', async () => {
    mockCancelAllReminders.mockRejectedValueOnce(new Error('no module'));
    useAuth.setState({ token: 'tok', me: ME });

    await useAuth.getState().logout();

    expect(useAuth.getState().token).toBeNull();
  });
});
