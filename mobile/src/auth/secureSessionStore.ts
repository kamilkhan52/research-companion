// A supabase-js storage adapter backed by expo-secure-store (Keychain / Keystore).
//
// Why not AsyncStorage, which every Supabase + Expo snippet uses: the stored value is the whole
// session, including the **refresh token** — a long-lived credential that mints new access tokens.
// AsyncStorage is unencrypted app-private storage, readable on a rooted/jailbroken device or out of
// an unencrypted backup. `src/api/config.ts` already puts the access token in SecureStore for
// exactly this reason; the refresh token deserves at least as much.
//
// Why the chunking: **SecureStore values are limited to 2048 bytes.** A Supabase session is a JSON
// blob holding an access JWT, a refresh token, and the full user object with its metadata — it
// routinely exceeds that. Android throws above the limit rather than truncating, so an unchunked
// adapter does not fail at write time in dev with a small user record and then start failing later
// for a user with a bigger one. It fails for whoever happens to cross the line, which is worse:
// their sign-in appears to work and does not survive a restart.

import * as SecureStore from 'expo-secure-store';

/** BYTES per chunk, under the platform's ~2048-byte value limit with room to spare.
 *
 *  Bytes, not characters — the limit the native keystore applies is on the encoded value. Slicing
 *  by `String.length` would let a session containing any multi-byte UTF-8 (an accented name, an
 *  emoji in `user_metadata`) produce a chunk of 1800 characters and up to 7200 bytes, which the
 *  platform rejects. That is the same "fails only for whoever happens to cross the line" failure
 *  chunking exists to prevent. */
const CHUNK_BYTES = 1800;

/** UTF-8 length of one code point. */
function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** Split on code-point boundaries while counting BYTES, so no chunk exceeds the budget and no
 *  surrogate pair is torn in half (which would corrupt the value on rejoin). */
function chunkByBytes(value: string, budget: number): string[] {
  const chunks: string[] = [];
  let current = '';
  let used = 0;
  for (const character of value) {
    const size = utf8Length(character.codePointAt(0)!);
    if (used + size > budget && current) {
      chunks.push(current);
      current = '';
      used = 0;
    }
    current += character;
    used += size;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Hard cap on chunks, so a corrupt or hostile count cannot spin us through unbounded reads. */
const MAX_CHUNKS = 32;

/** SecureStore keys must be alphanumeric + ".-_"; Supabase's own keys contain none of that, but
 *  normalize anyway so a future key change cannot silently break persistence. */
function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

const countKey = (key: string) => `${safeKey(key)}.n`;
const chunkKey = (key: string, index: number) => `${safeKey(key)}.${index}`;

async function clearChunks(key: string, upTo: number): Promise<void> {
  for (let i = 0; i < upTo; i += 1) {
    await SecureStore.deleteItemAsync(chunkKey(key, i)).catch(() => {});
  }
}

async function storedCount(key: string): Promise<number> {
  const raw = await SecureStore.getItemAsync(countKey(key)).catch(() => null);
  const n = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_CHUNKS) : 0;
}

export const secureSessionStore = {
  async getItem(key: string): Promise<string | null> {
    const count = await storedCount(key);
    if (!count) return null;
    const parts: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const part = await SecureStore.getItemAsync(chunkKey(key, i)).catch(() => null);
      // A missing chunk means a partially-written or partially-wiped session. Returning the
      // surviving prefix would hand supabase-js malformed JSON; treat it as no session, which
      // sends the user through sign-in instead of into an unparseable state.
      if (part == null) return null;
      parts.push(part);
    }
    return parts.join('');
  },

  async setItem(key: string, value: string): Promise<void> {
    const chunks = chunkByBytes(value, CHUNK_BYTES);
    if (chunks.length > MAX_CHUNKS) {
      throw new Error(
        `Session too large to store securely (${chunks.length} chunks, max ${MAX_CHUNKS}). ` +
        'Refusing rather than writing a session that cannot be read back.',
      );
    }
    // Write the chunks BEFORE the count. A crash between the two then leaves the old count with
    // new chunks — recoverable garbage that fails the JSON parse and sends the user to sign-in.
    // The other order can leave a count pointing at chunks that were never written.
    const previous = await storedCount(key);
    for (let i = 0; i < chunks.length; i += 1) {
      await SecureStore.setItemAsync(chunkKey(key, i), chunks[i]);
    }
    await SecureStore.setItemAsync(countKey(key), String(chunks.length));
    // Only now drop any tail left by a previously longer session.
    for (let i = chunks.length; i < previous; i += 1) {
      await SecureStore.deleteItemAsync(chunkKey(key, i)).catch(() => {});
    }
  },

  async removeItem(key: string): Promise<void> {
    const count = await storedCount(key);
    // Count first: if deletion is interrupted, a stale count is harmless (getItem returns null on
    // the first missing chunk) whereas orphaned chunks with a live count would look like a session.
    await SecureStore.deleteItemAsync(countKey(key)).catch(() => {});
    await clearChunks(key, Math.max(count, 1));
  },
};
