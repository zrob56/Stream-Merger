// api/utils/filter.js
// Filtering, deduplication (exact + fuzzy), per-resolution cap, and diversity interleave.

import {
  extractResolution, extractSourceQuality, extractQualityTags,
  extractSeeders, extractSizeGb, isCachedDebrid,
  HDR_LABELS, CODEC_LABELS, SOURCE_LABELS, AUDIO_LABELS, QUALITY_ORDER,
} from './parse.js';
import { DIVERSITY_SOURCE_PRIORITY, DIVERSITY_HDR_PRIORITY } from './sort.js';

// ---------------------------------------------------------------------------
// Filter application
// ---------------------------------------------------------------------------

export function applyFilters(streams, filters) {
  return streams.filter(s => {
    if (filters.excludeTerms.length > 0) {
      const hay = `${s.name ?? ''} ${s.title ?? ''}`.toLowerCase();
      if (filters.excludeTerms.some(t => hay.includes(t))) return false;
    }
    if (filters.requiredHdr.length > 0) {
      const tags     = extractQualityTags(s);
      const detected = HDR_LABELS.filter(h => tags.includes(h));
      if (detected.length > 0 && !filters.requiredHdr.some(h => detected.includes(h))) return false;
    }
    if (filters.requiredCodec.length > 0) {
      const tags     = extractQualityTags(s);
      const detected = CODEC_LABELS.filter(c => tags.includes(c));
      if (detected.length > 0 && !filters.requiredCodec.some(c => detected.includes(c))) return false;
    }
    if (filters.requiredSource && filters.requiredSource.length > 0) {
      const tags     = extractQualityTags(s);
      const detected = SOURCE_LABELS.filter(src => tags.includes(src));
      if (detected.length > 0 && !filters.requiredSource.some(src => detected.includes(src))) return false;
    }
    if (filters.requiredAudio && filters.requiredAudio.length > 0) {
      const tags     = extractQualityTags(s);
      const detected = AUDIO_LABELS.filter(a => tags.includes(a));
      if (detected.length > 0 && !filters.requiredAudio.some(a => detected.includes(a))) return false;
    }
    if (filters.cachedOnly && !isCachedDebrid(s)) return false;
    if (filters.minSeeders > 0 && extractSeeders(s) < filters.minSeeders) return false;
    if (filters.maxSizeGb  > 0 && extractSizeGb(s)  > filters.maxSizeGb)  return false;
    if (filters.minResolution) {
      const minIdx    = QUALITY_ORDER.indexOf(filters.minResolution);
      const streamIdx = QUALITY_ORDER.indexOf(extractResolution(s));
      if (streamIdx === QUALITY_ORDER.length - 1 || streamIdx > minIdx) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Deduplication — two-pass: exact then fuzzy
// ---------------------------------------------------------------------------

/**
 * Removes duplicate streams.
 *
 * Pass 1 (exact): dedup by infoHash+fileIdx or url (unchanged behavior).
 * Pass 2 (fuzzy): merge streams with identical resolution+sourceQuality+codec
 *   where both have a parseable size and sizes differ by ≤ 0.05 GB.
 *
 * @param {object[]} streams - already sorted (best-first)
 * @returns {object[]}
 */
export function deduplicateStreams(streams) {
  // --- Pass 1: exact dedup ---
  const seen   = new Map(); // normalized key → index in result[]
  const result = [];

  for (const stream of streams) {
    const key = stream.infoHash
      ? (stream.infoHash + (stream.fileIdx != null ? ':' + stream.fileIdx : ''))
      : (stream.url ?? null);

    if (!key) { result.push(stream); continue; }

    const normalized = key.toLowerCase();
    if (!seen.has(normalized)) {
      seen.set(normalized, result.length);
      const srcName = (stream.name ?? '').split('\n')[0].trim();
      result.push({ ...stream, _sources: srcName ? [srcName] : [] });
    } else {
      const dupSrc = (stream.name ?? '').split('\n')[0].trim();
      if (dupSrc) {
        const kept = result[seen.get(normalized)];
        if (!kept._sources.includes(dupSrc)) kept._sources.push(dupSrc);
      }
    }
  }

  // --- Pass 2: fuzzy dedup ---
  // Key: resolution|sourceQuality|codec
  // Gate: both streams must have parseable size AND |sizeA - sizeB| ≤ 0.05 GB
  const CODEC_LABELS_SUBSET = ['AV1', 'x265', 'x264'];
  const fuzzyBuckets = new Map(); // key → [{ idx, size }]
  const keep = new Array(result.length).fill(true);

  for (let i = 0; i < result.length; i++) {
    const s = result[i];
    const sizeA = extractSizeGb(s);
    if (sizeA === 0) continue; // no size → skip fuzzy

    const res   = extractResolution(s);
    const src   = extractSourceQuality(s);
    const codec = extractQualityTags(s).find(t => CODEC_LABELS_SUBSET.includes(t)) ?? 'none';
    const key   = `${res}|${src}|${codec}`;

    if (!fuzzyBuckets.has(key)) {
      fuzzyBuckets.set(key, [{ idx: i, size: sizeA }]);
      continue;
    }

    const candidates = fuzzyBuckets.get(key);
    let merged = false;
    for (const cand of candidates) {
      if (Math.abs(cand.size - sizeA) <= 0.05) {
        // Merge: append this stream's source into the kept stream's _sources
        const dupSrc = (s.name ?? '').split('\n')[0].trim();
        if (dupSrc && !result[cand.idx]._sources.includes(dupSrc)) {
          result[cand.idx]._sources.push(dupSrc);
        }
        keep[i] = false;
        merged = true;
        break;
      }
    }
    if (!merged) {
      candidates.push({ idx: i, size: sizeA });
    }
  }

  return result.filter((_, i) => keep[i]);
}

// ---------------------------------------------------------------------------
// Per-resolution cap
// ---------------------------------------------------------------------------

export function capByResolution(streams, maxPerTier) {
  const counts = {};
  return streams.filter(s => {
    const r = extractResolution(s);
    counts[r] = (counts[r] ?? 0) + 1;
    return counts[r] <= maxPerTier;
  });
}

// ---------------------------------------------------------------------------
// Stream diversity — round-robin interleave across quality buckets
// ---------------------------------------------------------------------------

export function getSizeTier(stream) {
  const gb = extractSizeGb(stream);
  if (gb === 0) return 'unknown';
  if (gb <  15) return 'compact'; // <15 GB  — 720p / small WEB-DL
  if (gb <  50) return 'mid';     // 15–50 GB — 4K WEB-DL, 1080p Remux
  return 'full';                  // ≥50 GB  — 4K Remux
}

export function diversifyStreams(streams) {
  const buckets     = new Map();
  const bucketOrder = [];

  for (const stream of streams) {
    const res  = extractResolution(stream);
    const tags = extractQualityTags(stream);
    const src  = DIVERSITY_SOURCE_PRIORITY.find(t => tags.includes(t)) ?? 'other';
    const hdr  = DIVERSITY_HDR_PRIORITY.find(t => tags.includes(t))    ?? 'SDR';
    const size = getSizeTier(stream);
    const key  = `${res}|${src}|${hdr}|${size}`;
    if (!buckets.has(key)) { buckets.set(key, []); bucketOrder.push(key); }
    buckets.get(key).push(stream);
  }

  const result = [];
  for (let round = 0; result.length < streams.length; round++) {
    let added = false;
    for (const key of bucketOrder) {
      const bucket = buckets.get(key);
      if (round < bucket.length) { result.push(bucket[round]); added = true; }
    }
    if (!added) break;
  }
  return result;
}
