import fs from 'fs';
import path from 'path';

/**
 * Every `router.push`/`replace`/`navigate` target and every `<Link href>` in the
 * app has to name a route that actually exists in `src/app`. Expo Router fails
 * these silently at runtime (a dead href just does nothing), so the check lives
 * here instead of in the type system.
 */

const APP_DIR = path.join(__dirname, '..', 'app');
const SRC_DIR = path.join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** `(app)/(tabs)/index.tsx` → `/`, `(app)/challenge/[id]/entry.tsx` → `/challenge/[id]/entry` */
function routeOf(file: string): string | null {
  const rel = path.relative(APP_DIR, file).split(path.sep).join('/');
  if (rel.endsWith('_layout.tsx')) return null;
  const noExt = rel.replace(/\.tsx?$/, '');
  const segments = noExt
    .split('/')
    .filter((segment) => !/^\(.+\)$/.test(segment)) // route groups are invisible in URLs
    .filter((segment, index, all) => !(segment === 'index' && index === all.length - 1));
  return `/${segments.join('/')}`;
}

/** Drops route groups and turns `${expr}` into the `[id]` slot it fills. */
function normalizeTarget(target: string): string {
  const withoutGroups = target
    .split('/')
    .filter((segment) => !/^\(.+\)$/.test(segment))
    .join('/');
  const withSlots = withoutGroups.replace(/\$\{[^}]*\}/g, '[id]');
  const trimmed = withSlots.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

const ROUTES = new Set(
  walk(APP_DIR)
    .map(routeOf)
    .filter((route): route is string => route !== null)
);

interface Target {
  file: string;
  raw: string;
}

/** Text of the argument list starting at the `(` at `open`. */
function callArguments(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return source.slice(open + 1);
}

const ROUTE_LITERAL = /['"`](\/[^'"`\n]*)['"`]/g;

function collectTargets(): Target[] {
  const targets: Target[] = [];
  // every path literal anywhere inside the call, so both arms of a
  // `router.push(cond ? '/a' : '/b')` get checked
  const calls = /router\.(?:push|replace|navigate)\s*\(/g;
  // `{ pathname: '/challenge/[id]' }` and `<Link href="/x">`
  const inline = [/pathname:\s*['"`](\/[^'"`]*)['"`]/g, /href=\{?['"`](\/[^'"`]*)['"`]/g];

  for (const file of walk(SRC_DIR)) {
    if (file.includes(`${path.sep}__tests__${path.sep}`)) continue;
    const source = fs.readFileSync(file, 'utf8');
    const rel = path.relative(SRC_DIR, file);

    calls.lastIndex = 0;
    let call: RegExpExecArray | null;
    while ((call = calls.exec(source)) !== null) {
      const args = callArguments(source, call.index + call[0].length - 1);
      ROUTE_LITERAL.lastIndex = 0;
      let literal: RegExpExecArray | null;
      while ((literal = ROUTE_LITERAL.exec(args)) !== null) {
        targets.push({ file: rel, raw: literal[1] });
      }
    }

    for (const pattern of inline) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) {
        targets.push({ file: rel, raw: match[1] });
      }
    }
  }
  return targets;
}

describe('route tree', () => {
  it('exposes every screen the SPEC lists', () => {
    expect([...ROUTES].sort()).toEqual([
      '/',
      '/challenge/[id]',
      '/challenge/[id]/entry',
      '/challenge/[id]/results',
      '/challenge/[id]/taunt',
      '/challenge/new',
      '/focus/[id]',
      '/friends',
      '/inbox',
      '/login',
      '/onboarding',
      '/profile',
      '/register',
      '/server',
      '/settings',
      '/user/[id]',
    ]);
  });

  it('finds the navigation calls it is meant to police', () => {
    // a regex that silently stops matching would make this suite pass vacuously
    expect(collectTargets().length).toBeGreaterThan(20);
  });

  it('never navigates to a route that does not exist', () => {
    const dead = collectTargets()
      .filter(({ raw }) => !ROUTES.has(normalizeTarget(raw)))
      .map(({ file, raw }) => `${file} → ${raw}`);
    expect(dead).toEqual([]);
  });
});

describe('dynamic screens', () => {
  const dynamic = [
    'app/(app)/challenge/[id]/index.tsx',
    'app/(app)/challenge/[id]/entry.tsx',
    'app/(app)/challenge/[id]/results.tsx',
    'app/(app)/challenge/[id]/taunt.tsx',
    'app/(app)/focus/[id].tsx',
    'app/(app)/user/[id].tsx',
  ];

  it.each(dynamic)('%s normalizes a missing route param', (rel) => {
    const source = fs.readFileSync(path.join(SRC_DIR, ...rel.split('/')), 'utf8');
    // `useLocalSearchParams<{ id: string }>()` lies: the value is missing on a
    // bare deep link, so every screen has to coerce it before use
    expect(source).toMatch(/typeof params\.id === 'string' \? params\.id : ''/);
  });

  it.each(dynamic)('%s renders something when the param is missing', (rel) => {
    const source = fs.readFileSync(path.join(SRC_DIR, ...rel.split('/')), 'utf8');
    // the query is `enabled: !!id`, so without this guard isPending never
    // clears and the screen shows a spinner forever
    expect(source).toMatch(/if \(!id\) \{/);
  });
});
