import { z } from 'zod';
import {
  ENTRY_SOURCES,
  METRIC_TYPES,
  PUSH_PLATFORMS,
  VULGARITY_LEVELS,
  CHALLENGE_STATUSES,
  type ChallengeType,
  type VulgarityLevel,
} from './types';
import { LIMITS } from './scoring';
import { DAY_KEY_REGEX, HHMM_REGEX, DEFAULT_TIMEZONE, isValidDayKey, isValidTimeZone } from './time';
import { countGraphemes, hasVisibleChar, stripInvisible } from './text';
import { getChallengeType } from './catalog';

export { DAY_KEY_REGEX, HHMM_REGEX };

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const USERNAME_REGEX = /^[a-z0-9_]{3,20}$/;

/** Trimmed, lowercased, then validated — so `" MuStAfA "` is accepted as `mustafa`. */
export const UsernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(USERNAME_REGEX, 'Kullanıcı adı 3-20 karakter olmalı: küçük harf, rakam ve alt çizgi');

export const PasswordSchema = z
  .string()
  .min(LIMITS.PASSWORD_MIN, `Şifre en az ${LIMITS.PASSWORD_MIN} karakter olmalı`)
  .max(LIMITS.PASSWORD_MAX, `Şifre en fazla ${LIMITS.PASSWORD_MAX} karakter olabilir`);

/**
 * Invisible characters (zero-width space, soft hyphen, BOM...) are removed before the
 * emptiness check — `String.prototype.trim` does not touch them, and a name made only
 * of them would render as nothing in standings, feed and taunts.
 */
export const DisplayNameSchema = z
  .string()
  .transform((s) => stripInvisible(s).trim())
  .pipe(
    z
      .string()
      .min(1, { message: 'Görünen ad boş olamaz', abort: true })
      .max(LIMITS.DISPLAY_NAME_MAX, `Görünen ad en fazla ${LIMITS.DISPLAY_NAME_MAX} karakter olabilir`)
      .refine(hasVisibleChar, 'Görünen ad boş olamaz'),
  );

/**
 * "1..4 chars" counted as user-perceived characters (grapheme clusters), so one ZWJ
 * family emoji (👨‍👩‍👧, 8 UTF-16 code units) is a single character. The code-unit cap is
 * only an abuse guard.
 */
export const AvatarEmojiSchema = z
  .string()
  .transform((s) => stripInvisible(s).trim())
  .pipe(
    z
      .string()
      .min(1, { message: 'Avatar boş olamaz', abort: true })
      .max(LIMITS.AVATAR_EMOJI_MAX_UNITS, { message: 'Avatar çok uzun', abort: true })
      .refine(hasVisibleChar, 'Avatar boş olamaz')
      .refine((s) => countGraphemes(s) <= LIMITS.AVATAR_EMOJI_MAX, `Avatar en fazla ${LIMITS.AVATAR_EMOJI_MAX} karakter`),
  );

export const TimezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, 'Geçersiz saat dilimi');

export const VulgarityLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]) as z.ZodType<VulgarityLevel>;
export const MetricTypeSchema = z.enum(METRIC_TYPES);
export const EntrySourceSchema = z.enum(ENTRY_SOURCES);
export const PushPlatformSchema = z.enum(PUSH_PLATFORMS);
export const ChallengeStatusSchema = z.enum(CHALLENGE_STATUSES);

export const DayKeySchema = z
  .string()
  .regex(DAY_KEY_REGEX, { message: 'Gün formatı YYYY-MM-DD olmalı', abort: true })
  .refine(isValidDayKey, 'Geçersiz tarih');

export const HHmmSchema = z.string().regex(HHMM_REGEX, 'Saat formatı HH:mm olmalı');

/** ISO-8601 date-time; offsets accepted, the server normalises to UTC. */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true, message: 'Geçersiz tarih/saat (ISO-8601 bekleniyor)' });

export const IdSchema = z.string().trim().min(1).max(64);

/** Optional free text: trimmed; empty strings become `undefined`. */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max, `En fazla ${max} karakter`)
    .optional()
    .transform((v) => (v ? v : undefined));
}

// ---------------------------------------------------------------------------
// Auth / me
// ---------------------------------------------------------------------------

export const RegisterBodySchema = z.object({
  username: UsernameSchema,
  password: PasswordSchema,
  displayName: DisplayNameSchema,
  timezone: TimezoneSchema.default(DEFAULT_TIMEZONE),
});
export type RegisterBody = z.infer<typeof RegisterBodySchema>;

export const LoginBodySchema = z.object({
  username: UsernameSchema,
  password: z.string().min(1, 'Şifre boş olamaz').max(LIMITS.PASSWORD_MAX),
});
export type LoginBody = z.infer<typeof LoginBodySchema>;

export const UpdateMeBodySchema = z.object({
  displayName: DisplayNameSchema.optional(),
  avatarEmoji: AvatarEmojiSchema.optional(),
  vulgarityMax: VulgarityLevelSchema.optional(),
  timezone: TimezoneSchema.optional(),
  reminderHour: z.number().int().min(0).max(23).nullable().optional(),
});
export type UpdateMeBody = z.infer<typeof UpdateMeBodySchema>;

export const PushTokenBodySchema = z.object({
  token: z.string().trim().min(1).max(512),
  platform: PushPlatformSchema,
});
export type PushTokenBody = z.infer<typeof PushTokenBodySchema>;

export const StepsSyncDaySchema = z.object({
  dayKey: DayKeySchema,
  steps: z.number().int().min(0).max(LIMITS.STEPS_PER_DAY_MAX),
  source: z.enum(['pedometer', 'health_connect']),
});
export type StepsSyncDay = z.infer<typeof StepsSyncDaySchema>;

export const StepsSyncBodySchema = z.object({
  days: z.array(StepsSyncDaySchema).max(LIMITS.STEPS_SYNC_DAYS_MAX, `En fazla ${LIMITS.STEPS_SYNC_DAYS_MAX} gün`),
});
export type StepsSyncBody = z.infer<typeof StepsSyncBodySchema>;

// ---------------------------------------------------------------------------
// Friends
// ---------------------------------------------------------------------------

export const FriendRequestBodySchema = z
  .object({
    username: UsernameSchema.optional(),
    inviteCode: z.string().trim().min(1).max(32).optional(),
  })
  .superRefine((v, ctx) => {
    const provided = [v.username, v.inviteCode].filter((x) => x !== undefined).length;
    if (provided !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'Kullanıcı adı veya davet kodu — sadece biri',
        path: provided === 0 ? ['username'] : ['inviteCode'],
      });
    }
  });
export type FriendRequestBody = z.infer<typeof FriendRequestBodySchema>;

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

export interface ChallengeSchemaOptions {
  /** Clock used for the `startsAt >= now - 5min` rule (injectable for tests). */
  now?: () => number;
  /** Catalog lookup for `typeKey` (injectable for tests). Defaults to the shared catalog. */
  resolveType?: (typeKey: string) => ChallengeType | undefined;
}

/**
 * Factory so the server can inject a clock and a catalog. Everything SPEC 1.6 states
 * about the body is enforced here, including "`deadlineTime` required when
 * metricType === 'checkin_deadline'" and that `typeKey` exists in the catalog. Rules
 * that need the database (participants are friends, not self) stay on the server.
 */
export function createChallengeBodySchema(opts: ChallengeSchemaOptions = {}) {
  const now = opts.now ?? (() => Date.now());
  const resolveType = opts.resolveType ?? getChallengeType;
  return z
    .object({
      typeKey: z.string().trim().min(1).max(40),
      title: optionalText(LIMITS.CHALLENGE_TITLE_MAX),
      startsAt: IsoDateTimeSchema,
      endsAt: IsoDateTimeSchema,
      participantIds: z
        .array(IdSchema)
        .min(LIMITS.PARTICIPANTS_MIN, 'En az bir kanka seçmelisin')
        .max(LIMITS.PARTICIPANTS_MAX, `En fazla ${LIMITS.PARTICIPANTS_MAX} kişi`),
      rewardText: optionalText(LIMITS.REWARD_TEXT_MAX),
      penaltyText: optionalText(LIMITS.PENALTY_TEXT_MAX),
      deadlineTime: HHmmSchema.optional(),
      dailyTarget: z.number().positive().optional(),
      proofRequired: z.boolean().optional(),
    })
    .superRefine((v, ctx) => {
      const type = resolveType(v.typeKey);
      if (!type) {
        ctx.addIssue({ code: 'custom', message: 'Böyle bir çelinç tipi yok', path: ['typeKey'] });
      } else if (type.metricType === 'checkin_deadline' && v.deadlineTime === undefined) {
        // An empty/malformed string is already reported by HHmmSchema; only absence is ours.
        ctx.addIssue({ code: 'custom', message: 'Check-in çelinci için bir saat seçmelisin', path: ['deadlineTime'] });
      }

      const start = Date.parse(v.startsAt);
      const end = Date.parse(v.endsAt);
      if (Number.isNaN(start) || Number.isNaN(end)) return; // already reported by IsoDateTimeSchema

      if (start < now() - LIMITS.START_GRACE_MS) {
        ctx.addIssue({ code: 'custom', message: 'Başlangıç geçmişte olamaz', path: ['startsAt'] });
      }
      if (end <= start + LIMITS.MIN_DURATION_MS) {
        ctx.addIssue({ code: 'custom', message: 'Çelinç en az 1 saat sürmeli', path: ['endsAt'] });
      }
      if (end > start + LIMITS.MAX_DURATION_MS) {
        ctx.addIssue({
          code: 'custom',
          message: `Çelinç en fazla ${LIMITS.MAX_DURATION_DAYS} gün sürebilir`,
          path: ['endsAt'],
        });
      }
      if (new Set(v.participantIds).size !== v.participantIds.length) {
        ctx.addIssue({ code: 'custom', message: 'Aynı kanka iki kez seçilemez', path: ['participantIds'] });
      }
    });
}

export const CreateChallengeBodySchema = createChallengeBodySchema();
export type CreateChallengeBody = z.infer<typeof CreateChallengeBodySchema>;

export const EntryBodySchema = z.object({
  dayKey: DayKeySchema,
  value: z.number().finite().min(0, 'Değer negatif olamaz'),
  source: EntrySourceSchema,
  note: optionalText(LIMITS.NOTE_MAX),
  proofUrl: z
    .string()
    .trim()
    .min(1)
    .max(LIMITS.PROOF_URL_MAX)
    .refine((s) => /^(https?:\/\/|\/)/.test(s), 'Geçersiz kanıt adresi')
    .optional(),
  clientTime: IsoDateTimeSchema,
  /** Focus sessions: idempotency key. */
  sessionId: z.uuid('Geçersiz oturum kimliği').optional(),
});
export type EntryBody = z.infer<typeof EntryBodySchema>;

export const DisputeBodySchema = z.object({
  reason: z.string().trim().min(1, 'Sebep boş olamaz').max(LIMITS.DISPUTE_REASON_MAX),
});
export type DisputeBody = z.infer<typeof DisputeBodySchema>;

export const PokeBodySchema = z.object({
  toUserId: IdSchema,
  templateId: z.string().trim().min(1).max(64).optional(),
});
export type PokeBody = z.infer<typeof PokeBodySchema>;

export const TauntBodySchema = z
  .object({
    toUserId: IdSchema,
    templateId: z.string().trim().min(1).max(64).optional(),
    customBody: optionalText(LIMITS.CUSTOM_TAUNT_MAX),
  })
  .superRefine((v, ctx) => {
    const provided = [v.templateId, v.customBody].filter((x) => x !== undefined).length;
    if (provided !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'Bir şablon seç ya da kendi lafını yaz — ikisi birden olmaz',
        path: provided === 0 ? ['templateId'] : ['customBody'],
      });
    }
  });
export type TauntBody = z.infer<typeof TauntBodySchema>;

export const ReportBodySchema = z.object({
  reason: z.string().trim().min(1, 'Sebep boş olamaz').max(LIMITS.REPORT_REASON_MAX),
});
export type ReportBody = z.infer<typeof ReportBodySchema>;

/**
 * `{ ids }` or `{ all }` (SPEC 1.6 — both optional). At least one key must be present;
 * `{ ids: [] }` and `{ all: false }` are valid no-ops so a client that has nothing new
 * to mark does not get a 400.
 */
export const InboxReadBodySchema = z
  .object({
    ids: z.array(IdSchema).max(500).optional(),
    all: z.boolean().optional(),
  })
  .refine((v) => v.all !== undefined || v.ids !== undefined, {
    message: 'ids listesi ya da all alanı gerekli',
    path: ['ids'],
  });
export type InboxReadBody = z.infer<typeof InboxReadBodySchema>;

// ---------------------------------------------------------------------------
// Query strings
// ---------------------------------------------------------------------------

export const InboxQuerySchema = z.object({
  before: IsoDateTimeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.INBOX_PAGE_MAX).default(LIMITS.INBOX_PAGE_DEFAULT),
});
export type InboxQuery = z.infer<typeof InboxQuerySchema>;

/** `?status=active,pending` → `['active', 'pending']` (omitted → all statuses). */
export const ChallengeListQuerySchema = z.object({
  status: z
    .string()
    .trim()
    .optional()
    .transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []))
    .pipe(z.array(ChallengeStatusSchema)),
});
export type ChallengeListQuery = z.infer<typeof ChallengeListQuerySchema>;

export const UserSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(40),
});
export type UserSearchQuery = z.infer<typeof UserSearchQuerySchema>;
