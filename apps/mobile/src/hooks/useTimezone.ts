import type { ChallengeSummary } from '@koydum/shared';

import { deviceTimezone, useAuth } from '@/store/auth';
import { resolveTimezone } from '@/utils/datetime';

/**
 * The IANA zone every screen counts days in: the one on the account, falling
 * back to the device and finally to `Europe/Istanbul`. Inside one çelınc the
 * reader's days are its own (`useChallengeTimezone`).
 *
 * `me.timezone` is a free-form string on the server, so it is validated here
 * rather than at each call site — `todayKey('asdf')` throws mid-render.
 */
export function useTimezone(): string {
  const stored = useAuth((state) => state.me?.timezone ?? null);
  return resolveTimezone(stored, deviceTimezone());
}

/**
 * The zone one çelınc's days are counted in for the reader: the one pinned
 * when they joined (`myTimezone`). A login after travel or "Cihazdan güncelle"
 * moves `me.timezone` but not this, and the server judges the çelınc by this
 * one, so its "today" (the check-in, the yes/no day, a focus session, the
 * entry modal's days) comes from here or the server refuses the day. Before
 * the çelınc loads, and from an older server, the account's zone.
 */
export function useChallengeTimezone(summary: Pick<ChallengeSummary, 'myTimezone'> | undefined): string {
  const account = useTimezone();
  return resolveTimezone(summary?.myTimezone, account);
}
