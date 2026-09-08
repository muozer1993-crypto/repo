import { ApiError } from '@/lib/api';

/**
 * The message to show the user for a failed request.
 *
 * `ApiError.message` is already Turkish and written for the person reading it,
 * so it wins; anything else (a TypeError, a thrown string) is not, and gets the
 * caller's fallback instead.
 */
export function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}
