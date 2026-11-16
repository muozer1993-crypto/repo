/**
 * The content filter on names, çelınc titles and stakes (services/moderation.ts).
 *
 * The filter itself is tested in packages/shared; these tests pin where it runs,
 * what the refusal says, and that ordinary Turkish names and titles get through.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthResponse, Challenge, Me } from '@koydum/shared';
import { BANNED_TEXT_MESSAGES } from '../src/services/moderation.js';
import { authed, befriend, makeApp, registerUser, type TestApp } from './helpers.js';

let harness: TestApp | null = null;

afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = null;
  }
});

function register(h: TestApp, username: string, displayName: string) {
  return h.app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { username, displayName, password: 'sifre123', timezone: 'Europe/Istanbul' },
  });
}

function userCount(h: TestApp): number {
  return (h.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

function challengeCount(h: TestApp): number {
  return (h.db.prepare('SELECT COUNT(*) AS n FROM challenges').get() as { n: number }).n;
}

describe('POST /auth/register', () => {
  it('refuses a threat or a family insult as a display name, and stores nothing', async () => {
    harness = await makeApp();

    for (const displayName of ['seni öldürürüm', 'ananı s*keyim', 'İBNE']) {
      const response = await register(harness, 'trol', displayName);
      expect(response.statusCode, displayName).toBe(400);
      expect(response.json().error).toEqual({ code: 'banned_content', message: BANNED_TEXT_MESSAGES.displayName });
    }
    expect(BANNED_TEXT_MESSAGES.displayName).toBe(
      'Bu ad olmaz. Aile, tehdit ve nefret içeren sözler yasak. Adını değiştirip tekrar dene.',
    );
    expect(userCount(harness)).toBe(0);
  });

  it('refuses the same in a username, whose underscores count as spaces', async () => {
    harness = await makeApp();

    const response = await register(harness, 'seni_oldururum', 'Mustafa');
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toEqual({ code: 'banned_content', message: BANNED_TEXT_MESSAGES.username });
    expect(BANNED_TEXT_MESSAGES.username).toBe(
      'Bu kullanıcı adı olmaz. Aile, tehdit ve nefret içeren sözler yasak. Başka bir tane dene.',
    );
    expect(userCount(harness)).toBe(0);
  });

  it('does not spend the sign-up budget on a refused name', async () => {
    harness = await makeApp({ config: { registrationsPerHourPerClient: 1 } });

    expect((await register(harness, 'trol', 'seni öldürürüm')).statusCode).toBe(400);
    expect((await register(harness, 'mustafa', 'Mustafa')).statusCode).toBe(201);
  });

  it('lets ordinary Turkish names and usernames through', async () => {
    harness = await makeApp();

    // Names close to a banned stem (anan-, sık-, kurt, can, ...) and the generic
    // swearing the filter leaves alone on purpose ("Siktir").
    const names = [
      'Sıla', 'Sinan', 'Koray', 'Ece', 'Göksu', 'Ahmet', 'Sıtkı', 'Amasya', 'Ayşe', 'Ananas', 'Anıl', 'Şeyma',
      'Canan', 'Can', 'Kurtuluş', 'Bozkurt', 'Kesici', 'Sıddık', 'İsmail', 'IŞIL', 'Ali Rıza', 'Siktir',
    ];
    for (const [i, displayName] of names.entries()) {
      const response = await register(harness, `kanka_${i}`, displayName);
      expect(response.statusCode, displayName).toBe(201);
      expect(response.json<AuthResponse>().me.displayName).toBe(displayName);
    }

    // digits fold like leet-speak (1 → i, 3 → e, 4 → a), so a few of the usual shapes
    const usernames = ['mustafa_42', 'emre1905', 'koray_35', 'sitki', 'seyma_06', 'ali_34', 'kurt_can', 'sinan4'];
    for (const username of usernames) {
      expect((await register(harness, username, 'Kanka')).statusCode, username).toBe(201);
    }
  });
});

describe('PATCH /me', () => {
  it('refuses a banned new name and leaves the stored one and the other fields alone', async () => {
    harness = await makeApp();
    const ali = await registerUser(harness.app, 'ali', { displayName: 'Ali' });
    const call = authed(harness.app, ali.token);

    const refused = await call({
      method: 'PATCH',
      url: '/me',
      payload: { displayName: 'ananı s*keyim', vulgarityMax: 3 },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toEqual({ code: 'banned_content', message: BANNED_TEXT_MESSAGES.displayName });
    const row = harness.db.prepare('SELECT display_name, vulgarity_max FROM users WHERE id = ?').get(ali.me.id);
    expect(row).toEqual({ display_name: 'Ali', vulgarity_max: 2 });

    const renamed = await call({ method: 'PATCH', url: '/me', payload: { displayName: 'Göksu' } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<Me>().displayName).toBe('Göksu');
  });

  it('keeps a name stored before the filter, even when it is sent back unchanged', async () => {
    harness = await makeApp();
    const ali = await registerUser(harness.app, 'ali');
    harness.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run('seni öldürürüm', ali.me.id);

    const response = await authed(harness.app, ali.token)({
      method: 'PATCH',
      url: '/me',
      payload: { displayName: 'seni öldürürüm', vulgarityMax: 3 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<Me>()).toMatchObject({ displayName: 'seni öldürürüm', vulgarityMax: 3 });
  });
});

describe('POST /challenges', () => {
  async function twoFriends(h: TestApp) {
    const ali = await registerUser(h.app, 'ali');
    const veli = await registerUser(h.app, 'veli');
    befriend(h.app, ali.me.id, veli.me.id);
    return { ali, veli };
  }

  function create(h: TestApp, token: string, inviteeId: string, fields: Record<string, string>) {
    return authed(h.app, token)({
      method: 'POST',
      url: '/challenges',
      payload: {
        typeKey: 'adim_yarisi',
        startsAt: h.now().toISOString(),
        endsAt: new Date(h.now().getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        participantIds: [inviteeId],
        ...fields,
      },
    });
  }

  it('refuses a banned title, reward or penalty with a message naming the field', async () => {
    harness = await makeApp();
    const { ali, veli } = await twoFriends(harness);

    const cases: [Record<string, string>, string][] = [
      [{ title: 'seni öldürürüm' }, BANNED_TEXT_MESSAGES.title],
      [{ rewardText: 'Kazanan kaybedeni gebertir' }, BANNED_TEXT_MESSAGES.rewardText],
      [{ penaltyText: 'Kaybeden bacını getirir' }, BANNED_TEXT_MESSAGES.penaltyText],
      [{ title: 'Adım yarışı', penaltyText: 'ananı sikeyim' }, BANNED_TEXT_MESSAGES.penaltyText],
    ];
    for (const [fields, message] of cases) {
      const response = await create(harness, ali.token, veli.me.id, fields);
      expect(response.statusCode, JSON.stringify(fields)).toBe(400);
      expect(response.json().error).toEqual({ code: 'banned_content', message });
    }
    expect(BANNED_TEXT_MESSAGES.title).toBe(
      'Bu başlık olmaz. Aile, tehdit ve nefret içeren sözler yasak. Başlığı değiştirip tekrar dene.',
    );
    expect(BANNED_TEXT_MESSAGES.rewardText).toBe(
      'Bu ödül olmaz. Aile, tehdit ve nefret içeren sözler yasak. Ödülü değiştirip tekrar dene.',
    );
    expect(BANNED_TEXT_MESSAGES.penaltyText).toBe(
      'Bu ceza olmaz. Aile, tehdit ve nefret içeren sözler yasak. Cezayı değiştirip tekrar dene.',
    );
    // nothing stored and nobody invited
    expect(challengeCount(harness)).toBe(0);
    const invites = harness.db
      .prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND type = 'challenge_invite'")
      .get(veli.me.id) as { n: number };
    expect(invites.n).toBe(0);
  });

  it('lets ordinary titles and stakes through', async () => {
    harness = await makeApp();
    const { ali, veli } = await twoFriends(harness);

    const cases: Record<string, string>[] = [
      { title: 'Su içme yarışı', rewardText: 'Kaybeden kahve ısmarlar' },
      { title: 'Erken kalkan koyar', penaltyText: 'Kaybeden bulaşıkları yıkar' },
      { title: 'Ekran süresi', penaltyText: 'Kaybeden bir hafta profil fotoğrafını değiştirir' },
      { title: 'Amasya yürüyüşü', rewardText: 'Kazanana ananaslı pizza' },
      { title: 'Can sıkıntısına son', penaltyText: 'Kaybeden gruba rezil bir fotoğrafını atar' },
    ];
    for (const fields of cases) {
      const response = await create(harness, ali.token, veli.me.id, fields);
      expect(response.statusCode, JSON.stringify(fields)).toBe(201);
      expect(response.json<Challenge>()).toMatchObject(fields);
    }
  });
});
