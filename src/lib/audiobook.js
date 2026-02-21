'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Audiobook download
// Fetches track playlist via the Bookmate API and triggers individual
// chrome.downloads.download() calls for each .m4a track, or packages them
// all into a single .zip file.
// ═══════════════════════════════════════════════════════════════════════════

import { buildZip } from './epub.js';
import { fetchWithCookie, blobToDataUrl, safeName, READER_BASE } from './http.js';

// ── Private helpers ──────────────────────────────────────────────────────────

/**
 * Resolve a single track's display number and direct .m4a URL.
 * Returns { num, audioUrl } where audioUrl is null if no URL is available.
 */
function resolveTrack(track, bitrate, fallbackIndex) {
  const num      = typeof track.number === 'number' ? track.number : fallbackIndex + 1;
  const rawUrl   = track?.offline?.[bitrate]?.url ?? null;
  const audioUrl = rawUrl ? rawUrl.replace(/\.m3u8(\?.*)?$/, '.m4a') : null;
  return { num, audioUrl };
}

/** Build the per-track base filename (without extension). */
function trackBaseName(titlePart, authorSfx, num, totalTracks) {
  return totalTracks === 1
    ? `${titlePart}${authorSfx}`
    : `${titlePart} - Chapter ${num}${authorSfx}`;
}

/**
 * Fetch audiobook title, authors and raw track list without downloading anything.
 * Used by the background service worker to report track count to the popup
 * before the user commits to a download format.
 *
 * @param {string} bookid
 * @returns {Promise<{ bookTitle: string, bookAuthors: object[], tracks: object[] }>}
 */
export async function fetchAudiobookMeta(bookid) {
  const [infoResp, playlistResp] = await Promise.all([
    fetchWithCookie(`${READER_BASE}/p/api/v5/audiobooks/${bookid}`),
    fetchWithCookie(`${READER_BASE}/p/api/v5/audiobooks/${bookid}/playlists.json`),
  ]);
  const info     = await infoResp.json();
  const playlist = await playlistResp.json();

  return {
    bookTitle:   info?.audiobook?.title   || bookid,
    bookAuthors: info?.audiobook?.authors || [],
    tracks:      playlist?.tracks         || [],
  };
}

/**
 * Download an audiobook.
 *
 * When asZip is false (default):
 *   Triggers one chrome.downloads.download() per track — files land in the
 *   browser's default download folder individually.
 *
 * When asZip is true:
 *   Fetches every .m4a track as a binary blob, packs them into a ZIP archive
 *   (stored, no compression — audio is already compressed), and triggers a
 *   single chrome.downloads.download() of the resulting .zip file.
 *
 * Filename rules:
 *   • 1 track  → "{title} - {author}.m4a"  (or .zip)
 *   • N tracks → individual: "{title} - Chapter {N} - {author}.m4a"
 *               zip:         "{title} - {author}.zip"
 *
 * @param {string}   bookid
 * @param {boolean}  maxBitRate  – true = max_bit_rate, false = min_bit_rate
 * @param {boolean}  asZip       – true = bundle all tracks into one .zip
 * @param {Function} onProgress  – (text: string, pct: number) => void
 * @returns {Promise<string>}    – human-readable summary of saved file(s)
 */
export async function downloadAudiobook(bookid, maxBitRate, asZip, onProgress) {
  // ── 1. Fetch audiobook info + playlist ────────────────────────────────
  onProgress('Fetching audiobook info…', 5);
  const { bookTitle, bookAuthors, tracks } = await fetchAudiobookMeta(bookid);

  if (!tracks.length) throw new Error('No tracks found for this audiobook');

  onProgress(`Found ${tracks.length} track(s) — "${bookTitle}"`, 10);

  const bitrate   = maxBitRate ? 'max_bit_rate' : 'min_bit_rate';
  const authorSfx = bookAuthors.length ? ` - ${safeName(bookAuthors.map(a => a.name).join(', '))}` : '';
  const titlePart = safeName(bookTitle);

  // 2a. ZIP download — fetch all tracks, pack into one archive
  if (asZip) {
    const zipFiles = [];

    for (let i = 0; i < tracks.length; i++) {
      const { num, audioUrl } = resolveTrack(tracks[i], bitrate, i);
      const pct = 10 + Math.round(((i + 1) / tracks.length) * 80);
      onProgress(`Fetching track ${num}/${tracks.length}…`, pct);

      if (!audioUrl) {
        console.warn(`[bookmate] No ${bitrate} URL for track ${num} — skipping`);
        continue;
      }

      const resp = await fetchWithCookie(audioUrl);
      const data = new Uint8Array(await resp.arrayBuffer());
      zipFiles.push({ name: `${trackBaseName(titlePart, authorSfx, num, tracks.length)}.m4a`, data });
    }

    if (!zipFiles.length) throw new Error('No tracks could be downloaded');

    onProgress('Building ZIP archive…', 92);
    const zipBytes = buildZip(zipFiles);
    const blob     = new Blob([zipBytes], { type: 'application/zip' });
    const dataUrl  = await blobToDataUrl(blob);
    const zipName  = `${titlePart}${authorSfx}.zip`;

    onProgress('Saving ZIP…', 97);
    await chrome.downloads.download({ url: dataUrl, filename: zipName, saveAs: false });
    return zipName;
  }

  // 2b. Individual file download — trigger one chrome.downloads call per track
  const savedNames = [];

  for (let i = 0; i < tracks.length; i++) {
    const { num, audioUrl } = resolveTrack(tracks[i], bitrate, i);
    const pct = 10 + Math.round(((i + 1) / tracks.length) * 85);
    onProgress(`Downloading track ${num}/${tracks.length}…`, pct);

    if (!audioUrl) {
      console.warn(`[bookmate] No ${bitrate} URL for track ${num} — skipping`);
      continue;
    }

    const filename = `${trackBaseName(titlePart, authorSfx, num, tracks.length)}.m4a`;
    await chrome.downloads.download({ url: audioUrl, filename, saveAs: false });
    savedNames.push(filename);
  }

  if (!savedNames.length) throw new Error('No tracks could be downloaded');

  return savedNames.length === 1
    ? savedNames[0]
    : `${savedNames.length} tracks for "${bookTitle}"`;
}
