'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// EPUB episode merger
// Combines multiple episode EPUBs into a single EPUB in-memory.
// Uses regex-based XML manipulation — DOMParser is unavailable in service
// workers.  Mirrors the Python EpubMerger class in bookmate_downloader.py.
// ═══════════════════════════════════════════════════════════════════════════

const DEC = new TextDecoder();
const ENC = new TextEncoder();

// ── XML helpers ─────────────────────────────────────────────────────────────

/** Extract the value of a named attribute from an attribute string. */
function attr(attrsStr, name) {
  return new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(attrsStr)?.[1] ?? '';
}

/** Parse every <item …/> element in the OPF manifest. */
function parseManifestItems(opfText) {
  const items = [];
  // Match both self-closing and non-empty <item> tags
  for (const m of opfText.matchAll(/<item\b([^>]*)(?:\/>|>[^<]*<\/item>)/g)) {
    const a         = m[1];
    const id        = attr(a, 'id');
    const href      = attr(a, 'href');
    const mediaType = attr(a, 'media-type');
    if (href) items.push({ id, href, mediaType });
  }
  return items;
}

/** Parse all idref values from <itemref …> elements in the OPF spine. */
function parseSpineIdrefs(opfText) {
  return [...opfText.matchAll(/<itemref\b[^>]*\bidref="([^"]*)"/g)].map((m) => m[1]);
}

/** Return the text content inside <navMap>…</navMap>. */
function extractNavMapContent(ncxText) {
  // Use greedy .* so the match extends to the LAST </navMap> (handles nested navPoints).
  const m = ncxText.match(/<navMap[^>]*>([\s\S]*)<\/navMap>/);
  return m ? m[1] : '';
}

/**
 * Renumber every playOrder="…" attribute in xmlText sequentially,
 * starting from startFrom.  Returns { result, next } where next is
 * the first unused play-order value.
 */
function renumberPlayOrders(xmlText, startFrom) {
  let counter = startFrom;
  const result = xmlText.replace(/\bplayOrder="\d+"/g, () => `playOrder="${counter++}"`);
  return { result, next: counter };
}

/**
 * Insert content just before the LAST occurrence of closingTag in xml.
 * Falls back to appending when the tag is not found.
 */
function insertBefore(xml, closingTag, content) {
  const idx = xml.lastIndexOf(closingTag);
  if (idx === -1) return xml + content;
  return xml.slice(0, idx) + content + xml.slice(idx);
}

/** Escape special XML characters for use in text nodes / attribute values. */
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Resolve a filename conflict by inserting a suffix before the extension,
 * preserving any leading directory segments.
 * E.g. makeUniqueName('images/img.jpg', 'ep2') → 'images/img_ep2.jpg'
 */
function makeUniqueName(href, suffix) {
  const slash = href.lastIndexOf('/');
  const dir   = slash >= 0 ? href.slice(0, slash + 1) : '';
  const file  = slash >= 0 ? href.slice(slash + 1) : href;
  const dot   = file.lastIndexOf('.');
  const base  = dot >= 0 ? file.slice(0, dot) : file;
  const ext   = dot >= 0 ? file.slice(dot)    : '';
  return `${dir}${base}_${suffix}${ext}`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Merge an array of downloaded episode data structures into a single set of
 * EPUB files suitable for passing to buildEpub().
 *
 * Algorithm (mirrors Python EpubMerger):
 *   1. Seed the combined EPUB with episode 1's files.
 *   2. For each subsequent episode:
 *      a. Rename manifest items whose href or id conflicts with an existing one.
 *      b. Skip CSS files (use the first episode's stylesheet for all).
 *      c. Append new <item> elements to combined OPF <manifest>.
 *      d. Append remapped <itemref> elements to combined OPF <spine>.
 *      e. Renumber and append <navPoint> blocks to combined NCX <navMap>.
 *   3. Update <dc:title> in the combined OPF with bookTitle.
 *
 * @param {Array<{
 *   title: string,
 *   meta: { container: Uint8Array, opf: Uint8Array, ncx: Uint8Array, document_uuid: string },
 *   contentFiles: Object.<string, Uint8Array>
 * }>} episodes
 * @param {string} bookTitle
 * @returns {Array<{name: string, data: Uint8Array}>} files for buildEpub()
 */
export function mergeEpisodes(episodes, bookTitle) {
  if (!episodes.length) throw new Error('No episodes to merge');

  const base = episodes[0];

  // Combined in-memory content files: OEBPS-relative fname → Uint8Array
  const combinedContent = new Map(Object.entries(base.contentFiles));

  let combinedOpf = DEC.decode(base.meta.opf);
  let combinedNcx = DEC.decode(base.meta.ncx);
  const combinedContainer = base.meta.container;

  // Seed tracking sets from the base episode's manifest
  const existingHrefs = new Set(parseManifestItems(combinedOpf).map((i) => i.href));
  const existingIds   = new Set(parseManifestItems(combinedOpf).map((i) => i.id));

  // Renumber the base episode's navPoints starting from 1
  const baseNr = renumberPlayOrders(combinedNcx, 1);
  combinedNcx  = baseNr.result;
  let nextPlayOrder = baseNr.next;

  // ── Merge each subsequent episode ────────────────────────────────────────
  for (let epIdx = 1; epIdx < episodes.length; epIdx++) {
    const ep    = episodes[epIdx];
    const epOpf = DEC.decode(ep.meta.opf);
    const epNcx = DEC.decode(ep.meta.ncx);

    const epItems  = parseManifestItems(epOpf);
    const epIdrefs = parseSpineIdrefs(epOpf);

    const idRemap = new Map();   // old id → new id
    let newManifest = '';
    let newSpine    = '';

    for (const item of epItems) {
      // NCX is merged separately; CSS reuses the first episode's stylesheet
      if (item.href === 'toc.ncx') continue;
      if (item.href.toLowerCase().endsWith('.css') || item.mediaType === 'text/css') continue;

      // Resolve href conflict
      let newHref = item.href;
      if (existingHrefs.has(newHref)) {
        newHref = makeUniqueName(item.href, `ep${epIdx}`);
      }

      // Resolve id conflict
      let newId   = item.id;
      let idSuffix = 1;
      while (existingIds.has(newId)) {
        newId = `${item.id}_${idSuffix++}`;
      }

      idRemap.set(item.id, newId);
      existingHrefs.add(newHref);
      existingIds.add(newId);

      // Copy (possibly renamed) content file into combined map
      if (ep.contentFiles[item.href]) {
        combinedContent.set(newHref, ep.contentFiles[item.href]);
      }

      newManifest += `\n    <item id="${newId}" href="${newHref}" media-type="${item.mediaType}"/>`;
    }

    // Build spine entries (only items that have a mapping — CSS items were skipped)
    for (const idref of epIdrefs) {
      if (idRemap.has(idref)) {
        newSpine += `\n    <itemref idref="${idRemap.get(idref)}"/>`;
      }
    }

    combinedOpf = insertBefore(combinedOpf, '</manifest>', newManifest);
    combinedOpf = insertBefore(combinedOpf, '</spine>',    newSpine);

    // Merge NCX navPoints
    const epNavContent = extractNavMapContent(epNcx);
    if (epNavContent) {
      const epNr = renumberPlayOrders(epNavContent, nextPlayOrder);
      nextPlayOrder = epNr.next;
      combinedNcx = insertBefore(combinedNcx, '</navMap>', epNr.result);
    }
  }

  // Update dc:title in combined OPF
  combinedOpf = combinedOpf.replace(
    /<dc:title[^>]*>[^<]*<\/dc:title>/i,
    `<dc:title>${escapeXml(bookTitle)}</dc:title>`,
  );

  // Build files array — mimetype MUST be first (EPUB spec)
  const files = [
    { name: 'mimetype',               data: ENC.encode('application/epub+zip') },
    { name: 'META-INF/container.xml', data: combinedContainer },
    { name: 'OEBPS/content.opf',      data: ENC.encode(combinedOpf) },
    { name: 'OEBPS/toc.ncx',          data: ENC.encode(combinedNcx) },
  ];

  for (const [fname, data] of combinedContent) {
    files.push({ name: `OEBPS/${fname}`, data });
  }

  return files;
}
