// api/utils/filter.js
// Filtering, deduplication (exact + fuzzy), and smart tiering.

import {
  extractResolution, extractSourceQuality, extractQualityTags,
  extractSeeders, extractSizeGb, isCachedDebrid,
  HDR_LABELS, CODEC_LABELS, SOURCE_LABELS, AUDIO_LABELS, QUALITY_ORDER,
} from './parse.js';

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
      const srcName = stream._addonName ?? '';
      result.push({ ...stream, _sources: srcName ? [srcName] : [] });
    } else {
      const dupSrc = stream._addonName ?? '';
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
        const dupSrc = s._addonName ?? '';
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
// Smart Tiering (Customizable Top vs Balanced Limits)
// ---------------------------------------------------------------------------

export function applySmartTiering(streams, tierTop, tierBalanced) {
  if (tierTop <= 0 && tierBalanced <= 0) return streams;

  const keptStreams = new Set();
  const resGroups  = new Map();

  for (const s of streams) {
    const r = extractResolution(s);
    if (!resGroups.has(r)) resGroups.set(r, []);
    resGroups.get(r).push(s);
  }

  for (const [, group] of resGroups.entries()) {
    let maxSize = 0;
    for (const s of group) {
      const sz = extractSizeGb(s);
      if (sz > maxSize) maxSize = sz;
    }

    const r = extractResolution(group[0]);
    let threshold = maxSize * 0.5;
    if (r === '4k' || r === '2160p') threshold = Math.max(threshold, 25);
    else if (r === '1080p')          threshold = Math.max(threshold, 12);
    else if (r === '720p')           threshold = Math.max(threshold, 5);
    else                             threshold = Math.max(threshold, 2);

    const selected  = [];
    const leftovers = [];
    let topCount = 0, balancedCount = 0;

    for (const s of group) {
      const sz         = extractSizeGb(s);
      const isBalanced = sz > 0 && sz <= threshold;

      if (!isBalanced) {
        if (topCount < tierTop) { selected.push(s); topCount++; }
        else leftovers.push(s);
      } else {
        if (balancedCount < tierBalanced)   { selected.push(s); balancedCount++; }
        else if (topCount  < tierTop)       { selected.push(s); topCount++; }
        else leftovers.push(s);
      }
    }

    const needed = (tierTop + tierBalanced) - selected.length;
    for (let i = 0; i < needed && leftovers.length > 0; i++) selected.push(leftovers.shift());

    for (const s of selected) keptStreams.add(s);
  }

  return streams.filter(s => keptStreams.has(s));
}
