// api/stream.js
// Aggregates streams from multiple sub-addons in parallel, deduplicates,
// sorts, filters, and normalizes bingeGroup for seamless Stremio autoplay.

import { createHash } from 'crypto';

const FETCH_TIMEOUT_MS = 8500;

const DISPLAY_DEFAULTS = ['source', 'resolution', 'cached', 'tags', 'filename', 'seeders', 'size'];

// ---------------------------------------------------------------------------
// Redis cache (optional — requires UPSTASH_REDIS_REST_URL + TOKEN env vars)
// ---------------------------------------------------------------------------

let _redis = null;

async function getRedis() {
  if (_redis) return _redis;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  try {
    const { Redis } = await import('@upstash/redis');
    _redis = new Redis({
      url:   process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    return _redis;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

/**
 * Decodes the base64 config string embedded in the URL.
 * Shape: { addons, sort, display, limit?, resCap?, debug?, filters? }
 *
 * Backward compat: sort as string → wrapped in array.
 * Legacy key 'quality' → 'resolution'.
 *
 * @param {string} raw - base64 config string
 * @returns {{ addons, sort, display, limit, resCap, debug, filters }}
 */
function parseConfig(raw) {
  try {
    const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(normalized, 'base64').toString('utf8');
    const parsed = JSON.parse(json);

    let sort = parsed.sort;
    if (!Array.isArray(sort)) {
      sort = typeof sort === 'string' ? [sort] : ['cached', 'resolution', 'seeders', 'size', 'source'];
    }
    sort = sort.map(s => s === 'quality' ? 'resolution' : s);

    let display = parsed.display;
    if (!Array.isArray(display) || display.length === 0) {
      display = DISPLAY_DEFAULTS.slice();
    }
    display = display.filter(k => DISPLAY_DEFAULTS.includes(k));
    if (display.length === 0) display = DISPLAY_DEFAULTS.slice();

    const limit    = typeof parsed.limit    === 'number' && parsed.limit    > 0 ? Math.floor(parsed.limit)    : 0;
    const resCap   = typeof parsed.resCap   === 'number' && parsed.resCap   > 0 ? Math.floor(parsed.resCap)   : 0;
    const addonCap = typeof parsed.addonCap === 'number' && parsed.addonCap > 0 ? Math.floor(parsed.addonCap) : 0;
    const debug    = Boolean(parsed.debug);
    const diversify = Boolean(parsed.diversify);

    const rf = parsed.filters ?? {};
    const filters = {
      cachedOnly:    Boolean(rf.cachedOnly),
      minSeeders:    Math.max(0, parseInt(rf.minSeeders ?? 0, 10) || 0),
      maxSizeGb:     Math.max(0, parseFloat(rf.maxSizeGb  ?? 0) || 0),
      minResolution: VALID_MIN_RES.has(rf.minResolution) ? rf.minResolution : '',
      excludeTerms:  Array.isArray(rf.excludeTerms)
        ? rf.excludeTerms.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim().toLowerCase())
        : [],
      requiredHdr:    (rf.requiredHdr    ?? []).filter(t => HDR_LABELS.includes(t)),
      requiredCodec:  (rf.requiredCodec  ?? []).filter(t => CODEC_LABELS.includes(t)),
      requiredSource: (rf.requiredSource ?? []).filter(t => SOURCE_LABELS.includes(t)),
      requiredAudio:  (rf.requiredAudio  ?? []).filter(t => AUDIO_LABELS.includes(t)),
    };

    const addonTimeouts = (parsed.addonTimeouts && typeof parsed.addonTimeouts === 'object')
      ? Object.fromEntries(
          Object.entries(parsed.addonTimeouts)
            .filter(([k, v]) => typeof k === 'string' && typeof v === 'number' && v > 0)
            .map(([k, v]) => [k, Math.min(60000, Math.max(1000, Math.round(v)))])
        )
      : {};

    return {
      addons: Array.isArray(parsed.addons) ? parsed.addons : [],
      sort, display, limit, resCap, addonCap, debug, diversify, filters, addonTimeouts,
    };
  } catch {
    return {
      addons: [],
      sort:    ['cached', 'resolution', 'seeders', 'size'],
      display: DISPLAY_DEFAULTS.slice(),
      limit: 0, resCap: 0, addonCap: 0, debug: false, diversify: false,
      filters: { cachedOnly: false, minSeeders: 0, maxSizeGb: 0, minResolution: '', excludeTerms: [], requiredHdr: [], requiredCodec: [], requiredSource: [], requiredAudio: [] },
      addonTimeouts: {},
    };
  }
}

// ---------------------------------------------------------------------------
// ID parsing
// ---------------------------------------------------------------------------

/**
 * Extracts IMDB ID, season, and episode from a Stremio stream request ID.
 *
 * Movies:  "tt1234567"
 * Series:  "tt1234567:1:1"
 *
 * @param {string} id
 * @returns {{ imdbId: string, season: string|null, episode: string|null }}
 */
function parseId(id) {
  const parts = id.split(':');
  return {
    imdbId:  parts[0],
    season:  parts[1] ?? null,
    episode: parts[2] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Sub-addon URL building
// ---------------------------------------------------------------------------

/**
 * Converts a sub-addon manifest URL to its corresponding stream endpoint URL.
 *
 * @param {string} manifestUrl
 * @param {string} type  - "movie" | "series"
 * @param {string} id    - full Stremio id, e.g. "tt0903747:1:1"
 * @returns {string}
 */
function buildStreamUrl(manifestUrl, type, id) {
  const base = manifestUrl.replace(/\/manifest\.json$/, '');
  return `${base}/stream/${type}/${id}.json`;
}

// ---------------------------------------------------------------------------
// Fetch with timeout
// ---------------------------------------------------------------------------

/**
 * Fetches a URL and resolves with parsed JSON, or rejects on timeout/error.
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 */
function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, {
    signal: controller.signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Stremio/4.4.168'
    }
  })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return res.json();
    })
    .finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Resolution extraction
// ---------------------------------------------------------------------------

// Ordered highest → lowest so the first match wins.
const RESOLUTION_TAGS = ['4k', '2160p', '1080p', '720p', '480p', '360p'];
const VALID_MIN_RES   = new Set(['4k', '2160p', '1080p', '720p', '480p', '360p']);

/**
 * Derives a normalised resolution tag from stream name/title fields.
 *
 * @param {object} stream
 * @returns {string} e.g. "4k", "1080p", "unknown"
 */
function extractResolution(stream) {
  const haystack = `${stream.name ?? ''} ${stream.title ?? ''}`.toLowerCase();
  for (const tag of RESOLUTION_TAGS) {
    if (haystack.includes(tag)) return tag;
  }
  if (haystack.includes('uhd')) return '4k';
  if (haystack.includes('fhd')) return '1080p';
  if (haystack.includes('hd'))  return '720p';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

// Quality rank: lower index = higher priority
const QUALITY_ORDER = ['4k', '2160p', '1080p', '720p', '480p', '360p', 'unknown'];

const RESOLUTION_ICONS = {
  '4k':    '🔵',
  '2160p': '🔵',
  '1080p': '🟢',
  '720p':  '🟡',
  '480p':  '🔴',
  '360p':  '🔴',
};

const SOURCE_QUALITY_ORDER = ['Remux', 'BluRay', 'WEB-DL', 'WEBRip', 'HDTV', 'DVD', 'unknown'];

function extractSourceQuality(stream) {
  const haystack = `${stream.name ?? ''} ${stream.title ?? ''}`;
  for (const [re, label] of SOURCE_TAGS) {
    if (re.test(haystack)) return label;
  }
  return 'unknown';
}

const SOURCE_TAGS = [
  [/\bremux\b/i,         'Remux'],
  [/\bblu[- ]?ray\b/i,   'BluRay'],
  [/\bweb[- ]?dl\b/i,    'WEB-DL'],
  [/\bwebrip\b/i,        'WEBRip'],
  [/\bhdtv\b/i,          'HDTV'],
  [/\bdvd\b/i,           'DVD'],
];
const HDR_TAGS = [
  [/\bdolby[\s.]?vision\b|\bDV\b/i, 'DV'],
  [/\bhdr10\+/i,         'HDR10+'],
  [/\bhdr10\b/i,         'HDR10'],
  [/\bhdr\b/i,           'HDR'],
  [/\bhlg\b/i,           'HLG'],
];
const CODEC_TAGS = [
  [/\bav1\b/i,                          'AV1'],
  [/\bx265\b|\bh\.265\b|\bhevc\b/i,    'x265'],
  [/\bx264\b|\bh\.264\b|\bavc\b/i,     'x264'],
];
const AUDIO_TAGS = [
  [/\batmos\b/i,                'Atmos'],
  [/\btruehd\b/i,               'TrueHD'],
  [/\bdd\+|\bddp\b|\beac[- ]?3\b/i, 'DD+'],
  [/\bdts[- ]?hd\b/i,          'DTS-HD'],
  [/\bdts\b/i,                  'DTS'],
  [/\baac\b/i,                  'AAC'],
];

const HDR_LABELS    = HDR_TAGS.map(([, label]) => label);   // ['DV','HDR10+','HDR10','HDR','HLG']
const CODEC_LABELS  = CODEC_TAGS.map(([, label]) => label); // ['AV1','x265','x264']
const SOURCE_LABELS = SOURCE_TAGS.map(([, label]) => label); // ['Remux','BluRay','WEB-DL','WEBRip','HDTV','DVD']
const AUDIO_LABELS  = AUDIO_TAGS.map(([, label]) => label);  // ['Atmos','TrueHD','DD+','DTS-HD','DTS','AAC']

const ALL_TAGS = [...SOURCE_TAGS, ...HDR_TAGS, ...CODEC_TAGS, ...AUDIO_TAGS];

const DIVERSITY_SOURCE_PRIORITY = ['Remux', 'BluRay', 'WEB-DL', 'WEBRip', 'HDTV', 'DVD'];
const DIVERSITY_HDR_PRIORITY    = ['DV', 'HDR10+', 'HDR10', 'HDR', 'HLG'];

/**
 * Extracts a numeric file size (GB) from stream title for size-based sorting.
 * Returns 0 if not found.
 *
 * @param {object} stream
 * @returns {number}
 */
function extractSizeGb(stream) {
  const match = `${stream.title ?? ''}`.match(/([\d.]+)\s*gb/i);
  return match ? parseFloat(match[1]) : 0;
}

/**
 * Parses the seeder count from stream title (👤 N format).
 * Returns 0 if not found.
 *
 * @param {object} stream
 * @returns {number}
 */
function extractSeeders(stream) {
  const match = `${stream.title ?? ''}`.match(/👤\s*(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Extracts normalized quality tags (source, HDR, codec, audio) from stream fields.
 *
 * @param {object} stream
 * @returns {string[]}
 */
function extractQualityTags(stream) {
  const haystack = `${stream.name ?? ''} ${stream.title ?? ''}`;
  const tags = [];
  for (const [re, label] of ALL_TAGS) {
    if (re.test(haystack)) tags.push(label);
  }
  return tags;
}

function formatTagsWithIcons(stream) {
  const haystack = `${stream.name ?? ''} ${stream.title ?? ''}`;
  const parts = [];
  const src   = SOURCE_TAGS.filter(([re]) => re.test(haystack)).map(([, l]) => l);
  const hdr   = HDR_TAGS.filter(([re]) => re.test(haystack)).map(([, l]) => l);
  const codec = CODEC_TAGS.filter(([re]) => re.test(haystack)).map(([, l]) => l);
  const audio = AUDIO_TAGS.filter(([re]) => re.test(haystack)).map(([, l]) => l);
  if (src.length)   parts.push(`🎬 ${src.join(' · ')}`);
  if (hdr.length)   parts.push(`✨ ${hdr.join(' · ')}`);
  if (codec.length) parts.push(`🎞️ ${codec.join(' · ')}`);
  if (audio.length) parts.push(`🔊 ${audio.join(' · ')}`);
  return parts.join('  ');
}

/**
 * Returns true if the stream name/title signals a cached debrid result.
 *
 * @param {object} stream
 * @returns {boolean}
 */
function isCachedDebrid(stream) {
  const haystack = `${stream.name ?? ''} ${stream.title ?? ''}`.toLowerCase();
  // Common debrid cache signals across Torrentio, Comet, MediaFusion, etc.
  return (
    haystack.includes('cached') ||
    haystack.includes('⚡') ||
    haystack.includes('🟢') ||
    haystack.includes('rd+') ||
    haystack.includes('[rd]') ||
    haystack.includes('[ad]') ||
    haystack.includes('[pm]') ||
    haystack.includes('[dl]') ||
    haystack.includes('[tb]') ||
    haystack.includes('debrid')
  );
}

function isEnglishAudio(stream) {
  const haystack = `${stream.name ?? ''} ${stream.title ?? ''}`;
  return /\benglish\b|\beng\b/i.test(haystack);
}

function hasEmbeddedSubs(stream) {
  const haystack = `${stream.name ?? ''} ${stream.title ?? ''}`;
  return /\bsubs?\b|\bsubtitles?\b|\bhardcoded\b/i.test(haystack);
}

/**
 * Sorts streams by ranked-choice criteria (multi-key ORDER BY).
 *
 * @param {object[]} streams
 * @param {string[]} sortCriteria - ordered array of: 'cached'|'resolution'|'size'|'seeders'
 * @returns {object[]}
 */
function sortStreams(streams, sortCriteria) {
  const criteria = Array.isArray(sortCriteria) ? sortCriteria : [sortCriteria];
  return [...streams].sort((a, b) => {
    for (const criterion of criteria) {
      let diff = 0;
      if (criterion === 'cached') {
        diff = (isCachedDebrid(b) ? 1 : 0) - (isCachedDebrid(a) ? 1 : 0);
      } else if (criterion === 'resolution') {
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
    // Final tiebreaker: addon order (lower index = higher priority)
    const ai = (a._addonIdx ?? 999), bi = (b._addonIdx ?? 999);
    return ai - bi;
  });
}

// ---------------------------------------------------------------------------
// Filter application
// ---------------------------------------------------------------------------

/**
 * Applies user-configured filters: cached-only, min seeders, max file size.
 *
 * @param {object[]} streams
 * @param {{ cachedOnly: boolean, minSeeders: number, maxSizeGb: number }} filters
 * @returns {object[]}
 */
function applyFilters(streams, filters) {
  return streams.filter(s => {
    if (filters.excludeTerms.length > 0) {
      const hay = `${s.name ?? ''} ${s.title ?? ''}`.toLowerCase();
      if (filters.excludeTerms.some(t => hay.includes(t))) return false;
    }
    if (filters.requiredHdr.length > 0) {
      const tags     = extractQualityTags(s);
      const detected = HDR_LABELS.filter(h => tags.includes(h));
      if (!filters.requiredHdr.some(h => detected.includes(h))) return false;
    }
    if (filters.requiredCodec.length > 0) {
      const tags     = extractQualityTags(s);
      const detected = CODEC_LABELS.filter(c => tags.includes(c));
      if (!filters.requiredCodec.some(c => detected.includes(c))) return false;
    }
    if (filters.requiredSource && filters.requiredSource.length > 0) {
      const tags     = extractQualityTags(s);
      const detected = SOURCE_LABELS.filter(src => tags.includes(src));
      if (!filters.requiredSource.some(src => detected.includes(src))) return false;
    }
    if (filters.requiredAudio && filters.requiredAudio.length > 0) {
      const tags     = extractQualityTags(s);
      const detected = AUDIO_LABELS.filter(a => tags.includes(a));
      if (!filters.requiredAudio.some(a => detected.includes(a))) return false;
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
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Removes duplicate streams, preferring earlier entries (already sorted).
 * Deduplication key: infoHash (torrents) or url (HTTP streams).
 *
 * @param {object[]} streams
 * @returns {object[]}
 */
function deduplicateStreams(streams) {
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
      // Merge duplicate's source name into the kept stream
      const dupSrc = (stream.name ?? '').split('\n')[0].trim();
      if (dupSrc) {
        const kept = result[seen.get(normalized)];
        if (!kept._sources.includes(dupSrc)) kept._sources.push(dupSrc);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Per-resolution cap
// ---------------------------------------------------------------------------

/**
 * Keeps at most maxPerTier streams per resolution tier.
 * Applied after sort so the best streams survive per tier.
 *
 * @param {object[]} streams
 * @param {number}   maxPerTier
 * @returns {object[]}
 */
function capByResolution(streams, maxPerTier) {
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

function getSizeTier(stream) {
  const gb = extractSizeGb(stream);
  if (gb === 0) return 'unknown';
  if (gb <  15) return 'compact';  // <15 GB  — 720p / small WEB-DL
  if (gb <  50) return 'mid';      // 15–50 GB — 4K WEB-DL, 1080p Remux
  return 'full';                    // ≥50 GB  — 4K Remux
}

/**
 * Interleaves streams across quality buckets keyed by {resolution}|{source}|{hdr}|{size},
 * ensuring variety before any one bucket dominates the results.
 * Bucket order is insertion-order from the sorted input, so the highest-quality
 * bucket always leads each round.
 *
 * @param {object[]} streams - already sorted
 * @returns {object[]}
 */
function diversifyStreams(streams) {
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

// ---------------------------------------------------------------------------
// BingeGroup normalization — the autoplay fix
// ---------------------------------------------------------------------------

/**
 * Rewrites behaviorHints.bingeGroup on every stream so Stremio treats all
 * top results as belonging to the same sequential group, enabling autoplay
 * across heterogeneous sources.
 *
 * Format: "aggregator-{imdbId}-{resolution}"
 *
 * @param {object[]} streams
 * @param {string}   imdbId
 * @returns {object[]}
 */
function normalizeBingeGroup(streams, imdbId) {
  return streams.map((stream) => {
    const resolution = extractResolution(stream);
    const bingeGroup = `aggregator-${imdbId}-${resolution}`;
    return {
      ...stream,
      behaviorHints: {
        ...(stream.behaviorHints ?? {}),
        bingeGroup,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Stream display formatting
// ---------------------------------------------------------------------------

/**
 * Rewrites stream.name and stream.title based on which display fields are
 * enabled in the user config. Runs AFTER sort, dedup, and bingeGroup.
 *
 * @param {object[]} streams
 * @param {string[]} display
 * @returns {object[]}
 */
function formatStreamDisplay(streams, display) {
  const show = new Set(display);
  return streams.map((stream) => {
    const nameParts = [];

    if (show.has('source')) {
      const src = stream._sources?.length
        ? stream._sources.join(' + ')
        : (stream.name ?? '').split('\n')[0].trim();
      if (src) nameParts.push(src);
    }
    if (show.has('resolution')) {
      const res  = extractResolution(stream);
      if (res !== 'unknown') {
        const icon = RESOLUTION_ICONS[res] ?? '';
        nameParts.push(icon ? `${icon} ${res.toUpperCase()}` : res.toUpperCase());
      }
    }
    if (show.has('cached') && isCachedDebrid(stream)) {
      nameParts.push('⚡');
    }

    const titleParts = [];

    if (show.has('filename')) {
      const fn = (stream.title ?? '').split('\n')[0].trim();
      if (fn) titleParts.push(fn);
    }
    if (show.has('tags')) {
      const t = formatTagsWithIcons(stream);
      if (t) titleParts.push(t);
    }
    if (show.has('seeders')) {
      const s = extractSeeders(stream);
      if (s > 0) titleParts.push(`👤 ${s}`);
    }
    if (show.has('size')) {
      const gb = extractSizeGb(stream);
      if (gb > 0) titleParts.push(`💾 ${gb} GB`);
    }

    return {
      ...stream,
      name:  nameParts.length  ? nameParts.join(' · ')  : (stream.name  ?? ''),
      title: titleParts.length ? titleParts.join('\n')  : (stream.title ?? ''),
    };
  });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  const { config: rawConfig, type, id: rawId } = req.query;

  if (!rawConfig || !type || !rawId) {
    res.status(400).json({ error: 'Missing required parameters.' });
    return;
  }

  const { addons, sort, display, limit, resCap, addonCap, debug, diversify, filters, addonTimeouts } = parseConfig(rawConfig);
  const { imdbId, season, episode } = parseId(rawId);

  if (!addons.length) {
    res.status(200).json({ streams: [] });
    return;
  }

  // Redis cache check
  const redis      = await getRedis();
  const configHash = createHash('sha256').update(rawConfig).digest('hex');
  const cacheKey   = `streams:${configHash}:${type}:${rawId}`;
  const cacheTtl = season ? 300 : 900; // 5 min episodes, 15 min movies

  if (redis) {
    try {
      const hit = await redis.get(cacheKey);
      if (hit) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
        res.setHeader('X-Cache', 'HIT');
        res.status(200).json(typeof hit === 'string' ? JSON.parse(hit) : hit);
        return;
      }
    } catch { /* cache miss — proceed normally */ }
  }

  // Build the full Stremio-format id used in sub-addon requests
  const stremioId = season && episode ? `${imdbId}:${season}:${episode}` : imdbId;

  // --- Parallel fetch ---
  const fetchPromises = addons.map((manifestUrl) => {
    const streamUrl = buildStreamUrl(manifestUrl, type, stremioId);
    const timeout = addonTimeouts[manifestUrl] ?? FETCH_TIMEOUT_MS;
    return fetchWithTimeout(streamUrl, timeout);
  });

  const results = await Promise.allSettled(fetchPromises);

  // Collect streams from successful responses only
  // addonCap applied here (per-addon) so each upstream is capped before merge
  // _addonIdx annotates each stream with its addon's position for sort tiebreaking
  const allStreams = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      const streams = result.value?.streams;
      if (Array.isArray(streams)) {
        const slice = addonCap > 0 ? streams.slice(0, addonCap) : streams;
        allStreams.push(...slice.map(s => ({
          ...s,
          _addonIdx: i,
          title: s.title || s.description || '',
        })));
      }
    }
  }

  // --- Consolidation pipeline ---
  // Order matters: sort/dedup/bingeGroup read the original name/title;
  // formatStreamDisplay must run last so it doesn't corrupt those reads.
  const sorted     = sortStreams(allStreams, sort);
  const deduped    = deduplicateStreams(sorted);
  const filtered   = applyFilters(deduped, filters);
  const diversified = diversify ? diversifyStreams(filtered) : filtered;
  const capped     = resCap > 0 ? capByResolution(diversified, resCap) : diversified;
  const normalized = normalizeBingeGroup(capped, imdbId);
  const formatted  = formatStreamDisplay(normalized, display);

  // Count surviving streams per addon (before stripping _addonIdx) for debug
  const survivingCounts = {};
  for (const s of formatted) {
    const idx = s._addonIdx ?? -1;
    survivingCounts[idx] = (survivingCounts[idx] ?? 0) + 1;
  }

  const displayed = formatted.map(({ _addonIdx, _sources, ...s }) => {
    // If both url (debrid link) and infoHash (torrent hash) are present, strip the P2P
    // fields — Stremio silently drops streams that have multiple playable source types.
    let clean = s;
    if (s.url && s.infoHash) {
      const { infoHash, fileIdx, sources, ...rest } = s;
      clean = rest;
    }
    return clean;
  });

  // Apply limit to real streams BEFORE debug so the debug entry always appears last
  const final = limit > 0 ? displayed.slice(0, limit) : displayed.slice();
  if (debug) {
    const lines = [];

    // Per-filter drop counts (on the post-dedup pool)
    const filterLines = [];
    if (filters.cachedOnly) {
      const n = deduped.filter(s => !isCachedDebrid(s)).length;
      filterLines.push(`  cachedOnly blocked ${n}/${deduped.length}`);
    }
    if (filters.minSeeders > 0) {
      const n = deduped.filter(s => extractSeeders(s) < filters.minSeeders).length;
      filterLines.push(`  minSeeders(${filters.minSeeders}) blocked ${n}/${deduped.length}`);
    }
    if (filters.maxSizeGb > 0) {
      const n = deduped.filter(s => extractSizeGb(s) > filters.maxSizeGb).length;
      filterLines.push(`  maxSizeGb(${filters.maxSizeGb}) blocked ${n}/${deduped.length}`);
    }
    if (filters.minResolution) {
      const mi = QUALITY_ORDER.indexOf(filters.minResolution);
      const n = deduped.filter(s => {
        const ri = QUALITY_ORDER.indexOf(extractResolution(s));
        return ri === -1 || ri > mi;
      }).length;
      filterLines.push(`  minResolution(${filters.minResolution}) blocked ${n}/${deduped.length}`);
    }
    if (filterLines.length) {
      lines.push('📊 Filter drops (post-dedup pool):');
      lines.push(...filterLines);
      lines.push('');
    }

    for (let i = 0; i < results.length; i++) {
      let host;
      try { host = new URL(addons[i]).hostname; } catch { host = addons[i]; }
      const r = results[i];
      if (r.status === 'rejected') {
        const reason = String(r.reason?.message ?? r.reason ?? 'unknown').slice(0, 120);
        lines.push(`❌ ${host}: ${reason}`);
      } else {
        const raw = r.value?.streams?.length ?? 0;
        const surviving = survivingCounts[i] ?? 0;
        if (raw === 0) {
          lines.push(`⚠️ ${host}: 0 streams (no .streams key or empty)`);
        } else {
          lines.push(`${surviving > 0 ? '✅' : '🔻'} ${host}: ${raw} raw → ${surviving} after pipeline`);
        }
      }
    }
    final.push({
      name:  '🔍 Aggregator Debug',
      title: lines.join('\n'),
      url:   'http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    });
  }

  // Store in Redis cache (non-fatal if it fails)
  if (redis) {
    try {
      await redis.set(cacheKey, JSON.stringify({ streams: final }), { ex: cacheTtl });
    } catch { /* non-fatal */ }
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
  res.status(200).json({ streams: final });
}
