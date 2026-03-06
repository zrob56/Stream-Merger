// api/utils/filter.js
// Filtering, deduplication (exact + fuzzy), and smart tiering.

import {
  extractResolution, extractSourceQuality, extractQualityTags,
  extractSeeders, extractSizeGb, extractBitrateMbps, isCachedDebrid, extractEpisodes,
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

      // Allow 'unknown' resolutions (the last index) to pass through as a fallback.
      // Only block explicitly tagged resolutions that fall below the minimum index.
      if (streamIdx !== QUALITY_ORDER.length - 1 && streamIdx > minIdx) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Deduplication — two-pass: exact then fuzzy
// ---------------------------------------------------------------------------

function extractReleaseGroup(stream) {
  const h = (stream.behaviorHints?.filename || stream.title || '').split('\n')[0];
  const match = h.match(/-([a-zA-Z0-9]+)(?:\.[a-z0-9]{3,4})?$/i);
  return match ? match[1].toLowerCase() : 'unknown';
}

export function deduplicateStreams(streams) {
  const seen   = new Map(); // normalized key -> index in result[]
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

  const CODEC_LABELS_SUBSET = ['AV1', 'x265', 'x264'];
  const fuzzyBuckets = new Map(); // key -> [{ idx, size, rls }]
  const keep = new Array(result.length).fill(true);

  for (let i = 0; i < result.length; i++) {
    const s = result[i];
    const sizeA = extractSizeGb(s);
    if (sizeA === 0) continue;

    const res   = extractResolution(s);
    const src   = extractSourceQuality(s);
    const codec = extractQualityTags(s).find(t => CODEC_LABELS_SUBSET.includes(t)) ?? 'none';
    const rls   = extractReleaseGroup(s);
    const key   = `${res}|${src}|${codec}`;

    if (!fuzzyBuckets.has(key)) {
      fuzzyBuckets.set(key, [{ idx: i, size: sizeA, rls }]);
      continue;
    }

    const candidates = fuzzyBuckets.get(key);
    let merged = false;
    for (const cand of candidates) {
      // Same release group gets a wider tolerance because file metadata often differs slightly.
      const isSameGroup = rls !== 'unknown' && cand.rls !== 'unknown' && rls === cand.rls;
      const tolerance = isSameGroup ? 0.5 : 0.05;

      if (Math.abs(cand.size - sizeA) <= tolerance) {
        const dupSrc = s._addonName ?? '';
        if (dupSrc && !result[cand.idx]._sources.includes(dupSrc)) {
          result[cand.idx]._sources.push(dupSrc);
        }
        keep[i] = false;
        merged = true;
        break;
      }
    }
    if (!merged) candidates.push({ idx: i, size: sizeA, rls });
  }

  return result.filter((_, i) => keep[i]);
}

// ---------------------------------------------------------------------------
// Smart tiering
// ---------------------------------------------------------------------------

const BITRATE_THRESHOLDS_MBPS = {
  '4k':    { topMin: 25, balancedMin: 8 },
  '2160p': { topMin: 25, balancedMin: 8 },
  // 1080p and below share the same bitrate model for now.
  '1080p': { topMin: 12, balancedMin: 3 },
  '720p':  { topMin: 12, balancedMin: 3 },
  '480p':  { topMin: 12, balancedMin: 3 },
  '360p':  { topMin: 12, balancedMin: 3 },
  'unknown': { topMin: 12, balancedMin: 3 },
};

function getSizeThresholds(resolution, groupMaxSizeGb) {
  let balancedMaxGb = groupMaxSizeGb * 0.5;
  if (resolution === '4k' || resolution === '2160p') balancedMaxGb = Math.max(balancedMaxGb, 25);
  else if (resolution === '1080p')                   balancedMaxGb = Math.max(balancedMaxGb, 12);
  else if (resolution === '720p')                    balancedMaxGb = Math.max(balancedMaxGb, 5);
  else                                                balancedMaxGb = Math.max(balancedMaxGb, 2);

  let efficientMaxGb = groupMaxSizeGb * 0.25;
  if (resolution === '4k' || resolution === '2160p') efficientMaxGb = Math.min(Math.max(efficientMaxGb, 3), 8);
  else if (resolution === '1080p')                   efficientMaxGb = Math.min(Math.max(efficientMaxGb, 1), 3);
  else if (resolution === '720p')                    efficientMaxGb = Math.min(Math.max(efficientMaxGb, 0.5), 1.5);
  else                                                efficientMaxGb = Math.min(Math.max(efficientMaxGb, 0.2), 1);

  return { balancedMaxGb, efficientMaxGb };
}

export function classifyStreamTier(stream, resolution, options = {}) {
  const runtimeMinutes = Number(options.runtimeMinutes ?? 0);

  if (runtimeMinutes > 0) {
    const mbps = extractBitrateMbps(stream, runtimeMinutes);
    if (mbps <= 0) return 'unknown';

    const t = BITRATE_THRESHOLDS_MBPS[resolution] ?? BITRATE_THRESHOLDS_MBPS.unknown;
    if (mbps >= t.topMin) return 'top';
    if (mbps >= t.balancedMin) return 'balanced';
    return 'efficient';
  }

  const groupMaxSizeGb = Number(options.groupMaxSizeGb ?? 0);
  const sizeGb = extractSizeGb(stream);
  if (!(sizeGb > 0) || !(groupMaxSizeGb > 0)) return 'unknown';

  const t = getSizeThresholds(resolution, groupMaxSizeGb);
  if (sizeGb <= t.efficientMaxGb) return 'efficient';
  if (sizeGb <= t.balancedMaxGb) return 'balanced';
  return 'top';
}

export function applySmartTiering(streams, tierTop, tierBalanced, tierEfficient, options = {}) {
  if (tierTop <= 0 && tierBalanced <= 0 && tierEfficient <= 0) return streams;

  const runtimeMinutes = Number(options.runtimeMinutes ?? 0);
  const keptStreams = new Set();
  const groups = new Map();

  for (const s of streams) {
    const r = extractResolution(s);
    const eps = extractEpisodes(s);
    const isPack = eps.length !== 1 ? 'pack' : 'single';
    const key = `${r}-${isPack}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  for (const [key, group] of groups.entries()) {
    const resolution = key.split('-')[0];
    let groupMaxSizeGb = 0;
    if (!(runtimeMinutes > 0)) {
      for (const s of group) {
        const sz = extractSizeGb(s);
        if (sz > groupMaxSizeGb) groupMaxSizeGb = sz;
      }
    }

    const selected  = [];
    const leftovers = [];
    let topCount = 0, balancedCount = 0, efficientCount = 0;

    for (const s of group) {
      const tier = classifyStreamTier(s, resolution, { runtimeMinutes, groupMaxSizeGb });
      if (tier === 'unknown') {
        leftovers.push(s);
        continue;
      }

      if (tier === 'top') {
        if      (topCount       < tierTop)       { selected.push(s); topCount++; }
        else if (balancedCount  < tierBalanced)  { selected.push(s); balancedCount++; }
        else if (efficientCount < tierEfficient) { selected.push(s); efficientCount++; }
        else leftovers.push(s);
      } else if (tier === 'balanced') {
        if      (balancedCount  < tierBalanced)  { selected.push(s); balancedCount++; }
        else if (topCount       < tierTop)       { selected.push(s); topCount++; }
        else if (efficientCount < tierEfficient) { selected.push(s); efficientCount++; }
        else leftovers.push(s);
      } else {
        if      (efficientCount < tierEfficient) { selected.push(s); efficientCount++; }
        else if (balancedCount  < tierBalanced)  { selected.push(s); balancedCount++; }
        else if (topCount       < tierTop)       { selected.push(s); topCount++; }
        else leftovers.push(s);
      }
    }

    const needed = (tierTop + tierBalanced + tierEfficient) - selected.length;
    for (let i = 0; i < needed && leftovers.length > 0; i++) selected.push(leftovers.shift());

    for (const s of selected) keptStreams.add(s);
  }

  return streams.filter(s => keptStreams.has(s));
}
