/**
 * npm run yonet — the server owner's toolbox (services/admin.ts, services/backup.ts), in Turkish.
 *
 *   npm run yonet -- kullanicilar        everybody, when they last came by, running çelınclar
 *   npm run yonet -- sikayetler          reports, newest first
 *   npm run yonet -- sifre <kullanici>   a new password for a friend who forgot theirs
 *   npm run yonet -- yedekler            the daily backups, here and in BACKUP_DIR
 *   npm run yonet -- geri-yukle [yedek]  a backup back in place of the database
 *
 * npm runs a workspace script with apps/server as the cwd, so the default
 * DATA_DIR './data' is the very database the server uses. Run from anywhere else
 * it would find (or quietly create) a different one, hence the refusal below when
 * the file is missing. Safe while the server runs: WAL lets a second connection
 * in and busy_timeout waits out the server's writes. All but geri-yukle, which
 * swaps the file out from under the server and so refuses while it answers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_TIMEZONE, dayKeyInTz, localTimeHHmm } from '@koydum/shared';
import { loadConfig, type Config } from '../config.js';
import { openDb, type Database } from '../db/index.js';
import { loadDotEnv } from '../env.js';
import { listReports, listUsers, resetPassword } from '../services/admin.js';
import {
  backupCopyDir,
  backupDir,
  findBackup,
  listBackups,
  restoreBackup,
  SERVER_OPEN,
  type BackupFile,
} from '../services/backup.js';

const HELP = `KOYDUM yönetim komutları (sunucuyu açan kişi için)

  npm run yonet -- kullanicilar        herkes: ne zaman katıldı, en son ne zaman girdi, kaç çelıncı sürüyor
  npm run yonet -- sikayetler          gelen şikayetler, en yenisi en üstte
  npm run yonet -- sifre <kullanici>   şifresini unutan kankaya yeni şifre
  npm run yonet -- yedekler            veritabanının günlük yedekleri ve nerede durdukları
  npm run yonet -- geri-yukle [yedek]  bir yedeği geri yükler (adını yazmazsan en yenisini)

Sunucu açıkken de çalışır. Sadece geri-yukle için önce sunucuyu kapat.`;

type Command = 'users' | 'reports' | 'password' | 'backups' | 'restore';

/** The owner may well type the Turkish letters; both spellings work. */
const COMMANDS: Record<string, Command> = {
  kullanicilar: 'users',
  kullanıcılar: 'users',
  sikayetler: 'reports',
  şikayetler: 'reports',
  sifre: 'password',
  şifre: 'password',
  yedekler: 'backups',
  'geri-yukle': 'restore',
  'geri-yükle': 'restore',
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
  console.log(
    '\nBunu ona yaz, bu şifreyle girsin. Sonra Ayarlar → Hesap → "Şifreni değiştir"den kendi şifresini koysun' +
      ' (yeni sürümde; 1.0\'da bu düğme yok, önce güncellesin).',
  );
  return 0;
}

/** 1,2 MB the way a Turkish reader writes it. */
function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

/** One folder's backups, or why they cannot be read. Returns how many there are. */
function printFolder(title: string, dir: string, empty: string): number {
  console.log(`${title}: ${dir}`);
  let backups: BackupFile[];
  try {
    backups = listBackups(dir);
  } catch (err) {
    console.log(`✗ Bu klasör okunamadı: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
  if (backups.length === 0) console.log(empty);
  else console.log(table(['yedek', 'alındı', 'boyut'], backups.map((b) => [b.name, when(b.modifiedAt.toISOString()), size(b.size)])));
  return backups.length;
}

function printBackups(config: Config): void {
  let count = printFolder('Bu bilgisayarda', backupDir(config), 'Henüz yedek yok.');
  const copies = backupCopyDir(config);
  console.log('');
  if (copies) {
    count += printFolder('BACKUP_DIR', copies, 'Henüz kopya yok. Sunucu açıkken buraya kendisi kopyalar.');
  } else {
    console.log('Bu klasör veritabanıyla aynı diskte: disk giderse yedekler de gider.');
    console.log("apps/server/.env dosyasına BACKUP_DIR=<OneDrive'daki bir klasör> yazarsan her yedeğin bir kopyası oraya da gider.");
  }
  if (count === 0) {
    console.log('\nSunucu her gün ilk açıldığında bir yedek alır.');
    return;
  }
  const newest = findBackup(config);
  console.log(`\nGeri yüklemek için önce sunucuyu kapat, sonra: npm run yonet -- geri-yukle ${newest?.name ?? ''}`.trimEnd());
  console.log('Adını yazmazsan en yenisini yükler.');
}

/** Is a KOYDUM server answering on this machine? Two seconds, then no. */
async function serverAnswers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return ((await response.json()) as { ok?: unknown }).ok === true;
  } catch {
    // nothing listening, or something that is not KOYDUM
    return false;
  }
}

async function restore(config: Config, wanted: string | undefined): Promise<number> {
  // the friendly check; restoreBackup also catches a server this one misses (another HOST)
  if (await serverAnswers(config.port)) {
    console.error(`✗ ${SERVER_OPEN}`);
    return 1;
  }
  const backup = findBackup(config, wanted);
  if (!backup) {
    if (wanted) console.error(`✗ "${wanted}" diye bir yedek bulamadım. Hangileri var: npm run yonet -- yedekler`);
    else console.error('✗ Hiç yedek yok. Sunucu her gün ilk açıldığında bir tane alır.');
    return 1;
  }

  const { previous } = restoreBackup(config, backup.file, new Date());
  console.log(`Yüklenen yedek: ${backup.file} (${when(backup.modifiedAt.toISOString())})`);
  console.log(`Yerine kondu:   ${path.resolve(config.dbPath)}`);
  if (previous) {
    console.log(`\nEskisi silinmedi, şurada duruyor: ${previous}`);
    console.log(`Yanlış yedeği seçtiysen onu geri koy: npm run yonet -- geri-yukle "${previous}"`);
  }
  console.log('\nŞimdi sunucuyu aç.');
  return 0;
}

/**
 * The server's own settings: its .env, so a DATA_DIR or BACKUP_DIR set there
 * finds the same folders. This signs no tokens; a stand-in secret keeps
 * loadConfig from writing a `secret` file into what may well be the wrong folder.
 */
function ownerConfig(): Config {
  loadDotEnv();
  return loadConfig({ jwtSecret: 'yonet' });
}

/** The database the server uses, or null (and a hint) when there is none here. */
function openExisting(config: Config): Database | null {
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

  const config = ownerConfig();
  // these two keep no connection to the live database: geri-yukle needs it
  // closed (restoreBackup only opens it for a moment, to see whether somebody
  // else holds it), and a connection of ours would hold its -wal open
  if (command === 'backups') {
    printBackups(config);
    return 0;
  }
  if (command === 'restore') return await restore(config, rest[0]);

  const db = openExisting(config);
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
