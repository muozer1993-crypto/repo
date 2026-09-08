/**
 * Taunts ("KOYDUM MU?") and pokes.
 *
 * The single rule that matters: the RECIPIENT's `vulgarity_max` always wins. A level
 * 3 winner writing to a level 1 friend gets a level 1 template — `resolveTauntForRecipient`
 * both clamps the level and swaps the template for one of the same context that the
 * recipient allows. Custom text is clamped the same way and additionally goes through
 * the shared content filter (`containsBanned`).
 */
import {
  LIMITS,
  clampLevel,
  containsBanned,
  formatScore,
  renderTaunt,
  resolveTauntForRecipient,
  tauntContextForMargin,
  tauntsFor,
  winMargin,
  type ChallengeType,
  type ParticipantView,
  type TauntContext,
  type TauntTemplate,
  type TauntVars,
  type VulgarityLevel,
} from '@koydum/shared';
import { newId, nowIso, type ChallengeRow, type Database, type PokeRow, type TauntRow, type UserRow } from '../db/index.js';
import { badRequest, conflict, tooMany } from '../errors.js';
import { notify } from './notifications.js';
import { awardBadges } from './stats.js';
import { computeStandings, typeForChallenge } from './challenges.js';
import { levelOf } from './challengeViews.js';

/**
 * Stable non-cryptographic hash (djb2), so an automatic template pick is the same
 * every time the same pair looks at the same challenge — and reproducible in tests.
 */
export function seedFrom(...parts: string[]): number {
  let hash = 5381;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) hash = ((hash * 33) ^ part.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function scoreOf(standings: ParticipantView[], userId: string): number {
  return standings.find((p) => p.user.id === userId)?.score ?? 0;
}

/** Placeholder values for `renderTaunt` — real names, real scores, tr-TR numbers. */
export function tauntVars(
  type: ChallengeType,
  challenge: ChallengeRow,
  from: UserRow,
  to: UserRow,
  standings: ParticipantView[],
): TauntVars {
  const fromScore = scoreOf(standings, from.id);
  const toScore = scoreOf(standings, to.id);
  return {
    winner: from.display_name,
    loser: to.display_name,
    metric: type.nameTr,
    winnerScore: formatScore(fromScore),
    loserScore: formatScore(toScore),
    diff: formatScore(Math.abs(fromScore - toScore)),
    unit: type.unitTr,
    challenge: challenge.title,
  };
}

/** `win_big` / `win_close` / `win`, or `revenge` when this challenge is a rematch. */
export function tauntContextFor(
  type: ChallengeType,
  challenge: ChallengeRow,
  winnerScore: number,
  loserScore: number,
): TauntContext {
  if (challenge.rematch_of_id) return 'revenge';
  return tauntContextForMargin(winMargin(type, winnerScore, loserScore));
}

function customTitle(level: VulgarityLevel, winner: string): string {
  if (level === 1) return `${winner} bir mesaj bıraktı`;
  if (level === 3) return `${winner} SAPLADI 🍆`;
  return `${winner} laf soktu`;
}

export interface SendTauntInput {
  challenge: ChallengeRow;
  from: UserRow;
  to: UserRow;
  templateId?: string;
  customBody?: string;
  now: Date;
}

export interface SendTauntResult {
  taunt: TauntRow;
  template: TauntTemplate | null;
}

/**
 * Writes one taunt, notifies the target and refreshes both users' badges.
 * Caller has already checked that `from` is the winner and `to` an accepted loser.
 */
export function sendTaunt(db: Database, input: SendTauntInput): SendTauntResult {
  const { challenge, from, to, templateId, customBody, now } = input;

  const already = db
    .prepare('SELECT id FROM taunts WHERE challenge_id = ? AND from_user_id = ? AND to_user_id = ?')
    .get(challenge.id, from.id, to.id) as { id: string } | undefined;
  if (already) throw conflict('already_taunted', 'Bu kankaya zaten koydun.');

  const type = typeForChallenge(challenge);
  const standings = computeStandings(db, challenge);
  const vars = tauntVars(type, challenge, from, to, standings);
  const recipientMax = levelOf(to);
  const context = tauntContextFor(type, challenge, scoreOf(standings, from.id), scoreOf(standings, to.id));
  const seed = seedFrom(challenge.id, from.id, to.id);

  let level: VulgarityLevel;
  let title: string;
  let body: string;
  let template: TauntTemplate | null = null;

  if (customBody !== undefined) {
    if (containsBanned(customBody)) {
      throw badRequest('banned_content', 'Bu laf fazla ağır: aile, tehdit ve nefret içeren sözler yasak.');
    }
    level = clampLevel(levelOf(from), recipientMax);
    const rendered = renderTaunt({ title: customTitle(level, from.display_name), body: customBody }, vars);
    title = rendered.title;
    body = rendered.body;
  } else {
    template = resolveTauntForRecipient(templateId, context, recipientMax, seed);
    level = clampLevel(template.level, recipientMax);
    const rendered = renderTaunt(template, vars);
    title = rendered.title;
    body = rendered.body;
  }

  const iso = nowIso(now);
  const row: TauntRow = {
    id: newId(),
    challenge_id: challenge.id,
    from_user_id: from.id,
    to_user_id: to.id,
    template_id: template?.id ?? null,
    level,
    title,
    body,
    created_at: iso,
  };

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO taunts (id, challenge_id, from_user_id, to_user_id, template_id, level, title, body, created_at)
       VALUES (@id, @challenge_id, @from_user_id, @to_user_id, @template_id, @level, @title, @body, @created_at)`,
    ).run(row);
    notify(db, {
      userId: to.id,
      type: 'taunt',
      title,
      body,
      data: { challengeId: challenge.id, tauntId: row.id },
      createdAt: iso,
    });
  });
  run();

  // tauntsSent / tauntsReceived are derived from the taunts table, so recomputing
  // stats here is what "bumps" them — and it hands out loudmouth / thick_skin.
  awardBadges(db, from.id, now);
  awardBadges(db, to.id, now);

  return { taunt: row, template };
}

/** Rendered previews the winner sees in the taunt picker (SPEC 2.2 results). */
export function tauntPreviewsForWinner(
  db: Database,
  challenge: ChallengeRow,
  winner: UserRow,
  loser: UserRow | undefined,
): TauntTemplate[] {
  const type = typeForChallenge(challenge);
  const standings = computeStandings(db, challenge);
  if (!loser) return [];
  const vars = tauntVars(type, challenge, winner, loser, standings);
  const context = tauntContextFor(type, challenge, scoreOf(standings, winner.id), scoreOf(standings, loser.id));
  return tauntsFor(context, 3).map((template) => ({
    ...template,
    ...renderTaunt(template, vars),
  }));
}

// ---------------------------------------------------------------------------
// Pokes
// ---------------------------------------------------------------------------

export interface SendPokeInput {
  challenge: ChallengeRow;
  from: UserRow;
  to: UserRow;
  templateId?: string;
  now: Date;
}

export interface SendPokeResult {
  poke: PokeRow;
  title: string;
  body: string;
  level: VulgarityLevel;
  template: TauntTemplate;
}

/**
 * One poke per (challenge, from, to) per `LIMITS.POKE_COOLDOWN_MS` (2 hours) —
 * otherwise the "dürt" button becomes a notification firehose.
 */
export function sendPoke(db: Database, input: SendPokeInput): SendPokeResult {
  const { challenge, from, to, templateId, now } = input;

  const last = db
    .prepare(
      'SELECT * FROM pokes WHERE challenge_id = ? AND from_user_id = ? AND to_user_id = ? ORDER BY created_at DESC LIMIT 1',
    )
    .get(challenge.id, from.id, to.id) as PokeRow | undefined;
  if (last) {
    const elapsed = now.getTime() - Date.parse(last.created_at);
    if (Number.isFinite(elapsed) && elapsed < LIMITS.POKE_COOLDOWN_MS) {
      const minutes = Math.max(1, Math.ceil((LIMITS.POKE_COOLDOWN_MS - elapsed) / 60000));
      throw tooMany('poke_cooldown', `Bu kankayı az önce dürttün. ${minutes} dakika sonra tekrar dene.`);
    }
  }

  const type = typeForChallenge(challenge);
  const standings = computeStandings(db, challenge);
  const vars = tauntVars(type, challenge, from, to, standings);
  const recipientMax = levelOf(to);
  const template = resolveTauntForRecipient(templateId, 'poke', recipientMax, seedFrom(challenge.id, from.id, to.id, last?.id ?? ''));
  const level = clampLevel(template.level, recipientMax);
  const { title, body } = renderTaunt(template, vars);

  const iso = nowIso(now);
  const poke: PokeRow = {
    id: newId(),
    challenge_id: challenge.id,
    from_user_id: from.id,
    to_user_id: to.id,
    created_at: iso,
  };

  const run = db.transaction(() => {
    db.prepare(
      'INSERT INTO pokes (id, challenge_id, from_user_id, to_user_id, created_at) VALUES (@id, @challenge_id, @from_user_id, @to_user_id, @created_at)',
    ).run(poke);
    notify(db, {
      userId: to.id,
      type: 'poke',
      title,
      body,
      data: { challengeId: challenge.id, pokeId: poke.id, fromUserId: from.id },
      createdAt: iso,
    });
  });
  run();

  awardBadges(db, from.id, now);

  return { poke, title, body, level, template };
}
