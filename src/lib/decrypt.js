'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// AES-CBC decryption  (Web Crypto API — no external libraries)
// ═══════════════════════════════════════════════════════════════════════════

export function base64ToBytes(b64) {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function decryptValue(secret, intArray) {
  // mirror of Python decrypt():
  //   key  = base64.b64decode(secret)
  //   iv   = data[:16]
  //   data = data[16:]
  //   plaintext = AES_CBC.decrypt(data), strip PKCS#7 pad
  const raw  = new Uint8Array(intArray);
  const iv   = raw.slice(0, 16);
  const body = raw.slice(16);
  const keyBytes = base64ToBytes(secret);

  const key = await crypto.subtle.importKey(
    'raw', keyBytes,
    { name: 'AES-CBC' },
    false,
    ['decrypt']
  );
  const decryptedBuf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, body);
  const decrypted = new Uint8Array(decryptedBuf);
  const padSize   = decrypted[decrypted.length - 1]; // PKCS#7
  return decrypted.slice(0, decrypted.length - padSize);
}

// ═══════════════════════════════════════════════════════════════════════════
// Extract window.CLIENT_PARAMS from reader page HTML
// (mirrors ScriptParser in the Python script)
// ═══════════════════════════════════════════════════════════════════════════

export function extractClientParams(html) {
  const MARKER = 'window.CLIENT_PARAMS';
  const idx = html.indexOf(MARKER);
  if (idx === -1) throw new Error('window.CLIENT_PARAMS not found in page HTML');
  const after    = html.slice(idx + MARKER.length);
  const eqIdx    = after.indexOf('=');
  const semiIdx  = after.indexOf(';');
  const jsonText = after.slice(eqIdx + 1, semiIdx).trim();
  return JSON.parse(jsonText);
}
