// api/utils/sort.js
// Stream sorting: split-sort by cache status, trash/bloat penalties, automatic sub-tiers.

import {
  getCacheTier, isCachedDebrid, isEnglishAudio, hasEmbeddedSubs,
  extractResolution, extractSourceQuality, extractSeeders, extractSizeGb,
  QUALITY_ORDER, HDR_TAGS, AUDIO_TAGS, CODEC_TAGS,
} from './parse.js';

export const SOURCE_QUALITY_ORDER     = ['Remux', 'BluRay', 'WEB-DL', 'WEBRip', 'HDTV', 'DVD', 'unknown'];
export const DIVERSITY_SOURCE_PRIORITY = ['Remux', 'BluRay', 'WEB-DL', 'WEBRip', 'HDTV', 'DVD'];
export const DIVERSITY_HDR_PRIORITY    = ['DV', 'HDR10+', 'HDR10', 'HDR', 'HLG'];

const TRASH_RE = /\b(cam|hdcam|ts|telesync|screener|scr|dvdscr|r5|tc|telecine)\b/i;

export const BLOAT_GB = {
  movie:  { '4k': 160, '2160p': 160, '1080p': 45, '720p': 15, '480p': 5, '360p': 5 },
  series: { '4k': 30,  '2160p': 30,  '1080p': 12, '720p': 5,  '480p': 2, '360p': 2 },
};

// ---------------------------------------------------------------------------
// Automatic sub-tier helpers (HDR → Audio → Codec)
// Lower index = better quality
// ---------------------------------------------------------------------------

function getHdrTier(stream) {
  const haystack = `${stream.name ?? ''} ${stream.title ?? ''} ${stream.description ?? ''} ${stream.behaviorHints?.filename ?? ''}`;
  for (let i = 0; i < HDR_TAGS.length; i++) {
    if (HDR_TAGS[i][0].test(haystack)) return i;
  }
  return HDR_TAGS.length; // no HDR → last
}

function getAudioTier(stream) {
  const haystack = `${stream.name ?? ''} ${stream.title ?? ''} ${stream.description ?? ''} ${stream.behaviorHints?.filename ?? ''}`;
  for (let i = 0; i < AUDIO_TAGS.length; i++) {
    if (AUDIO_TAGS[i][0].test(haystack)) return i;
  }
  return AUDIO_TAGS.length;
}

function getCodecTier(stream) {
  const haystack = `${stream.name ?? ''} ${stream.title ?? ''} ${stream.description ?? ''} ${stream.behaviorHints?.filename ?? ''}`;
  for (let i = 0; i < CODEC_TAGS.length; i++) {
    if (CODEC_TAGS[i][0].test(haystack)) return i;
  }
  return CODEC_TAGS.length;
}

// ---------------------------------------------------------------------------
// Penalty helpers
// ---------------------------------------------------------------------------

function isTrash(stream) {
  const haystack = [stream.name, stream.title, stream.behaviorHints?.filename]
    .filter(Boolean).join(' ');
  return TRASH_RE.test(haystack);
}

function isBloat(stream, type) {
  const size = extractSizeGb(stream);
  if (size === 0) return false; // unknown size → no penalty
  const res = extractResolution(stream);
  const thresholds = BLOAT_GB[type] ?? BLOAT_GB.movie;
  const threshold  = thresholds[res];
  if (!threshold) return false;
  return size > threshold;
}

// ---------------------------------------------------------------------------
// Core comparator (shared by both split-sort halves)
// ---------------------------------------------------------------------------

function makeComparator(criteria, type) {
  return (a, b) => {
    // Outermost: trash and bloat penalties
    const trashDiff = (isTrash(a) ? 1 : 0) - (isTrash(b) ? 1 : 0);
    if (trashDiff !== 0) return trashDiff;

    const bloatDiff = (isBloat(a, type) ? 1 : 0) - (isBloat(b, type) ? 1 : 0);
    if (bloatDiff !== 0) return bloatDiff;

    // User criteria (skip 'cached' — handled by split-sort, not comparator)
    for (const criterion of criteria) {
      if (criterion === 'cached') continue;
      let diff = 0;
      if (criterion === 'resolution') {
        diff = QUALITY_ORDER.indexOf(extractResolution(a))
             - QUALITY_ORDER.indexOf(extractResolution(b));
      } else if (criterion === 'size') {
        diff = extractSizeGb(b) - extractSizeGb(a);
      } else if (criterion === 'seeders') {
        diff = extractSeeders(b) - extractSeeders(a);
      } else if (criterion === 'source') {
        diff = SOURCE_QUALITY_ORDER.indexOf(extractSourceQuality(a))
             - SOURCE_QUALITY_ORDER.indexOf(extractSourceQuality(b));
      } else if (criterion === 'english') {
        diff = (isEnglishAudio(b) ? 1 : 0) - (isEnglishAudio(a) ? 1 : 0);
      } else if (criterion === 'subs') {
        diff = (hasEmbeddedSubs(b) ? 1 : 0) - (hasEmbeddedSubs(a) ? 1 : 0);
      }
      if (diff !== 0) return diff;
    }

    // Automatic sub-tiers: HDR → Audio → Codec
    const hdrDiff = getHdrTier(a) - getHdrTier(b);
    if (hdrDiff !== 0) return hdrDiff;

    const audioDiff = getAudioTier(a) - getAudioTier(b);
    if (audioDiff !== 0) return audioDiff;

    const codecDiff = getCodecTier(a) - getCodecTier(b);
    if (codecDiff !== 0) return codecDiff;

    // Final tiebreaker: addon order (lower = higher priority)
    return (a._addonIdx ?? 999) - (b._addonIdx ?? 999);
  };
}

// ---------------------------------------------------------------------------
// Public sort function
// ---------------------------------------------------------------------------

/**
 * Sorts streams by ranked-choice criteria with split-sort for cached status.
 *
 * @param {object[]} streams
 * @param {string[]} sortCriteria - ordered array of sort keys
 * @param {string}   type         - 'movie' | 'series' (used for bloat thresholds)
 * @returns {object[]}
 */
export function sortStreams(streams, sortCriteria, type = 'movie') {
  const criteria = Array.isArray(sortCriteria) ? sortCriteria : [sortCriteria];
  const cmp = makeComparator(criteria, type);

  // Split-sort: if 'cached' is in criteria, sort each half independently then concat.
  // This guarantees all cached streams appear before uncached, regardless of other criteria.
  if (criteria.includes('cached')) {
    const cached   = streams.filter(s => getCacheTier(s) === 'cached');
    const download = streams.filter(s => getCacheTier(s) === 'download');
    const p2p      = streams.filter(s => getCacheTier(s) === 'p2p');
    return [...cached.sort(cmp), ...download.sort(cmp), ...p2p.sort(cmp)];
  }

  return [...streams].sort(cmp);
}
