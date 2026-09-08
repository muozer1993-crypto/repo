import { describe, expect, it } from 'vitest';
import {
  ChallengeListQuerySchema,
  CreateChallengeBodySchema,
  DayKeySchema,
  DisputeBodySchema,
  EntryBodySchema,
  FriendRequestBodySchema,
  InboxQuerySchema,
  InboxReadBodySchema,
  LoginBodySchema,
  PokeBodySchema,
  PushTokenBodySchema,
  RegisterBodySchema,
  ReportBodySchema,
  StepsSyncBodySchema,
  TauntBodySchema,
  UpdateMeBodySchema,
  USERNAME_REGEX,
  createChallengeBodySchema,
} from '../schemas';
import { getChallengeType } from '../catalog';

const ZWJ = String.fromCharCode(0x200d);
const ZWSP = String.fromCharCode(0x200b);

function issuePaths(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }): string[] {
  return result.success ? [] : (result.error?.issues ?? []).map((i) => i.path.join('.'));
}

describe('RegisterBody', () => {
  it('lowercases and trims the username and defaults the timezone', () => {
    const r = RegisterBodySchema.safeParse({ username: '  MuStAfa_01 ', password: 'secret1', displayName: ' Musti ' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ username: 'mustafa_01', password: 'secret1', displayName: 'Musti', timezone: 'Europe/Istanbul' });
  });

  it('rejects bad usernames even after lowercasing', () => {
    expect(RegisterBodySchema.safeParse({ username: 'ab', password: 'secret1', displayName: 'x' }).success).toBe(false);
    expect(RegisterBodySchema.safeParse({ username: 'has space', password: 'secret1', displayName: 'x' }).success).toBe(false);
    expect(RegisterBodySchema.safeParse({ username: 'İbrahim', password: 'secret1', displayName: 'x' }).success).toBe(false);
    expect(RegisterBodySchema.safeParse({ username: 'a'.repeat(21), password: 'secret1', displayName: 'x' }).success).toBe(false);
    expect(USERNAME_REGEX.test('ok_name1')).toBe(true);
  });

  it('enforces password and displayName limits', () => {
    expect(issuePaths(RegisterBodySchema.safeParse({ username: 'okname', password: '12345', displayName: 'x' }))).toEqual(['password']);
    expect(issuePaths(RegisterBodySchema.safeParse({ username: 'okname', password: 'a'.repeat(73), displayName: 'x' }))).toEqual(['password']);
    expect(issuePaths(RegisterBodySchema.safeParse({ username: 'okname', password: 'secret1', displayName: '   ' }))).toEqual(['displayName']);
    expect(issuePaths(RegisterBodySchema.safeParse({ username: 'okname', password: 'secret1', displayName: 'x'.repeat(31) }))).toEqual(['displayName']);
  });

  it('rejects display names made only of invisible characters and strips them elsewhere', () => {
    const invisible = ZWSP + String.fromCharCode(0x200c, 0xfeff, 0xad);
    expect(issuePaths(RegisterBodySchema.safeParse({ username: 'okname', password: 'secret1', displayName: invisible }))).toEqual(['displayName']);
    expect(issuePaths(RegisterBodySchema.safeParse({ username: 'okname', password: 'secret1', displayName: ZWJ + ZWJ }))).toEqual(['displayName']);
    expect(issuePaths(RegisterBodySchema.safeParse({ username: 'okname', password: 'secret1', displayName: ` ${ZWSP} ` }))).toEqual(['displayName']);
    expect(RegisterBodySchema.safeParse({ username: 'okname', password: 'secret1', displayName: `${invisible}Ali${invisible}` }).data?.displayName).toBe('Ali');
    const family = `Ali 👨${ZWJ}👩${ZWJ}👧`;
    expect(RegisterBodySchema.safeParse({ username: 'okname', password: 'secret1', displayName: family }).data?.displayName).toBe(family);
  });

  it('rejects unknown timezones', () => {
    expect(issuePaths(RegisterBodySchema.safeParse({ username: 'okname', password: 'secret1', displayName: 'x', timezone: 'Mars/Base' }))).toEqual(['timezone']);
    expect(RegisterBodySchema.safeParse({ username: 'okname', password: 'secret1', displayName: 'x', timezone: 'America/New_York' }).success).toBe(true);
  });
});

describe('LoginBody', () => {
  it('normalises the username and requires a password', () => {
    expect(LoginBodySchema.parse({ username: 'ADMIN', password: 'x' })).toEqual({ username: 'admin', password: 'x' });
    expect(LoginBodySchema.safeParse({ username: 'admin', password: '' }).success).toBe(false);
  });
});

describe('UpdateMeBody', () => {
  it('accepts partial updates including null reminderHour', () => {
    expect(UpdateMeBodySchema.parse({})).toEqual({});
    expect(UpdateMeBodySchema.parse({ reminderHour: null })).toEqual({ reminderHour: null });
    expect(UpdateMeBodySchema.parse({ vulgarityMax: 3, avatarEmoji: '🍆', reminderHour: 20 })).toEqual({ vulgarityMax: 3, avatarEmoji: '🍆', reminderHour: 20 });
  });

  it('rejects out-of-range values', () => {
    expect(UpdateMeBodySchema.safeParse({ vulgarityMax: 4 }).success).toBe(false);
    expect(UpdateMeBodySchema.safeParse({ vulgarityMax: 0 }).success).toBe(false);
    expect(UpdateMeBodySchema.safeParse({ reminderHour: 24 }).success).toBe(false);
    expect(UpdateMeBodySchema.safeParse({ reminderHour: 1.5 }).success).toBe(false);
    expect(UpdateMeBodySchema.safeParse({ avatarEmoji: 'toolong' }).success).toBe(false);
  });

  it('counts the avatar in graphemes (1..4 visible characters), not UTF-16 code units', () => {
    const family = `👨${ZWJ}👩${ZWJ}👧`; // 8 code units, one character
    expect(family.length).toBe(8);
    expect(UpdateMeBodySchema.safeParse({ avatarEmoji: family }).data).toEqual({ avatarEmoji: family });
    expect(UpdateMeBodySchema.safeParse({ avatarEmoji: '👍🏽' }).success).toBe(true);
    expect(UpdateMeBodySchema.safeParse({ avatarEmoji: '🇹🇷' }).success).toBe(true);
    expect(UpdateMeBodySchema.safeParse({ avatarEmoji: '🍆🔥💀👑' }).success).toBe(true);
    expect(UpdateMeBodySchema.safeParse({ avatarEmoji: 'abcd' }).success).toBe(true);
    expect(issuePaths(UpdateMeBodySchema.safeParse({ avatarEmoji: '🍆🔥💀👑🍑' }))).toEqual(['avatarEmoji']);
    expect(issuePaths(UpdateMeBodySchema.safeParse({ avatarEmoji: 'abcde' }))).toEqual(['avatarEmoji']);
    expect(issuePaths(UpdateMeBodySchema.safeParse({ avatarEmoji: ZWSP }))).toEqual(['avatarEmoji']);
    expect(issuePaths(UpdateMeBodySchema.safeParse({ avatarEmoji: '   ' }))).toEqual(['avatarEmoji']);
    expect(UpdateMeBodySchema.safeParse({ avatarEmoji: ` ${ZWSP}🍆 ` }).data).toEqual({ avatarEmoji: '🍆' });
    // Code-unit abuse guard: four skin-toned families are 4 graphemes but 76 code units.
    const heavy = `👨🏻${ZWJ}👩🏻${ZWJ}👧🏻${ZWJ}👦🏻`;
    expect(UpdateMeBodySchema.safeParse({ avatarEmoji: heavy.repeat(3) }).success).toBe(true);
    expect(UpdateMeBodySchema.safeParse({ avatarEmoji: heavy.repeat(4) }).success).toBe(false);
  });
});

describe('PushTokenBody / StepsSyncBody', () => {
  it('validates push token bodies', () => {
    expect(PushTokenBodySchema.safeParse({ token: 'ExponentPushToken[abc]', platform: 'ios' }).success).toBe(true);
    expect(PushTokenBodySchema.safeParse({ token: '', platform: 'ios' }).success).toBe(false);
    expect(PushTokenBodySchema.safeParse({ token: 'x', platform: 'windows' }).success).toBe(false);
  });

  it('validates steps sync bodies', () => {
    const day = { dayKey: '2024-05-01', steps: 1234, source: 'pedometer' };
    expect(StepsSyncBodySchema.safeParse({ days: [day] }).success).toBe(true);
    expect(StepsSyncBodySchema.safeParse({ days: [{ ...day, steps: 100001 }] }).success).toBe(false);
    expect(StepsSyncBodySchema.safeParse({ days: [{ ...day, steps: 10.5 }] }).success).toBe(false);
    expect(StepsSyncBodySchema.safeParse({ days: [{ ...day, source: 'manual' }] }).success).toBe(false);
    expect(StepsSyncBodySchema.safeParse({ days: [{ ...day, dayKey: '2024-02-30' }] }).success).toBe(false);
    expect(StepsSyncBodySchema.safeParse({ days: Array.from({ length: 15 }, () => day) }).success).toBe(false);
  });
});

describe('FriendRequestBody', () => {
  it('requires exactly one of username / inviteCode', () => {
    expect(FriendRequestBodySchema.safeParse({ username: 'Ali' }).data).toEqual({ username: 'ali' });
    expect(FriendRequestBodySchema.safeParse({ inviteCode: 'K7X2' }).success).toBe(true);
    expect(FriendRequestBodySchema.safeParse({}).success).toBe(false);
    expect(FriendRequestBodySchema.safeParse({ username: 'ali', inviteCode: 'K7X2' }).success).toBe(false);
  });
});

describe('CreateChallengeBody', () => {
  const now = Date.parse('2024-05-01T10:00:00Z');
  const schema = createChallengeBodySchema({ now: () => now });
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const H = 3600 * 1000;
  const D = 24 * H;
  const base = { typeKey: 'adim_yarisi', startsAt: iso(0), endsAt: iso(7 * D), participantIds: ['u1', 'u2'] };

  it('accepts a valid body and strips empty optional text', () => {
    const r = schema.safeParse({ ...base, title: '  ', rewardText: ' Bira ', deadlineTime: '07:30', dailyTarget: 10, proofRequired: true });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ typeKey: 'adim_yarisi', rewardText: 'Bira', deadlineTime: '07:30', dailyTarget: 10, proofRequired: true });
    expect(r.data?.title).toBeUndefined();
  });

  it('allows startsAt up to 5 minutes in the past but not more', () => {
    expect(schema.safeParse({ ...base, startsAt: iso(-4 * 60 * 1000), endsAt: iso(D) }).success).toBe(true);
    expect(issuePaths(schema.safeParse({ ...base, startsAt: iso(-6 * 60 * 1000), endsAt: iso(D) }))).toEqual(['startsAt']);
  });

  it('requires endsAt > startsAt + 1h', () => {
    expect(issuePaths(schema.safeParse({ ...base, endsAt: iso(H) }))).toEqual(['endsAt']);
    expect(issuePaths(schema.safeParse({ ...base, endsAt: iso(30 * 60 * 1000) }))).toEqual(['endsAt']);
    expect(schema.safeParse({ ...base, endsAt: iso(H + 60 * 1000) }).success).toBe(true);
  });

  it('requires endsAt <= startsAt + 60 days', () => {
    expect(schema.safeParse({ ...base, endsAt: iso(60 * D) }).success).toBe(true);
    expect(issuePaths(schema.safeParse({ ...base, endsAt: iso(60 * D + 1000) }))).toEqual(['endsAt']);
  });

  it('enforces participant count and uniqueness', () => {
    expect(issuePaths(schema.safeParse({ ...base, participantIds: [] }))).toEqual(['participantIds']);
    expect(issuePaths(schema.safeParse({ ...base, participantIds: ['a', 'a'] }))).toEqual(['participantIds']);
    expect(issuePaths(schema.safeParse({ ...base, participantIds: Array.from({ length: 16 }, (_, i) => `u${i}`) }))).toEqual(['participantIds']);
    expect(schema.safeParse({ ...base, participantIds: Array.from({ length: 15 }, (_, i) => `u${i}`) }).success).toBe(true);
  });

  it('validates optional fields', () => {
    expect(issuePaths(schema.safeParse({ ...base, deadlineTime: '25:00' }))).toEqual(['deadlineTime']);
    expect(issuePaths(schema.safeParse({ ...base, title: 'x'.repeat(41) }))).toEqual(['title']);
    expect(issuePaths(schema.safeParse({ ...base, rewardText: 'x'.repeat(81) }))).toEqual(['rewardText']);
    expect(issuePaths(schema.safeParse({ ...base, dailyTarget: 0 }))).toEqual(['dailyTarget']);
    expect(issuePaths(schema.safeParse({ ...base, startsAt: 'yesterday' }))).toEqual(['startsAt']);
  });

  it('rejects typeKeys that are not in the catalog', () => {
    expect(issuePaths(schema.safeParse({ ...base, typeKey: 'yok_boyle_bir_sey' }))).toEqual(['typeKey']);
    expect(issuePaths(schema.safeParse({ ...base, typeKey: 'yok_boyle_bir_sey', startsAt: 'yesterday' }))).toEqual(['startsAt', 'typeKey']);
  });

  it('requires deadlineTime when the type is a checkin_deadline (SPEC 1.6)', () => {
    expect(getChallengeType('erken_kus')?.metricType).toBe('checkin_deadline');
    expect(issuePaths(schema.safeParse({ ...base, typeKey: 'erken_kus' }))).toEqual(['deadlineTime']);
    expect(issuePaths(schema.safeParse({ ...base, typeKey: 'erken_kus', deadlineTime: '' }))).toEqual(['deadlineTime']);
    expect(schema.safeParse({ ...base, typeKey: 'erken_kus', deadlineTime: '07:30' }).success).toBe(true);
    expect(schema.safeParse({ ...base, typeKey: 'su_bardak' }).success).toBe(true);
  });

  it('accepts an injected catalog lookup', () => {
    const custom = createChallengeBodySchema({
      now: () => now,
      resolveType: (key) => (key === 'custom_checkin' ? { ...getChallengeType('erken_kus')!, key } : undefined),
    });
    expect(issuePaths(custom.safeParse({ ...base, typeKey: 'custom_checkin' }))).toEqual(['deadlineTime']);
    expect(custom.safeParse({ ...base, typeKey: 'custom_checkin', deadlineTime: '06:00' }).success).toBe(true);
    expect(issuePaths(custom.safeParse({ ...base, typeKey: 'adim_yarisi' }))).toEqual(['typeKey']);
  });

  it('the default export uses the real clock', () => {
    const realNow = Date.now();
    const body = { ...base, startsAt: new Date(realNow).toISOString(), endsAt: new Date(realNow + D).toISOString() };
    expect(CreateChallengeBodySchema.safeParse(body).success).toBe(true);
    expect(CreateChallengeBodySchema.safeParse({ ...body, startsAt: '2020-01-01T00:00:00Z' }).success).toBe(false);
  });
});

describe('EntryBody', () => {
  const ok = { dayKey: '2024-05-01', value: 12, source: 'manual', clientTime: '2024-05-01T10:00:00.000Z' };

  it('accepts valid entries with optional fields', () => {
    const r = EntryBodySchema.safeParse({ ...ok, note: ' 2 bardak ', proofUrl: 'http://localhost:4000/uploads/a.jpg', sessionId: '123e4567-e89b-12d3-a456-426614174000' });
    expect(r.success).toBe(true);
    expect(r.data?.note).toBe('2 bardak');
    expect(EntryBodySchema.safeParse({ ...ok, note: '' }).data?.note).toBeUndefined();
    expect(EntryBodySchema.safeParse({ ...ok, clientTime: '2024-05-01T13:00:00+03:00' }).success).toBe(true);
    expect(EntryBodySchema.safeParse({ ...ok, value: 0 }).success).toBe(true);
    expect(EntryBodySchema.safeParse({ ...ok, proofUrl: '/uploads/a.jpg' }).success).toBe(true);
  });

  it('rejects negative, non-finite and malformed values', () => {
    expect(issuePaths(EntryBodySchema.safeParse({ ...ok, value: -1 }))).toEqual(['value']);
    expect(issuePaths(EntryBodySchema.safeParse({ ...ok, value: Number.POSITIVE_INFINITY }))).toEqual(['value']);
    expect(issuePaths(EntryBodySchema.safeParse({ ...ok, value: Number.NaN }))).toEqual(['value']);
    expect(issuePaths(EntryBodySchema.safeParse({ ...ok, value: '12' }))).toEqual(['value']);
    expect(issuePaths(EntryBodySchema.safeParse({ ...ok, dayKey: '01-05-2024' }))).toEqual(['dayKey']);
    expect(issuePaths(EntryBodySchema.safeParse({ ...ok, source: 'watch' }))).toEqual(['source']);
    expect(issuePaths(EntryBodySchema.safeParse({ ...ok, clientTime: '2024-05-01' }))).toEqual(['clientTime']);
    expect(issuePaths(EntryBodySchema.safeParse({ ...ok, sessionId: 'not-a-uuid' }))).toEqual(['sessionId']);
    expect(issuePaths(EntryBodySchema.safeParse({ ...ok, note: 'x'.repeat(121) }))).toEqual(['note']);
    expect(issuePaths(EntryBodySchema.safeParse({ ...ok, proofUrl: 'javascript:alert(1)' }))).toEqual(['proofUrl']);
  });

  it('DayKeySchema rejects impossible dates', () => {
    expect(DayKeySchema.safeParse('2024-02-29').success).toBe(true);
    expect(DayKeySchema.safeParse('2023-02-29').success).toBe(false);
  });
});

describe('small bodies', () => {
  it('DisputeBody / ReportBody', () => {
    expect(DisputeBodySchema.safeParse({ reason: ' sahte ' }).data).toEqual({ reason: 'sahte' });
    expect(DisputeBodySchema.safeParse({ reason: '' }).success).toBe(false);
    expect(DisputeBodySchema.safeParse({ reason: 'x'.repeat(141) }).success).toBe(false);
    expect(ReportBodySchema.safeParse({ reason: 'x'.repeat(300) }).success).toBe(true);
    expect(ReportBodySchema.safeParse({ reason: 'x'.repeat(301) }).success).toBe(false);
  });

  it('PokeBody', () => {
    expect(PokeBodySchema.safeParse({ toUserId: 'u1' }).success).toBe(true);
    expect(PokeBodySchema.safeParse({ toUserId: 'u1', templateId: 'poke_1' }).success).toBe(true);
    expect(PokeBodySchema.safeParse({}).success).toBe(false);
  });

  it('TauntBody requires exactly one of templateId / customBody', () => {
    expect(TauntBodySchema.safeParse({ toUserId: 'u1', templateId: 'win_1' }).success).toBe(true);
    expect(TauntBodySchema.safeParse({ toUserId: 'u1', customBody: 'Yedin mi lan' }).data).toEqual({ toUserId: 'u1', customBody: 'Yedin mi lan' });
    expect(TauntBodySchema.safeParse({ toUserId: 'u1' }).success).toBe(false);
    expect(TauntBodySchema.safeParse({ toUserId: 'u1', customBody: '   ' }).success).toBe(false);
    expect(TauntBodySchema.safeParse({ toUserId: 'u1', templateId: 'win_1', customBody: 'x' }).success).toBe(false);
    expect(TauntBodySchema.safeParse({ toUserId: 'u1', customBody: 'x'.repeat(141) }).success).toBe(false);
  });

  it('InboxReadBody', () => {
    expect(InboxReadBodySchema.safeParse({ ids: ['n1'] }).data).toEqual({ ids: ['n1'] });
    expect(InboxReadBodySchema.safeParse({ all: true }).success).toBe(true);
    // SPEC 1.6: both keys optional — an empty list / all:false is a valid no-op, not a 400
    expect(InboxReadBodySchema.safeParse({ ids: [] }).data).toEqual({ ids: [] });
    expect(InboxReadBodySchema.safeParse({ all: false }).data).toEqual({ all: false });
    expect(issuePaths(InboxReadBodySchema.safeParse({}))).toEqual(['ids']);
    expect(InboxReadBodySchema.safeParse({ ids: 'n1' }).success).toBe(false);
    expect(InboxReadBodySchema.safeParse({ ids: Array.from({ length: 501 }, (_, i) => `n${i}`) }).success).toBe(false);
  });
});

describe('query schemas', () => {
  it('InboxQuery coerces limit and applies the default', () => {
    expect(InboxQuerySchema.parse({})).toEqual({ limit: 30 });
    expect(InboxQuerySchema.parse({ limit: '10', before: '2024-05-01T00:00:00Z' })).toEqual({ limit: 10, before: '2024-05-01T00:00:00Z' });
    expect(InboxQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
  });

  it('ChallengeListQuery splits comma-separated statuses', () => {
    expect(ChallengeListQuerySchema.parse({})).toEqual({ status: [] });
    expect(ChallengeListQuerySchema.parse({ status: 'active, pending' })).toEqual({ status: ['active', 'pending'] });
    expect(ChallengeListQuerySchema.safeParse({ status: 'active,bogus' }).success).toBe(false);
  });
});
