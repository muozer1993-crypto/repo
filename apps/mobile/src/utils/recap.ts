import { isValidDayKey, type RecapData } from '@koydum/shared';

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/**
 * The `data` of a `recap` notification, checked field by field. Anything off
 * (an older server, a hand-edited row) returns null and the inbox falls back
 * to the plain text row, which still carries the whole story in its body.
 */
export function parseRecapData(data: unknown): RecapData | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  const wins = count(raw.wins);
  const losses = count(raw.losses);
  const ties = count(raw.ties);
  const steps = count(raw.steps);
  const active = count(raw.active) ?? 0;
  if (wins === null || losses === null || ties === null || steps === null) return null;
  if (!isValidDayKey(raw.weekStart) || !isValidDayKey(raw.weekEnd)) return null;
  const highlights = Array.isArray(raw.highlights)
    ? raw.highlights.filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
    : [];
  return {
    weekStart: raw.weekStart,
    weekEnd: raw.weekEnd,
    wins,
    losses,
    ties,
    steps,
    active,
    highlights,
  };
}
