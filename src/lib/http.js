'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Shared HTTP / file utilities — imported by bookmate.js and audiobook.js
// ═══════════════════════════════════════════════════════════════════════════

export const READER_BASE = 'https://reader.bookmate.com';

export async function fetchWithCookie(url) {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp;
}

/**
 * Convert a Blob to a data-URL via FileReader.
 * Needed because chrome.downloads.download() does not accept blob: URLs
 * from service workers.
 */
export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Sanitise a string for use as part of a filename.
 * Removes characters forbidden on Windows / macOS / Linux.
 */
export function safeName(s) {
  return String(s).replace(/[/\\?%*:|"<>]/g, '_').trim();
}
