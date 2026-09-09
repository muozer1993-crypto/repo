import fs from 'fs';
import path from 'path';

/**
 * Expo Go, Android: `import * as Notifications from 'expo-notifications'` throws
 * while the module is evaluated, because the barrel re-exports a module whose
 * top level registers a push-token listener and push was removed from Expo Go in
 * SDK 53. Expo Router then hands `undefined` back for the route and the app dies
 * on `Cannot read property 'ErrorBoundary' of undefined` — a white screen for
 * everyone who tries KOYDUM the easy way.
 *
 * The rule that keeps that from coming back: exactly one module may reach the
 * package, and only from inside a `require()` it can catch.
 */

const SRC_DIR = path.join(__dirname, '..');
const LOADER = path.join(SRC_DIR, 'services', 'expoNotifications.ts');
const PACKAGE = 'expo-notifications';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.name === '__tests__') continue; // the tests are allowed to name it
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Comments talk about the package on purpose; only code counts. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '');
}

describe('expo-notifications is never imported statically', () => {
  const files = walk(SRC_DIR).filter((file) => file !== LOADER);

  it('is not named in the code of any module but the loader', () => {
    const offenders = files.filter((file) =>
      new RegExp(`['"]${PACKAGE}`).test(stripComments(fs.readFileSync(file, 'utf8')))
    );
    expect(offenders.map((file) => path.relative(SRC_DIR, file))).toEqual([]);
  });

  it('is reached only through require() or an erased type import in the loader', () => {
    const source = stripComments(fs.readFileSync(LOADER, 'utf8'));
    const mention = new RegExp(`(.{0,24})['"]${PACKAGE}[^'"]*['"]`, 'g');

    let count = 0;
    for (let hit = mention.exec(source); hit !== null; hit = mention.exec(source)) {
      count += 1;
      // `require('…')` is catchable; `typeof import('…')` is erased before runtime
      expect(hit[1]).toMatch(/(?:require|import)\(\s*$/);
    }
    expect(count).toBeGreaterThan(0);
    expect(new RegExp(`^\\s*import\\s[^\\n]*['"]${PACKAGE}`, 'm').test(source)).toBe(false);
  });

  it('keeps every deep import pointing at a file that exists', () => {
    const source = fs.readFileSync(LOADER, 'utf8');
    const deep = source.match(new RegExp(`${PACKAGE}/build/[A-Za-z.]+`, 'g')) ?? [];
    expect(deep.length).toBeGreaterThan(0);
    for (const specifier of new Set(deep)) {
      const base = path.join(SRC_DIR, '..', '..', '..', 'node_modules', specifier);
      const found = ['.js', '.native.js', '.android.js', '.ios.js'].some((extension) =>
        fs.existsSync(base + extension)
      );
      expect({ specifier, found }).toEqual({ specifier, found: true });
    }
  });
});
