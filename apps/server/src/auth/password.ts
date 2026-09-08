/**
 * Password hashing with node:crypto scrypt (no native dependency, Node >= 20).
 *
 * Stored format: `scrypt$<saltHex>$<hashHex>` — the algorithm name is part of the
 * string so a future migration can recognise old hashes.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'scrypt';
const SALT_BYTES = 16;
const KEY_LENGTH = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

function derive(plain: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(plain.normalize('NFKC'), salt, KEY_LENGTH, SCRYPT_PARAMS, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/** `hashPassword('sifre123')` → `'scrypt$<saltHex>$<hashHex>'`. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(plain, salt);
  return `${ALGORITHM}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** Constant-time comparison; false (never throws) for malformed stored values. */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  const [algorithm, saltHex, hashHex] = parts as [string, string, string];
  if (algorithm !== ALGORITHM || saltHex.length === 0 || hashHex.length === 0) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== KEY_LENGTH) return false;

  try {
    const actual = await derive(plain, salt);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
