import { RegisterBodySchema, InboxQuerySchema, type RegisterBody } from '@koydum/shared';
import { parseBody, parseQuery } from '/home/user/repo/apps/server/src/errors.js';

const inferred = parseBody(RegisterBodySchema, {});
const explicit = parseBody<RegisterBody>(RegisterBodySchema, {});
const q = parseQuery(InboxQuerySchema, {});
// force type errors if inference degraded to unknown
const u: string = inferred.username;
const d: string = explicit.displayName;
const l: number = q.limit;
console.log(u, d, l);
