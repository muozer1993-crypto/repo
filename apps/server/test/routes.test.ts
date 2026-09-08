/**
 * The seams: every endpoint SPEC 2.2 promises must be registered exactly once and
 * must actually answer.
 *
 * A route module that is never registered — or a path with a typo in it — passes
 * every other test in this suite, because those tests only ever call the routes
 * they know about. So this file walks Fastify's own route table (`printRoutes`)
 * instead of the source, and then proves reachability by injecting a request into
 * each path and refusing a 404.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { makeApp, type TestApp } from './helpers.js';

let harness: TestApp | null = null;

afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = null;
  }
});

type Route = { method: string; path: string };

/**
 * Flattens `app.printRoutes()` — a box-drawing tree whose children carry only
 * their own path segment — into `{ method, path }` rows.
 *
 * ```
 * ├── /challenges (GET, HEAD, POST)
 * │   └── /:id (GET, HEAD)
 * │       ├── /accept (POST)
 * ```
 * becomes GET/HEAD/POST /challenges, GET/HEAD /challenges/:id, POST /challenges/:id/accept.
 */
function routeTable(app: FastifyInstance): Route[] {
  const tree = app.printRoutes({ commonPrefix: false });
  const prefixes: string[] = [];
  const routes: Route[] = [];

  for (const line of tree.split('\n')) {
    const connector = line.search(/[├└]── /);
    if (connector < 0) continue;
    const depth = Math.floor(connector / 4);
    const rest = line.slice(connector + 4);

    const match = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(rest);
    const segment = match ? match[1] : rest.trim();
    const methods = match ? match[2].split(',').map((m) => m.trim()) : [];

    prefixes.length = depth;
    prefixes[depth] = segment;
    const full = prefixes.slice(0, depth + 1).join('');
    for (const method of methods) routes.push({ method, path: full });
  }

  return routes;
}

/**
 * Comparable form of a path: parameter names are an implementation detail
 * (`/friends/:friendshipId/accept` and `/friends/:id/accept` are the same route),
 * and the tree prints the static plugin's wildcard as `/uploads` + `*`.
 */
function normalize(routePath: string): string {
  return routePath
    .replace(/:[A-Za-z0-9_]+(\|:[A-Za-z0-9_]+)*/g, ':p')
    .replace(/([^/])\*$/, '$1/*');
}

/** Every endpoint in the SPEC 2.2 table, in the order it is listed there. */
const SPEC_ENDPOINTS: [HTTPMethods, string][] = [
  ['GET', '/health'],
  ['POST', '/auth/register'],
  ['POST', '/auth/login'],
  ['GET', '/me'],
  ['PATCH', '/me'],
  ['DELETE', '/me'],
  ['POST', '/me/push-token'],
  ['DELETE', '/me/push-token'],
  ['POST', '/me/steps'],
  ['GET', '/me/inbox'],
  ['POST', '/me/inbox/read'],
  ['GET', '/me/inbox/unread'],
  ['GET', '/users/search'],
  ['GET', '/users/:id'],
  ['POST', '/users/:id/block'],
  ['POST', '/users/:id/unblock'],
  ['POST', '/users/:id/report'],
  ['GET', '/friends'],
  ['POST', '/friends/request'],
  ['POST', '/friends/:friendshipId/accept'],
  ['POST', '/friends/:friendshipId/decline'],
  ['DELETE', '/friends/:userId'],
  ['GET', '/catalog'],
  ['GET', '/challenges'],
  ['POST', '/challenges'],
  ['GET', '/challenges/:id'],
  ['POST', '/challenges/:id/accept'],
  ['POST', '/challenges/:id/decline'],
  ['POST', '/challenges/:id/leave'],
  ['POST', '/challenges/:id/cancel'],
  ['POST', '/challenges/:id/entries'],
  ['DELETE', '/challenges/:id/entries/:entryId'],
  ['POST', '/challenges/:id/entries/:entryId/dispute'],
  ['POST', '/challenges/:id/poke'],
  ['POST', '/challenges/:id/taunt'],
  ['POST', '/challenges/:id/rematch'],
  ['GET', '/challenges/:id/results'],
  ['GET', '/leaderboard'],
  ['POST', '/uploads'],
  ['GET', '/uploads/*'],
];

/** A concrete URL to inject for each SPEC path — parameters filled with junk. */
function sampleUrl(specPath: string): string {
  return specPath.replace(/:[A-Za-z0-9_]+/g, 'yok').replace(/\*$/, 'yok.jpg');
}

describe('SPEC 2.2 route table', () => {
  it('registers every endpoint the SPEC promises', async () => {
    harness = await makeApp();
    const table = routeTable(harness.app).map((r) => `${r.method} ${normalize(r.path)}`);

    const missing = SPEC_ENDPOINTS.filter(
      ([method, specPath]) => !table.includes(`${method} ${normalize(specPath)}`),
    ).map(([method, specPath]) => `${method} ${specPath}`);

    expect(missing).toEqual([]);
    // …and Fastify agrees, parameter names aside.
    for (const [method, specPath] of SPEC_ENDPOINTS) {
      expect(harness.app.hasRoute({ method, url: specPath }), `${method} ${specPath}`).toBe(true);
    }
  });

  it('registers each method+path exactly once', async () => {
    harness = await makeApp();
    const seen = new Map<string, number>();
    for (const route of routeTable(harness.app)) {
      const key = `${route.method} ${normalize(route.path)}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    expect([...seen.entries()].filter(([, count]) => count > 1)).toEqual([]);
  });

  it('answers on every endpoint instead of falling through to the 404 handler', async () => {
    harness = await makeApp();

    for (const [method, specPath] of SPEC_ENDPOINTS) {
      if (specPath === '/uploads/*') continue; // covered below, with a real file
      const response = await harness.app.inject({ method, url: sampleUrl(specPath) });
      expect(response.statusCode, `${method} ${specPath} → ${response.statusCode}`).not.toBe(404);
      // Everything behind `Authorization: Bearer` says so rather than 404-ing.
      if (specPath !== '/health' && specPath !== '/catalog' && !specPath.startsWith('/auth/')) {
        expect(response.json<{ error: { code: string } }>().error.code, `${method} ${specPath}`).toBe('unauthorized');
      }
    }
  });

  it('serves uploaded proof photos from the static mount', async () => {
    harness = await makeApp();
    fs.writeFileSync(path.join(harness.config.uploadDir, 'kanit.txt'), 'koydum');

    const response = await harness.app.inject({ method: 'GET', url: '/uploads/kanit.txt' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('koydum');
  });

  it('mounts the dev routes only when they are enabled', async () => {
    harness = await makeApp({ config: { enableDevRoutes: false } });
    expect(harness.app.hasRoute({ method: 'POST', url: '/dev/reset' })).toBe(false);
    await harness.close();

    harness = await makeApp({ config: { enableDevRoutes: true } });
    expect(harness.app.hasRoute({ method: 'POST', url: '/dev/finalize/:id' })).toBe(true);
    expect(harness.app.hasRoute({ method: 'POST', url: '/dev/advance' })).toBe(true);
    expect(harness.app.hasRoute({ method: 'POST', url: '/dev/reset' })).toBe(true);
  });
});
