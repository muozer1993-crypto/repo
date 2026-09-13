import fs from 'fs';
import path from 'path';

/**
 * The phone runs Hermes, not V8. Hermes on Android ships `Intl.DateTimeFormat`
 * and `Intl.NumberFormat` but NOT `Intl.RelativeTimeFormat`, `Intl.ListFormat`,
 * `Intl.PluralRules` or `Intl.DisplayNames`. A `new` on any of those is
 * "undefined cannot be used as a constructor" on a real device while every
 * test and the web build sail through — that is exactly how the inbox and the
 * challenge screen came to crash in the first APK. So the source may not name
 * them; `Intl.Segmenter` is allowed only behind a typeof guard (shared/text.ts).
 */

const SRC_DIRS = [
  path.join(__dirname, '..'),
  path.join(__dirname, '..', '..', '..', '..', 'packages', 'shared', 'src'),
];
const BANNED = ['RelativeTimeFormat', 'ListFormat', 'PluralRules', 'DisplayNames'];

/** Comments are allowed to explain why an API is banned; only code counts. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('Hermes-safe Intl usage', () => {
  it('never constructs an Intl API that Hermes on Android does not provide', () => {
    const offenders: string[] = [];
    for (const file of SRC_DIRS.flatMap((dir) => walk(dir))) {
      const source = stripComments(fs.readFileSync(file, 'utf8'));
      for (const api of BANNED) {
        if (new RegExp(`Intl\\.${api}\\b`).test(source)) {
          offenders.push(`${path.relative(process.cwd(), file)}: Intl.${api}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('only touches Intl.Segmenter behind a typeof guard', () => {
    for (const file of SRC_DIRS.flatMap((dir) => walk(dir))) {
      const source = fs.readFileSync(file, 'utf8');
      if (!/new Intl\.Segmenter/.test(source)) continue;
      expect(source).toMatch(/typeof Intl\.Segmenter === 'function'/);
    }
  });
});
