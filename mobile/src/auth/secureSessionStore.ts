// A supabase-js storage adapter backed by expo-secure-store (Keychain / Keystore).
//
// Why not AsyncStorage, which every Supabase + Expo snippet uses: the stored value is the whole
// session, including the **refresh token** — a long-lived credential that mints new access tokens.
// AsyncStorage is unencrypted app-private storage, readable on a rooted/jailbroken device or out of
// an unencrypted backup. `src/api/config.ts` already puts the access token in SecureStore for
// exactly this reason; the refresh token deserves at least as much.
//
// Two things make this more than a thin wrapper:
//
// 1. **Values are limited to roughly 2048 BYTES.** A session (access JWT + refresh token + the user
//    object with its metadata) routinely exceeds that, and the platform rejects the write rather
//    than truncating — so an unchunked adapter fails for whoever's profile happens to cross the
//    line, and fails quietly: their sign-in appears to work and does not survive a restart.
//
// 2. **A write must never be able to half-apply.** Overwriting chunks in place means a process
//    death between the last chunk and the manifest can leave chunk 0 from the new session beside
//    chunk 1 from the old one. Two sessions for the same user have identical JSON shape and
//    near-identical lengths, so that mixture can still *parse* — yielding a session with a new
//    access token and a stale refresh token, or after an account switch, a mix of two accounts.
//    So writes alternate between two slots and the manifest is committed last: an interrupted
//    write leaves the manifest pointing at the previous slot, which is still complete.

import * as SecureStore from 'expo-secure-store';

/** BYTES per chunk, under the platform's ~2048-byte value limit with room to spare.
 *
 *  Bytes, not characters — the limit applies to the encoded value. Slicing by `String.length`
 *  would let a session containing multi-byte UTF-8 (an accented name, an emoji in `user_metadata`)
 *  produce a chunk of 1800 characters and up to 7200 bytes. */
const CHUNK_BYTES = 1800;

/** Hard cap on chunks, so a corrupt or hostile manifest cannot spin us through unbounded reads,
 *  and so cleanup can sweep a slot exhaustively without trusting a stored count. */
const MAX_CHUNKS = 32;

type Slot = 'a' | 'b';

/** UTF-8 length of one code point. */
function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** Split on code-point boundaries while counting BYTES, so no chunk exceeds the budget and no
 *  surrogate pair is torn in half. A lone surrogate is not encodable as UTF-8: it becomes U+FFFD
 *  and the session never parses again. */
export function chunkByBytes(value: string, budget: number): string[] {
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

/** SecureStore keys must be alphanumeric + ".-_"; normalize so a future change to Supabase's own
 *  key format cannot silently break persistence. */
function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

const manifestKey = (key: string) => `${safeKey(key)}.m`;
const chunkKey = (key: string, slot: Slot, index: number) => `${safeKey(key)}.${slot}.${index}`;

interface Manifest { slot: Slot; n: number }

async function readManifest(key: string): Promise<Manifest | null> {
  const raw = await SecureStore.getItemAsync(manifestKey(key)).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Manifest;
    if ((parsed.slot !== 'a' && parsed.slot !== 'b') || !Number.isInteger(parsed.n)) return null;
    if (parsed.n < 1 || parsed.n > MAX_CHUNKS) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Sweep a slot exhaustively rather than up to a stored count: cleanup must not depend on the
 *  manifest, because the case it exists for is a manifest that is missing or already stale. */
async function purgeSlot(key: string, slot: Slot): Promise<void> {
  for (let i = 0; i < MAX_CHUNKS; i += 1) {
    await SecureStore.deleteItemAsync(chunkKey(key, slot, i)).catch(() => {});
  }
}

export const secureSessionStore = {
  async getItem(key: string): Promise<string | null> {
    const manifest = await readManifest(key);
    if (!manifest) return null;
    const parts: string[] = [];
    for (let i = 0; i < manifest.n; i += 1) {
      const part = await SecureStore.getItemAsync(chunkKey(key, manifest.slot, i)).catch(() => null);
      // A missing chunk means a partially-wiped slot. Returning the surviving prefix would hand
      // supabase-js malformed JSON; treat it as no session, which sends the user through sign-in.
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
    const current = await readManifest(key);
    // Write to the slot NOT currently in use, so the readable session stays intact until the
    // manifest flips. This is the whole reason a torn write cannot produce a mixed session.
    const target: Slot = current?.slot === 'a' ? 'b' : 'a';

    await purgeSlot(key, target);  // a previous interrupted write may have left a longer tail
    for (let i = 0; i < chunks.length; i += 1) {
      await SecureStore.setItemAsync(chunkKey(key, target, i), chunks[i]);
    }
    // The commit point. Everything before this is invisible; everything after is cleanup.
    await SecureStore.setItemAsync(manifestKey(key), JSON.stringify({ slot: target, n: chunks.length }));
    if (current) await purgeSlot(key, current.slot);
  },

  async removeItem(key: string): Promise<void> {
    // Manifest first: an interrupted removal then reads as "no session" rather than as a live one.
    await SecureStore.deleteItemAsync(manifestKey(key)).catch(() => {});
    // Both slots, exhaustively — a stale slot still holds a usable refresh token, and this is the
    // storage we chose specifically to protect it.
    await purgeSlot(key, 'a');
    await purgeSlot(key, 'b');
  },
};
