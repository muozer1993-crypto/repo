import { VULGARITY_LEVELS, type VulgarityLevel } from './types';

export function isVulgarityLevel(value: unknown): value is VulgarityLevel {
  return (VULGARITY_LEVELS as readonly number[]).includes(value as number);
}

/**
 * The recipient's max level always wins: a level-3 taunt sent to someone whose
 * `vulgarityMax` is 1 is delivered at level 1 (SPEC 1.4).
 */
export function clampLevel(requested: VulgarityLevel, recipientMax: VulgarityLevel): VulgarityLevel {
  const req = isVulgarityLevel(requested) ? requested : 1;
  const max = isVulgarityLevel(recipientMax) ? recipientMax : 1;
  return (req <= max ? req : max) as VulgarityLevel;
}
