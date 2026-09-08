import { deviceTimezone, useAuth } from '@/store/auth';
import { resolveTimezone } from '@/utils/datetime';

/**
 * The IANA zone every screen counts days in: the one on the account, falling
 * back to the device and finally to `Europe/Istanbul`.
 *
 * `me.timezone` is a free-form string on the server, so it is validated here
 * rather than at each call site — `todayKey('asdf')` throws mid-render.
 */
export function useTimezone(): string {
  const stored = useAuth((state) => state.me?.timezone ?? null);
  return resolveTimezone(stored, deviceTimezone());
}
