import type { CryptoMeta } from '@/types';

/**
 * Defense-in-depth: the PAT is AES-GCM encrypted in chrome.storage, not stored
 * as plaintext. The key is PBKDF2-derived from a fixed app secret — this is not
 * OS-keychain-grade, but raises the bar over plaintext in a zero-server model.
 */

const APP_SECRET = 'better-github-stars-manager/v1/static-derivation-secret';
const PBKDF2_ITERS = 150_000;
const KEY_LEN = 256;

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64encode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function deriveKey(salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(APP_SECRET) as BufferSource, 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: KEY_LEN },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt a plaintext string. Returns ciphertext (b64) + meta (iv, salt, both b64). */
export async function encrypt(plaintext: string): Promise<{ cipher: string; meta: CryptoMeta }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(salt);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    enc.encode(plaintext) as BufferSource,
  );
  return {
    cipher: b64encode(ct),
    meta: { iv: b64encode(iv), salt: b64encode(salt) },
  };
}

/** Decrypt given ciphertext (b64) + meta. Returns plaintext, or null if it fails. */
export async function decrypt(cipher: string, meta: CryptoMeta): Promise<string | null> {
  try {
    const key = await deriveKey(b64decode(meta.salt));
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64decode(meta.iv) as BufferSource },
      key,
      b64decode(cipher) as BufferSource,
    );
    return dec.decode(pt);
  } catch {
    return null;
  }
}
