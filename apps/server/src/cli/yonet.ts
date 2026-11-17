/**
 * npm run yonet — the server owner's toolbox (services/admin.ts, services/backup.ts), in Turkish.
 *
 *   npm run yonet -- kullanicilar        everybody, when they last came by, running çelınclar
 *   npm run yonet -- sikayetler          reports, newest first
 *   npm run yonet -- sifre <kullanici>   a new password for a friend who forgot theirs
 *   npm run yonet -- sil <kullanici>     closes an account, as "Hesabı sil" in the app does
 *   npm run yonet -- yedekler            the daily backups, here and in BACKUP_DIR
 *   npm run yonet -- geri-yukle [yedek]  a backup back in place of the database
 *
 * npm runs a workspace script with apps/server as the cwd, so the default
 * DATA_DIR './data' is the very database the server uses. Run from anywhere else
 * it would find (or quietly create) a different one, hence the refusal below when
 * the file is missing. Safe while the server runs: WAL lets a second connection
 * in and busy_timeout waits out the server's writes. All but geri-yukle, which
 * swaps the file out from under the server and so refuses while it answers.
 * sil cannot be undone, so it asks first; with nobody at the keyboard to answer
 * it only goes ahead with --evet.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { DEFAULT_TIMEZONE, dayKeyInTz, localTimeHHmm, singleLine, stripEscapeSequences, stripInvisible } from '@koydum/shared';
import { loadConfig, type Config } from '../config.js';
import { openDb, type Database } from '../db/index.js';
import { loadDotEnv } from '../env.js';
import { accountToDelete, countReports, deleteAccount, listReports, listUsers, resetPassword } from '../services/admin.js';
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
  npm run yonet -- sil <kullanici>     hesabı kapatır: giriş yapamaz, süren çelınclarından çıkar, kanıt fotoğrafları silinir
  npm run yonet -- yedekler            veritabanının günlük yedekleri ve nerede durdukları
  npm run yonet -- geri-yukle [yedek]  bir yedeği geri yükler (adını yazmazsan en yenisini)

Sunucu açıkken de çalışır. Sadece geri-yukle için önce sunucuyu durdur:
npm run internet penceresinde dur yazıp Enter'a bas (npm run server ise o pencerede Ctrl+C).`;

type Command = 'users' | 'reports' | 'password' | 'delete' | 'backups' | 'restore';

/** The owner may well type the Turkish letters; both spellings work. */
const COMMANDS: Record<string, Command> = {
  kullanicilar: 'users',
  kullanıcılar: 'users',
  sikayetler: 'reports',
  şikayetler: 'reports',
  sifre: 'password',
  şifre: 'password',
  sil: 'delete',
  kapat: 'delete',
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
        u.deletedAt ? `silindi (${when(u.deletedAt, false)})` : '',
      ]),
    ),
  );
  const deleted = users.filter((u) => u.deletedAt !== null).length;
  console.log(`\n${users.length - deleted} kişi${deleted > 0 ? `, ${deleted} silinmiş hesap` : ''}.`);
}

/**
 * A reason as the owner's console may print it: one line, no control character and
 * no escape sequence (one cleared the whole listing, another hid what followed).
 * The API cleans reasons as they come in; this covers the ones stored before.
 */
function plainReason(reason: string): string {
  return singleLine(stripInvisible(stripEscapeSequences(reason)));
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
      reports.map((r) => [when(r.createdAt), r.reporter, r.reported, plainReason(r.reason)]),
    ),
  );
  const total = countReports(db);
  if (total > reports.length) console.log(`\nToplam ${total} şikayet var, en yeni ${reports.length} tanesini gösterdim.`);
}

async function printPassword(db: Database, username: string | undefined): Promise<number> {
  if (!username || username.trim() === '') {
    console.error('✗ Kimin şifresi? Örnek: npm run yonet -- sifre ali');
    return 1;
  }
  const reset = await resetPassword(db, username);
  console.log(`${reset.displayName} (@${reset.username}) için yeni şifre:  ${reset.password}`);
  console.log(
    '\nAçık kalan bütün oturumları kapandı. Bunu ona yaz, bu şifreyle girsin.' +
      ' Sonra Ayarlar → Hesap → "Şifreni değiştir"den kendi şifresini koysun' +
      ' (yeni sürümde; 1.0\'da bu düğme yok, önce güncellesin).',
  );
  return 0;
}

/** Waits for the owner's answer on the terminal; only "evet" (or "e") is a yes. */
async function ask(question: string): Promise<boolean> {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Ctrl+C closes the prompt and leaves the question hanging: that is a no too
  const closed = new Promise<string>((resolve) => terminal.once('close', () => resolve('')));
  try {
    const answer = await Promise.race([terminal.question(`${question} `), closed]);
    return ['evet', 'e'].includes(answer.trim().toLocaleLowerCase('tr'));
  } finally {
    terminal.close();
  }
}

async function closeAccount(db: Database, uploadDir: string, args: string[]): Promise<number> {
  const sure = args.includes('--evet');
  const username = args.find((arg) => arg !== '--evet');
  if (!username || username.trim() === '') {
    console.error('✗ Kimin hesabı? Örnek: npm run yonet -- sil ali');
    return 1;
  }
  const account = accountToDelete(db, username);
  if (!sure) {
    // piped or run by a script: nobody can answer, and a guess here is never undone
    if (!process.stdin.isTTY) {
      console.error(`✗ Sormadan silmem. Eminsen sonuna --evet ekle: npm run yonet -- sil ${account.username} --evet`);
      return 1;
    }
    if (!(await ask(`${account.displayName} (@${account.username}) silinsin mi? Geri alınamaz. (evet/hayır)`))) {
      // the owner's own answer, so nothing failed; only a terminal gets this far
      console.log('\nPeki, hesaba dokunmadım.');
      return 0;
    }
  }
  const closed = deleteAccount(db, account.username, new Date(), path.resolve(uploadDir));
  console.log(`Tamam, @${closed.username} kapatıldı. Telefonundaki oturum hemen düştü.`);
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
  console.log("\nGeri yüklemek için önce sunucuyu durdur: npm run internet penceresinde dur yazıp Enter'a bas");
  console.log(`(npm run server ise o pencerede Ctrl+C). Sonra: npm run yonet -- geri-yukle ${newest?.name ?? ''}`.trimEnd());
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

  const { previous, accounts } = restoreBackup(config, backup.file, new Date());
  console.log(`Yüklenen yedek: ${backup.file} (${when(backup.modifiedAt.toISOString())}, ${accounts} hesap)`);
  console.log(`Yerine kondu:   ${path.resolve(config.dbPath)}`);
  if (previous) {
    console.log(`\nEskisi silinmedi, şurada duruyor: ${previous}`);
    console.log(`Yanlış yedeği seçtiysen onu geri koy: npm run yonet -- geri-yukle "${previous}"`);
  }
  // An empty server's copy, which earlier versions wrote: served as it is, every
  // friend's login gets "Kullanıcı adı ya da şifre yanlış." Loaded all the same,
  // the old database aside as always, but no "open the server" under it.
  if (accounts === 0) {
    // The same day in the other folder may be the real one (BACKUP_DIR kept the
    // copy taken before the data folder was lost). Its day or its name loads
    // this computer's copy again (`findBackup`), so it is named by its full path.
    const here = path.resolve(path.dirname(backup.file));
    const twin = [backupDir(config), backupCopyDir(config)]
      .filter((dir): dir is string => dir !== null && path.resolve(dir) !== here)
      .map((dir) => path.join(dir, backup.name))
      .find((file) => fs.existsSync(file));
    console.log(
      `\n! Bu yedekte hiç hesap yok. Sunucuyu açmadan önce başka bir ${twin ? 'yedek' : 'günün yedeğini'} yükle.`,
    );
    if (twin) {
      // a day or a name finds this computer's copy first
      const byDayAgain = here === path.resolve(backupDir(config));
      console.log(
        `  Aynı günün bir kopyası daha var, önce onu dene${byDayAgain ? ' (tarihini yazarsan yine bunu yükler)' : ''}:`,
      );
      console.log(`  npm run yonet -- geri-yukle "${twin}"`);
    }
    console.log('  Hangileri var: npm run yonet -- yedekler');
    return 0;
  }
  // the window `dur` stopped brings it back behind the same tunnel; a new
  // `npm run internet` would hand every friend a new address
  console.log('\nŞimdi sunucuyu aç:');
  console.log("  npm run internet penceresinde dur yazdıysan orada y yazıp Enter'a bas: adres değişmez.");
  console.log('  Yoksa npm run internet ya da npm run server ile aç.');
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
    else if (command === 'delete') return await closeAccount(db, config.uploadDir, rest);
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
