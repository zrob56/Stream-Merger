// api/stream.js
// Aggregates streams from multiple sub-addons in parallel, deduplicates,
// sorts, and normalizes bingeGroup for seamless Stremio autoplay.

const FETCH_TIMEOUT_MS = 7000;

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

/**
 * Decodes the base64 config string embedded in the URL.
 * Expected shape: { addons: string[], sort: string }
 *
 * @param {string} raw - base64url or standard base64 config string
 * @returns {{ addons: string[], sort: string }}
 */
function parseConfig(raw) {
  try {
    const json = Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    return {
      addons: Array.isArray(parsed.addons) ? parsed.addons : [],
      sort: typeof parsed.sort === 'string' ? parsed.sort : 'quality',
    };
  } catch {
    return { addons: [], sort: 'quality' };
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
 * @param {string} id - raw id param from the request
 * @returns {{ imdbId: string, season: string|null, episode: string|null }}
 */
function parseId(id) {
  const parts = id.split(':');
  return {
    imdbId: parts[0],
    season: parts[1] ?? null,
    episode: parts[2] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Sub-addon URL building
// ---------------------------------------------------------------------------

/**
 * Converts a sub-addon manifest URL to its corresponding stream endpoint URL.
 *
 * Input:  "https://torrentio.strem.fun/sort=qualitysize|realdebrid=TOKEN/manifest.json"
 * Output: "https://torrentio.strem.fun/sort=qualitysize|realdebrid=TOKEN/stream/series/tt0903747:1:1.json"
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
 * @param {object} stream - Stremio stream object
 * @returns {string} e.g. "4k", "1080p", "unknown"
 */
function extractResolution(stream) {
  const haystack = `${stream.name ?? ''} ${stream.title ?? ''}`.toLowerCase();
  for (const tag of RESOLUTION_TAGS) {
    if (haystack.includes(tag)) return tag;
  }
  // Common alternative notations
  if (haystack.includes('uhd')) return '4k';
  if (haystack.includes('fhd')) return '1080p';
  if (haystack.includes('hd')) return '720p';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

// Quality rank: lower index = higher priority
const QUALITY_ORDER = ['4k', '2160p', '1080p', '720p', '480p', '360p', 'unknown'];

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
 * Returns true if the stream name/title signals a cached debrid result.
 *
 * @param {object} stream
 * @returns {boolean}
 */
function isCachedDebrid(stream) {
  const haystack = `${stream.name ?? ''} ${stream.title ?? ''}`.toLowerCase();
  // Common indicators from Torrentio, Comet, MediaFusion
  return haystack.includes('cached') || haystack.includes('⚡') || haystack.includes('rd+');
}

/**
 * Sorts streams according to the user's sort preference.
 *
 * Modes:
 *   "quality"       – 4K → 1080p → … (default)
 *   "cached"        – cached debrid first, then quality
 *   "size"          – largest file first (proxy for quality)
 *   "seeders"       – highest seeder count first (parsed from title)
 *
 * @param {object[]} streams
 * @param {string}   sortMode
 * @returns {object[]}
 */
function sortStreams(streams, sortMode) {
  return [...streams].sort((a, b) => {
    if (sortMode === 'cached') {
      const aCached = isCachedDebrid(a);
      const bCached = isCachedDebrid(b);
      if (aCached !== bCached) return aCached ? -1 : 1;
    }

    if (sortMode === 'size') {
      const diff = extractSizeGb(b) - extractSizeGb(a);
      if (diff !== 0) return diff;
    }

    if (sortMode === 'seeders') {
      const seedersA = parseInt(`${a.title ?? ''}`.match(/👤\s*(\d+)/)?.[1] ?? '0', 10);
      const seedersB = parseInt(`${b.title ?? ''}`.match(/👤\s*(\d+)/)?.[1] ?? '0', 10);
      if (seedersA !== seedersB) return seedersB - seedersA;
    }

    // Default / tiebreaker: quality rank
    const rankA = QUALITY_ORDER.indexOf(extractResolution(a));
    const rankB = QUALITY_ORDER.indexOf(extractResolution(b));
    return rankA - rankB;
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
      // Streams without a stable key are kept as-is (edge case)
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
// BingeGroup normalization — the autoplay fix
// ---------------------------------------------------------------------------

/**
 * Rewrites behaviorHints.bingeGroup on every stream so Stremio treats all
 * top results as belonging to the same sequential group, enabling autoplay
 * across heterogeneous sources.
 *
 * Format: "aggregator-{imdbId}-{resolution}"
 *
 * Why this works: Stremio advances to the next episode by finding a stream
 * in the next episode's response whose bingeGroup matches the currently
 * playing stream. By stamping all streams with a deterministic group keyed
 * on imdbId + resolution, the match always succeeds regardless of which
 * sub-addon originally provided the stream.
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
// Main handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  // Vercel passes query params set by the rewrite rule
  const { config: rawConfig, type, id: rawId } = req.query;

  if (!rawConfig || !type || !rawId) {
    res.status(400).json({ error: 'Missing required parameters.' });
    return;
  }

  const { addons, sort } = parseConfig(rawConfig);
  const { imdbId, season, episode } = parseId(rawId);

  if (!addons.length) {
    res.status(200).json({ streams: [] });
    return;
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
      if (Array.isArray(streams)) {
        allStreams.push(...streams);
      }
    }
    // Rejected promises (timeout, HTTP error, parse failure) are silently
    // skipped — the remaining addons' results are still returned.
  }

  // --- Consolidation pipeline ---
  const sorted      = sortStreams(allStreams, sort);
  const deduped     = deduplicateStreams(sorted);
  const normalized  = normalizeBingeGroup(deduped, imdbId);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
  res.status(200).json({ streams: normalized });
}
