/**
 * Cryptographically strong initial-password generator for admin-created
 * participants. Uses Web Crypto (`crypto.getRandomValues`, available in workerd
 * and Node 22) over an unambiguous alphabet (no 0/O/1/l/I), and guarantees at
 * least one lowercase, one uppercase, and one digit. Never uses `Math.random`,
 * never logs the value. The password is returned once in the Action response
 * and shared out-of-band; it is never stored in plaintext.
 */
const LOWER = "abcdefghijkmnpqrstuvwxyz"; // no l
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I, O
const DIGITS = "23456789"; // no 0, 1
const ALPHABET = LOWER + UPPER + DIGITS;

function randomByte(): number {
  const buf = new Uint8Array(1);
  crypto.getRandomValues(buf);
  return buf[0];
}

/** Uniform integer in [0, maxExclusive) via rejection sampling (no modulo bias). */
function randomInt(maxExclusive: number): number {
  const limit = Math.floor(256 / maxExclusive) * maxExclusive;
  let byte = randomByte();
  while (byte >= limit) {
    byte = randomByte();
  }
  return byte % maxExclusive;
}

function randomChar(chars: string): string {
  return chars.charAt(randomInt(chars.length));
}

/** In-place Fisher–Yates shuffle using rejection-sampled indices. */
function shuffle(items: string[]): string[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
  return items;
}

export function generatePassword(length = 16): string {
  if (length < 3) {
    throw new Error("Password length must be at least 3 to satisfy the character-class guarantee.");
  }
  // Seed one of each required class, then fill the rest from the full alphabet.
  const chars = [randomChar(LOWER), randomChar(UPPER), randomChar(DIGITS)];
  for (let i = chars.length; i < length; i++) {
    chars.push(randomChar(ALPHABET));
  }
  return shuffle(chars).join("");
}
