// api/stream.js
// Aggregates streams from multiple sub-addons in parallel, deduplicates,
// sorts, filters, and normalizes bingeGroup for seamless Stremio autoplay.

const FETCH_TIMEOUT_MS = 7000;

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
    const json = Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(json);

    let sort = parsed.sort;
    if (!Array.isArray(sort)) {
      sort = typeof sort === 'string' ? [sort] : ['cached', 'resolution', 'seeders', 'size'];
    }
    sort = sort.map(s => s === 'quality' ? 'resolution' : s);

    let display = parsed.display;
    if (!Array.isArray(display) || display.length === 0) {
      display = DISPLAY_DEFAULTS.slice();
    }
    display = display.filter(k => DISPLAY_DEFAULTS.includes(k));
    if (display.length === 0) display = DISPLAY_DEFAULTS.slice();

    const limit    = typeof parsed.limit  === 'number' && parsed.limit  > 0 ? Math.floor(parsed.limit)  : 0;
    const resCap   = typeof parsed.resCap === 'number' && parsed.resCap > 0 ? Math.floor(parsed.resCap) : 0;
    const debug    = Boolean(parsed.debug);
    const diversify = Boolean(parsed.diversify);

    const rf = parsed.filters ?? {};
    const filters = {
      cachedOnly: Boolean(rf.cachedOnly),
      minSeeders: Math.max(0, parseInt(rf.minSeeders ?? 0, 10) || 0),
      maxSizeGb:  Math.max(0, parseFloat(rf.maxSizeGb  ?? 0) || 0),
    };

    return {
      addons: Array.isArray(parsed.addons) ? parsed.addons : [],
      sort, display, limit, resCap, debug, diversify, filters,
    };
  } catch {
    return {
      addons: [],
      sort:    ['cached', 'resolution', 'seeders', 'size'],
      display: DISPLAY_DEFAULTS.slice(),
      limit: 0, resCap: 0, debug: false, diversify: false,
      filters: { cachedOnly: false, minSeeders: 0, maxSizeGb: 0 },
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

  return fetch(url, { signal: controller.signal })
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
  [/\bdd\+|ddp|eac[- ]?3\b/i,  'DD+'],
  [/\bdts[- ]?hd\b/i,          'DTS-HD'],
  [/\bdts\b/i,                  'DTS'],
  [/\baac\b/i,                  'AAC'],
];

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
  for (const [re, label] of [...SOURCE_TAGS, ...HDR_TAGS, ...CODEC_TAGS, ...AUDIO_TAGS]) {
    if (re.test(haystack)) tags.push(label);
  }
  return tags;
}

/**
 * Returns true if the stream name/title signals a cached debrid result.
 *
 * @param {object} stream
 * @returns {boolean}
 */
function isCachedDebrid(stream) {
  const haystack = `${stream.name ?? ''} ${stream.title ?? ''}`.toLowerCase();
  return haystack.includes('cached') || haystack.includes('⚡') || haystack.includes('rd+');
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
      }
      if (diff !== 0) return diff;
    }
    return 0;
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
    if (filters.cachedOnly && !isCachedDebrid(s)) return false;
    if (filters.minSeeders > 0 && extractSeeders(s) < filters.minSeeders) return false;
    if (filters.maxSizeGb  > 0 && extractSizeGb(s)  > filters.maxSizeGb)  return false;
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
  const seen = new Set();
  const result = [];

  for (const stream of streams) {
    const key = stream.infoHash ?? stream.url ?? null;
    if (!key) {
      result.push(stream);
      continue;
    }
    const normalized = key.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(stream);
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

/**
 * Interleaves streams across quality buckets keyed by {resolution}|{source}|{hdr},
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
    const key  = `${res}|${src}|${hdr}`;
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
      const src = (stream.name ?? '').split('\n')[0].trim();
      if (src) nameParts.push(src);
    }
    if (show.has('resolution')) {
      const res = extractResolution(stream);
      if (res !== 'unknown') nameParts.push(res.toUpperCase());
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
      const t = extractQualityTags(stream).join(' · ');
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
  const { config: rawConfig, type, id: rawId } = req.query;

  if (!rawConfig || !type || !rawId) {
    res.status(400).json({ error: 'Missing required parameters.' });
    return;
  }

  const { addons, sort, display, limit, resCap, debug, diversify, filters } = parseConfig(rawConfig);
  const { imdbId, season, episode } = parseId(rawId);

  if (!addons.length) {
    res.status(200).json({ streams: [] });
    return;
  }

  // Redis cache check
  const redis    = await getRedis();
  const cacheKey = `streams:${rawConfig}:${type}:${rawId}`;
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
    return fetchWithTimeout(streamUrl);
  });

  const results = await Promise.allSettled(fetchPromises);

  // Collect streams from successful responses only
  const allStreams = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      const streams = result.value?.streams;
      if (Array.isArray(streams)) allStreams.push(...streams);
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
  const displayed  = formatStreamDisplay(normalized, display);

  // Debug: append a synthetic entry listing any failed sub-addons
  const output = displayed.slice();
  if (debug) {
    const failedNames = results
      .map((r, i) => {
        if (r.status !== 'rejected') return null;
        try { return new URL(addons[i]).hostname; } catch { return addons[i]; }
      })
      .filter(Boolean);
    if (failedNames.length) {
      output.push({
        name:  '⚠️ Aggregator',
        title: `Failed: ${failedNames.join(', ')}`,
        url:   'about:blank',
      });
    }
  }

  const final = limit > 0 ? output.slice(0, limit) : output;

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
