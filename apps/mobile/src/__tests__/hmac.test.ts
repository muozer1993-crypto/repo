/** The phone's own SHA-256 / HMAC must agree with node:crypto byte for byte. */
import { createHash, createHmac, randomBytes } from 'crypto';

import { fromBase64Url, hmacSha256, sha256, toBase64Url, utf8 } from '@/utils/hmac';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('sha256', () => {
  it('matches the FIPS test vectors and node for every padding length', () => {
    expect(hex(sha256(utf8('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hex(sha256(utf8('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    for (let length = 0; length < 200; length += 1) {
      const data = randomBytes(length);
      expect(hex(sha256(new Uint8Array(data)))).toBe(createHash('sha256').update(data).digest('hex'));
    }
  });
});

describe('hmacSha256', () => {
  it('matches node for short, block-sized and long keys', () => {
    for (const keyLength of [0, 1, 32, 64, 65, 100]) {
      const key = randomBytes(keyLength);
      const message = randomBytes(77);
      expect(hex(hmacSha256(new Uint8Array(key), new Uint8Array(message)))).toBe(
        createHmac('sha256', key).update(message).digest('hex')
      );
    }
  });
});

describe('utf8 and base64url', () => {
  it('encodes like node', () => {
    const text = 'çelınc 🍆 KOYDUM MU?';
    expect(Buffer.from(utf8(text)).toString('utf8')).toBe(text);
    for (let length = 0; length < 40; length += 1) {
      const data = randomBytes(length);
      const encoded = toBase64Url(new Uint8Array(data));
      expect(encoded).toBe(data.toString('base64url'));
      expect(Buffer.from(fromBase64Url(encoded) ?? []).equals(data)).toBe(true);
    }
    expect(fromBase64Url('bad+/')).toBeNull();
  });
});
