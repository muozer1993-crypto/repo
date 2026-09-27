/**
 * npm run yonet — the server owner's toolbox (services/admin.ts), in Turkish.
 *
 *   npm run yonet -- kullanicilar        everybody, when they last came by, running çelınclar
 *   npm run yonet -- sikayetler          reports, newest first
 *   npm run yonet -- sifre <kullanici>   a new password for a friend who forgot theirs
 *
 * npm runs a workspace script with apps/server as the cwd, so the default
 * DATA_DIR './data' is the very database the server uses. Run from anywhere else
 * it would find (or quietly create) a different one, hence the refusal below when
 * the file is missing. Safe while the server runs: WAL lets a second connection
 * in and busy_timeout waits out the server's writes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_TIMEZONE, dayKeyInTz, localTimeHHmm } from '@koydum/shared';
import { loadConfig } from '../config.js';
import { openDb, type Database } from '../db/index.js';
import { listReports, listUsers, resetPassword } from '../services/admin.js';

const HELP = `KOYDUM yönetim komutları (sunucuyu açan kişi için)

  npm run yonet -- kullanicilar        herkes: ne zaman katıldı, en son ne zaman girdi, kaç çelıncı sürüyor
  npm run yonet -- sikayetler          gelen şikayetler, en yenisi en üstte
  npm run yonet -- sifre <kullanici>   şifresini unutan kankaya yeni şifre

Sunucu açıkken de çalışır.`;

type Command = 'users' | 'reports' | 'password';

/** The owner may well type the Turkish letters; both spellings work. */
const COMMANDS: Record<string, Command> = {
  kullanicilar: 'users',
  kullanıcılar: 'users',
  sikayetler: 'reports',
  şikayetler: 'reports',
  sifre: 'password',
  şifre: 'password',
};

const HELP_WORDS = new Set(['yardim', 'yardım', 'help', '--help', '-h']);

/** Istanbul wall-clock time: the owner reads this, not a log parser. */
function when(iso: string | null, withTime = true): string {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = dayKeyInTz(date, DEFAULT_TIMEZONE);
  return withTime ? `${day} ${localTimeHHmm(date, DEFAULT_TIMEZONE)}` : day;
}

/** Plain padded columns; the last one is left unpadded so a long reason can run on. */
function table(header: string[], rows: string[][]): string {
  const widths = header.map((title, i) => Math.max(title.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[]): string =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i]!)))
      .join('  ')
      .trimEnd();
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

function printUsers(db: Database): void {
  const users = listUsers(db);
  if (users.length === 0) {
    console.log('Henüz kimse kaydolmamış.');
    return;
  }
  console.log(
    table(
      ['kullanıcı', 'isim', 'katıldı', 'en son', 'süren çelınc', 'not'],
      users.map((u) => [
        u.username,
        u.displayName,
        when(u.createdAt, false),
        when(u.lastSeenAt),
        String(u.activeChallenges),
        u.deletedAt ? `hesabını sildi (${when(u.deletedAt, false)})` : '',
      ]),
    ),
  );
  const deleted = users.filter((u) => u.deletedAt !== null).length;
  console.log(`\n${users.length - deleted} kişi${deleted > 0 ? `, ${deleted} silinmiş hesap` : ''}.`);
}

function printReports(db: Database): void {
  const reports = listReports(db);
  if (reports.length === 0) {
    console.log('Hiç şikayet yok. Kankalar uslu.');
    return;
  }
  console.log(
    table(
      ['ne zaman', 'şikayet eden', 'şikayet edilen', 'sebep'],
      // a reason typed on a phone can hold line breaks; one report, one line
      reports.map((r) => [when(r.createdAt), r.reporter, r.reported, r.reason.replace(/\s+/g, ' ')]),
    ),
  );
}

async function printPassword(db: Database, username: string | undefined): Promise<number> {
  if (!username || username.trim() === '') {
    console.error('✗ Kimin şifresi? Örnek: npm run yonet -- sifre ali');
    return 1;
  }
  const reset = await resetPassword(db, username);
  console.log(`${reset.displayName} (@${reset.username}) için yeni şifre:  ${reset.password}`);
  console.log('\nBunu ona yaz, bu şifreyle girsin.');
  return 0;
}

/** The database the server uses, or null (and a hint) when there is none here. */
function openExisting(): Database | null {
  // This signs no tokens; a stand-in secret keeps loadConfig from writing a
  // `secret` file into what may well be the wrong folder.
  const config = loadConfig({ jwtSecret: 'yonet' });
  const file = path.resolve(config.dbPath);
  if (!fs.existsSync(file)) {
    console.error(`✗ Veritabanı bulunamadı: ${file}`);
    console.error('  Sunucuyu hiç açmadın mı? Komutu depo klasöründe "npm run yonet -- ..." diye çalıştır.');
    return null;
  }
  return openDb(file);
}

async function main(argv: string[]): Promise<number> {
  const [word, ...rest] = argv;
  if (word === undefined || HELP_WORDS.has(word)) {
    console.log(HELP);
    return 0;
  }
  // "SIFRE" lowers to "sifre" in plain casing, "ŞİFRE" only in Turkish casing
  const command = COMMANDS[word.toLowerCase()] ?? COMMANDS[word.toLocaleLowerCase('tr')];
  if (!command) {
    console.error(`✗ "${word}" diye bir komut yok.\n`);
    console.error(HELP);
    return 1;
  }

  const db = openExisting();
  if (!db) return 1;
  try {
    if (command === 'users') printUsers(db);
    else if (command === 'reports') printReports(db);
    else return await printPassword(db, rest[0]);
    return 0;
  } finally {
    db.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
