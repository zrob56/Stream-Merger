// api/utils/filter.js
// Filtering, deduplication (exact + fuzzy), and smart tiering.

import {
  extractResolution, extractSourceQuality, extractQualityTags,
  extractSeeders, extractSizeGb, extractBitrateMbps, isCachedDebrid,
  HDR_LABELS, CODEC_LABELS, SOURCE_LABELS, AUDIO_LABELS, QUALITY_ORDER,
} from './parse.js';
import { SOURCE_QUALITY_ORDER } from './sort.js';

// ---------------------------------------------------------------------------
// Filter application
// ---------------------------------------------------------------------------

// Patterns that identify trailer/teaser/promo streams — never valid playback sources.
// Dot-separated filenames (e.g. The.Making.Of.mkv) are normalized to spaces before testing.
const TRAILER_RE = /\b(trailer|teaser|promo|featurette|behind[\s-]the[\s-]scenes|making[\s-]of|deleted[\s-]scene|bonus[\s-]clip|official[\s-]clip|interview|extra|special[\s-]feature|b[\s-]?roll|sample|recap|gag[\s-]reel|bloopers?|advert(?:isement)?s?)\b/i;

// Site-ad spam torrents: tiny video file named after a piracy domain (e.g. rarbg.com.mp4)
const SPAM_DOMAIN_RE = /\b(?:rarbg|yts|eztv|limetorrents|torrentgalaxy|1337x|thepiratebay|kickass|ganool|extratorrents|torrentz)\s*\.(?:com|to|org|me|ag|io|net)\b/i;

function isTrailerStream(s) {
  const raw = `${s.name ?? ''} ${s.title ?? ''} ${s.description ?? ''} ${s.behaviorHints?.filename ?? ''}`;
  // Normalize dot-separated filenames so word-boundary checks work correctly
  const h = raw.replace(/\./g, ' ');
  if (TRAILER_RE.test(h)) return true;
  // Vintage TV commercials: standalone word "ad" in filename, tiny file (≤ 50 MB)
  if (/\bad\b/i.test(h) && extractSizeGb(s) < 0.05) return true;
  // YouTube / short external-only links that addons sometimes return as trailers
  if (typeof s.externalUrl === 'string' && /youtube\.com|youtu\.be/i.test(s.externalUrl) && !s.infoHash && !s.url) return true;
  // Site-ad spam: tiny file (<5 MB) whose name is a piracy domain
  if (SPAM_DOMAIN_RE.test(raw) && extractSizeGb(s) < 0.005) return true;
  return false;
}

export function applyFilters(streams, filters) {
  const needTagCheck = filters.requiredHdr.length > 0 || filters.requiredCodec.length > 0
    || (filters.requiredSource && filters.requiredSource.length > 0)
    || (filters.requiredAudio && filters.requiredAudio.length > 0);

  return streams.filter(s => {
    if (isTrailerStream(s)) return false;
    if (filters.excludeTerms.length > 0) {
      const hay = `${s.name ?? ''} ${s.title ?? ''} ${s.description ?? ''} ${s.behaviorHints?.filename ?? ''}`.toLowerCase();
      if (filters.excludeTerms.some(t => hay.includes(t))) return false;
    }
    if (needTagCheck) {
      const tags = extractQualityTags(s);
      const hasMetadata = !!(s.name || s.title || s.behaviorHints?.filename);
      if (filters.requiredHdr.length > 0) {
        const detected = HDR_LABELS.filter(h => tags.includes(h));
        if (hasMetadata && !filters.requiredHdr.some(h => detected.includes(h))) return false;
      }
      if (filters.requiredCodec.length > 0) {
        const detected = CODEC_LABELS.filter(c => tags.includes(c));
        if (hasMetadata && !filters.requiredCodec.some(c => detected.includes(c))) return false;
      }
      if (filters.requiredSource && filters.requiredSource.length > 0) {
        const detected = SOURCE_LABELS.filter(src => tags.includes(src));
        if (hasMetadata && !filters.requiredSource.some(src => detected.includes(src))) return false;
      }
      if (filters.requiredAudio && filters.requiredAudio.length > 0) {
        const detected = AUDIO_LABELS.filter(a => tags.includes(a));
        if (hasMetadata && !filters.requiredAudio.some(a => detected.includes(a))) return false;
      }
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

const FALSE_POSITIVE_TAGS = new Set(['x264', 'x265', 'hevc', 'av1', '1080p', '2160p', 'hdr', 'web', 'dl', 'bluray', 'ray', 'hdtv', 'remux', 'repack', 'proper']);

export function deduplicateStreams(streams) {
  const seen   = new Map(); // normalized key -> index in result[]
  const result = [];

  for (const stream of streams) {
    let key = stream.infoHash
      ? (stream.infoHash + (stream.fileIdx > 0 ? ':' + stream.fileIdx : ''))
      : (stream.url ?? null);
    if (!key && stream.behaviorHints?.filename) {
      key = `filename:${stream.behaviorHints.filename}`;
    }

    if (!key) {
      const srcName = stream._addonName ?? '';
      result.push({ ...stream, _sources: srcName ? [srcName] : [] });
      continue;
    }

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
  const fuzzyBuckets = new Map(); // key → [{ idx, size }]
  const keep = new Array(result.length).fill(true);

  for (let i = 0; i < result.length; i++) {
    const s = result[i];
    const sizeA = extractSizeGb(s);
    if (sizeA === 0) continue;

    const res   = extractResolution(s);
    const src   = extractSourceQuality(s);
    const codec = extractQualityTags(s).find(t => CODEC_LABELS_SUBSET.includes(t)) ?? 'none';

    const h = `${s.name ?? ''} ${s.title ?? ''} ${s.behaviorHints?.filename ?? ''}`.toLowerCase();
    const extMatch = h.match(/\.(mkv|mp4|avi|ts|m4v)\b/);
    const ext = extMatch ? extMatch[1] : 'any';

    // Prefer tag directly before extension (e.g. -TGx.mkv); fall back to end-of-token.
    const tagMatch = h.match(/-([a-z0-9]{2,12})\.(?:mkv|mp4|avi|ts|m4v)\b/)
      ?? h.match(/-([a-z0-9]{2,12})(?:\s|$|\n|\]|\))/);
    const rawTag = tagMatch ? tagMatch[1] : 'any';
    const tag = FALSE_POSITIVE_TAGS.has(rawTag) ? 'any' : rawTag;

    // Tag is intentionally excluded from the bucket key so that streams where one
    // addon reports a release tag and another doesn't are still compared by size.
    // The tag is stored on each candidate so we can skip merging when both sides
    // have known (and different) release group tags — those are genuinely different files.
    const key = `${res}|${src}|${codec}|${ext}`;

    if (!fuzzyBuckets.has(key)) {
      fuzzyBuckets.set(key, [{ idx: i, size: sizeA, tag }]);
      continue;
    }

    const candidates = fuzzyBuckets.get(key);
    let merged = false;
    for (const cand of candidates) {
      // Two known-but-different release tags → different files, never merge
      if (tag !== 'any' && cand.tag !== 'any' && tag !== cand.tag) continue;
      // Use a tighter margin when neither side has a tag; looser when at least one does
      const margin = (tag !== 'any' || cand.tag !== 'any') ? 0.5 : Math.max(0.02, sizeA * 0.05);
      if (Math.abs(cand.size - sizeA) <= margin) {
        const dupSrc = s._addonName ?? '';
        if (dupSrc && !result[cand.idx]._sources.includes(dupSrc)) {
          result[cand.idx]._sources.push(dupSrc);
        }
        keep[i] = false;
        merged = true;
        break;
      }
    }
    if (!merged) candidates.push({ idx: i, size: sizeA, tag });
  }

  return result.filter((_, i) => keep[i]);
}

// ---------------------------------------------------------------------------
// Smart tiering
// ---------------------------------------------------------------------------

const BITRATE_THRESHOLDS_MBPS = {
  '4k':    { topMin: 20, balancedMin: 8 },
  '2160p': { topMin: 20, balancedMin: 8 },
  // 1080p and below share the same bitrate model for now.
  '1080p': { topMin: 12, balancedMin: 3 },
  '720p':  { topMin: 12, balancedMin: 3 },
  '480p':  { topMin: 12, balancedMin: 3 },
  '360p':  { topMin: 12, balancedMin: 3 },
  'unknown': { topMin: 12, balancedMin: 3 },
};

function getSizeThresholds(resolution, groupMaxSizeGb) {
  let balancedMaxGb = groupMaxSizeGb * 0.35;
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
  const allSelected = [];
  const groups = new Map();

  for (const s of streams) {
    const r = extractResolution(s);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(s);
  }

  for (const [resolution, group] of groups.entries()) {
    let groupMaxSizeGb = 0;
    if (!(runtimeMinutes > 0)) {
      for (const s of group) {
        const sz = extractSizeGb(s);
        if (sz > groupMaxSizeGb) groupMaxSizeGb = sz;
      }
    }

    const topStreams = [];
    const balancedStreams = [];
    const efficientStreams = [];
    const leftovers = [];
    let topCount = 0, balancedCount = 0, efficientCount = 0;

    for (const s of group) {
      const tier = classifyStreamTier(s, resolution, { runtimeMinutes, groupMaxSizeGb });
      if (tier === 'unknown') {
        leftovers.push(s);
        continue;
      }

      if (tier === 'top') topStreams.push(s);
      else if (tier === 'balanced') balancedStreams.push(s);
      else efficientStreams.push(s);
    }

    const selected = [];

    for (const s of topStreams) {
      if (topCount >= tierTop) {
        leftovers.push(s);
        continue;
      }
      selected.push(s);
      topCount++;
    }
    for (const s of balancedStreams) {
      if (balancedCount >= tierBalanced) {
        leftovers.push(s);
        continue;
      }
      selected.push(s);
      balancedCount++;
    }
    for (const s of efficientStreams) {
      if (efficientCount >= tierEfficient) {
        leftovers.push(s);
        continue;
      }
      selected.push(s);
      efficientCount++;
    }

    const needed = (tierTop + tierBalanced + tierEfficient) - selected.length;
    for (let i = 0; i < needed && leftovers.length > 0; i++) selected.push(leftovers.shift());

    // Restore the original group order (input was already sorted by size/quality)
    selected.sort((a, b) => group.indexOf(a) - group.indexOf(b));

    for (const s of selected) allSelected.push(s);
  }

  return allSelected;
}
