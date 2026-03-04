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

function makeComparator(criteria) {
  return (a, b) => {
    // Outermost: trash and bloat penalties
    const trashDiff = (a._isTrash ? 1 : 0) - (b._isTrash ? 1 : 0);
    if (trashDiff !== 0) return trashDiff;

    const bloatDiff = (a._isBloat ? 1 : 0) - (b._isBloat ? 1 : 0);
    if (bloatDiff !== 0) return bloatDiff;

    // User criteria
    for (const criterion of criteria) {
      if (criterion === 'cached') continue;
      let diff = 0;
      if (criterion === 'resolution') {
        diff = QUALITY_ORDER.indexOf(a._res) - QUALITY_ORDER.indexOf(b._res);
      } else if (criterion === 'size') {
        diff = b._size - a._size;
      } else if (criterion === 'seeders') {
        diff = b._seeders - a._seeders;
      } else if (criterion === 'source') {
        diff = SOURCE_QUALITY_ORDER.indexOf(a._source) - SOURCE_QUALITY_ORDER.indexOf(b._source);
      } else if (criterion === 'english') {
        diff = (b._isEng ? 1 : 0) - (a._isEng ? 1 : 0);
      } else if (criterion === 'subs') {
        diff = (b._hasSubs ? 1 : 0) - (a._hasSubs ? 1 : 0);
      }
      if (diff !== 0) return diff;
    }

    // Automatic sub-tiers: HDR → Audio → Codec
    const hdrDiff = a._hdrTier - b._hdrTier;
    if (hdrDiff !== 0) return hdrDiff;

    const audioDiff = a._audioTier - b._audioTier;
    if (audioDiff !== 0) return audioDiff;

    const codecDiff = a._codecTier - b._codecTier;
    if (codecDiff !== 0) return codecDiff;

    // Final tiebreaker: addon order
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
  const cmp = makeComparator(criteria);

  // 1. One-pass pre-calculation to save CPU cycles during sorting
  const memoized = streams.map(s => {
    // We only attach these properties temporarily for the sort phase
    s._cacheTier = getCacheTier(s);
    s._isTrash = isTrash(s);
    s._isBloat = isBloat(s, type);
    s._res = extractResolution(s);
    s._size = extractSizeGb(s);
    s._seeders = extractSeeders(s);
    s._source = extractSourceQuality(s);
    s._isEng = isEnglishAudio(s);
    s._hasSubs = hasEmbeddedSubs(s);
    s._hdrTier = getHdrTier(s);
    s._audioTier = getAudioTier(s);
    s._codecTier = getCodecTier(s);
    return s;
  });

  // 2. Split-sort using the memoized properties
  if (criteria.includes('cached')) {
    const cached   = memoized.filter(s => s._cacheTier === 'cached');
    const download = memoized.filter(s => s._cacheTier === 'download');
    const p2p      = memoized.filter(s => s._cacheTier === 'p2p');
    return [...cached.sort(cmp), ...download.sort(cmp), ...p2p.sort(cmp)];
  }

  return memoized.sort(cmp);
}
