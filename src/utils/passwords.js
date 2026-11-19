import crypto from 'node:crypto';
import { promisify } from 'node:util';

// Passwords are stored as salted scrypt hashes, a slow, memory-hard function
// made for passwords (fast hashes such as MD5 or SHA-256 are not suitable).
// Stored format: scrypt$N$r$p$salt$hash, with salt and hash in base64.
const scrypt = promisify(crypto.scrypt);
const PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return crypto.timingSafeEqual(key, expected);
}

// Spends the same time as a real check, so a login attempt for an unknown
// email cannot be told apart from one with a wrong password.
const DUMMY_HASH = await hashPassword(crypto.randomBytes(16).toString('hex'));
export async function fakeVerify(password) {
  await verifyPassword(String(password), DUMMY_HASH);
}
