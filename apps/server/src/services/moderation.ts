/**
 * The shared content filter on the text people type for other people to read:
 * both names of an account (`containsBannedName`), and a çelınc's title and
 * stakes (`containsBannedTitle`).
 * Custom taunts have their own check in services/taunts.ts, which also reads the
 * finished sentence its placeholders expand to.
 *
 * Only new writes are checked: a name or a title stored before the filter ran on
 * it stays as it is.
 */
import { containsBannedName, containsBannedTitle } from '@koydum/shared';
import { badRequest } from '../errors.js';

const WHY = 'Aile, tehdit ve nefret içeren sözler yasak.';

/**
 * One refusal per field, each naming the field to change: the app shows only the
 * message, and the wizard sends title and stakes from different steps.
 */
export const BANNED_TEXT_MESSAGES = {
  username: `Bu kullanıcı adı olmaz. ${WHY} Başka bir tane dene.`,
  displayName: `Bu ad olmaz. ${WHY} Adını değiştirip tekrar dene.`,
  title: `Bu başlık olmaz. ${WHY} Başlığı değiştirip tekrar dene.`,
  rewardText: `Bu ödül olmaz. ${WHY} Ödülü değiştirip tekrar dene.`,
  penaltyText: `Bu ceza olmaz. ${WHY} Cezayı değiştirip tekrar dene.`,
} as const;

/**
 * 400 `banned_content` with `message` when a çelınc's title, reward or penalty
 * trips the filter; a missing text passes. Workout talk that only sounds like a
 * threat ("Sigarayı kesicem", "Öldürücü 10K haftası") and a real surname pass,
 * see `containsBannedTitle`.
 */
export function assertCleanTitle(text: string | null | undefined, message: string): void {
  if (text && containsBannedTitle(text)) throw badRequest('banned_content', message);
}

/**
 * The same check for a name: real surnames that share a stem with a slur (Topal,
 * Kıroğlu, Zencir…) pass, see `containsBannedName`.
 */
export function assertCleanName(text: string | null | undefined, message: string): void {
  if (text && containsBannedName(text)) throw badRequest('banned_content', message);
}
