// api/stream.js
// Aggregates streams from multiple sub-addons in parallel, deduplicates,
// sorts, filters, and normalizes bingeGroup for seamless Stremio autoplay.

import { createHash } from 'crypto';
import {
  parseConfig, parseId, buildStreamUrl, fetchWithTimeout,
  isCachedDebrid, extractSeeders, extractSizeGb, extractResolution, extractEpisodes,
  QUALITY_ORDER, FETCH_TIMEOUT_MS,
} from './utils/parse.js';
import { sortStreams } from './utils/sort.js';
import { deduplicateStreams, applyFilters, applySmartTiering } from './utils/filter.js';
import { normalizeBingeGroup, formatStreamDisplay, sanitizeStream } from './utils/format.js';

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
// Addon name identification — scans manifest URL + video URL + stream name
// ---------------------------------------------------------------------------

function identifyAddonName(stream, manifestUrl) {
  const haystack = `${manifestUrl ?? ''} ${stream.url ?? ''} ${stream.name ?? ''}`.toLowerCase();

  if (haystack.includes('sootio')) return 'Sootio';
  if (haystack.includes('debridmediamanager')) return 'DMM Cast';
  if (haystack.includes('stremthru'))     return 'StremThru';
  if (haystack.includes('torrentsdb'))    return 'TorrentsDB';
  if (haystack.includes('torrentio'))     return 'Torrentio';
  if (haystack.includes('comet'))         return 'Comet';
  if (haystack.includes('mediafusion'))   return 'MediaFusion';
  if (haystack.includes('meteor'))        return 'Meteor';
  if (haystack.includes('jackettio'))     return 'Jackettio';
  if (haystack.includes('knightcrawler')) return 'KnightCrawler';
  if (haystack.includes('annatar'))       return 'Annatar';

  try {
    const host = new URL(manifestUrl).hostname.toLowerCase();
    const cleanHost = host.replace(/^www\./, '');
    const first = cleanHost.split('.')[0];
    return first.charAt(0).toUpperCase() + first.slice(1);
  } catch {
    return 'Unknown';
  }
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

  let clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
  if (clientIp.includes(',')) {
    clientIp = clientIp.split(',')[0].trim();
  }

  // Short ID resolution: 8 hex chars → look up full config in Redis
  let resolvedConfig = rawConfig;
  if (rawConfig.length === 8 && /^[a-f0-9]{8}$/.test(rawConfig)) {
    const redis = await getRedis();
    if (!redis) { res.status(503).json({ error: 'Short URL service unavailable.' }); return; }
    const stored = await redis.get(`shorturl:${rawConfig}`);
    if (!stored) { res.status(404).json({ error: 'Config not found.' }); return; }
    resolvedConfig = stored;
  }

  const { addons, sort, display, limit, tierTop, tierBalanced, tierEfficient, addonCap, debug, trustProxies, filters, addonTimeouts } = parseConfig(resolvedConfig);
  const { imdbId, season, episode } = parseId(rawId);

  if (!addons.length) {
    res.status(200).json({ streams: [] });
    return;
  }

  // Redis cache check
  const redis      = await getRedis();
  const configHash = createHash('sha256').update(resolvedConfig).digest('hex');
  const cacheKey   = `streams:${configHash}:${type}:${rawId}`;
  const cacheTtl   = season ? 300 : 900; // 5 min episodes, 15 min movies

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
  const abortController = new AbortController();
  let accumulatedStreams = [];
  const tierSlots = tierTop + tierBalanced + tierEfficient;
  const fallbackTarget = limit > 0 ? limit : 15;

  const fetchPromises = addons.map((manifestUrl, i) => {
    const streamUrl = buildStreamUrl(manifestUrl, type, stremioId);
    const timeout = addonTimeouts[manifestUrl] ?? FETCH_TIMEOUT_MS;

    return fetchWithTimeout(streamUrl, timeout, clientIp, abortController.signal)
      .then(result => {
        const rawStreams = result?.streams;
        if (Array.isArray(rawStreams) && rawStreams.length > 0) {
          
          const preppedStreams = rawStreams.map(s => ({
            ...s,
            _addonName: identifyAddonName(s, addons[i]),
            _trustProxies: trustProxies,
          }));

          const survivors = applyFilters(preppedStreams, filters);
          accumulatedStreams.push(...survivors);
          const currentDeduped = deduplicateStreams(accumulatedStreams);

          if (tierSlots > 0) {
            const resGroups = { '4k': [], '1080p': [] };
            for (const s of currentDeduped) {
              const r = extractResolution(s);
              if (resGroups[r]) resGroups[r].push(s);
            }

            let perfectDistributionMet = false;

            for (const r of ['4k', '1080p']) {
              const group = resGroups[r];
              if (group.length < tierSlots) continue;

              let maxSize = 0;
              for (const s of group) {
                const sz = extractSizeGb(s);
                if (sz > maxSize) maxSize = sz;
              }

              let bThresh = maxSize * 0.5;
              bThresh = r === '4k' ? Math.max(bThresh, 25) : Math.max(bThresh, 12);

              let eThresh = maxSize * 0.25;
              eThresh = r === '4k' ? Math.min(Math.max(eThresh, 3), 8) : Math.min(Math.max(eThresh, 1), 3);

              let topC = 0, balC = 0, effC = 0;
              for (const s of group) {
                const sz = extractSizeGb(s);
                if (sz > 0 && sz <= eThresh) effC++;
                else if (sz > 0 && sz <= bThresh) balC++;
                else topC++; 
              }

              if (topC >= tierTop && balC >= tierBalanced && effC >= tierEfficient) {
                perfectDistributionMet = true;
                break;
              }
            }

            if (perfectDistributionMet) {
              abortController.abort();
            }
          } else {
            if (currentDeduped.length >= fallbackTarget) {
              abortController.abort();
            }
          }
        }
        return result;
      })
      .catch(() => ({ streams: [] })); // Catch aborts silently so Promise.allSettled doesn't fail
  });

  const results = await Promise.allSettled(fetchPromises);

  // Collect streams; addonCap applied per-addon before merge
  let allStreams = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      const streams = result.value?.streams;
      if (Array.isArray(streams)) {
        const slice = addonCap > 0 ? streams.slice(0, addonCap) : streams;
        allStreams.push(...slice.map(s => ({
          ...s,
          _addonIdx:      i,
          _addonUrl:      addons[i],
          _addonName:     identifyAddonName(s, addons[i]),
          _trustProxies:  trustProxies,
        })));
      }
    }
  }

  // Folder popup fix & strict episode matching for series
  if (type === 'series') {
    const reqEp = parseInt(episode, 10);
    allStreams = allStreams.filter(s => {
      // 1. Drop infoHash season packs without a specific file index
      if (s.infoHash && s.fileIdx == null && s.fileIndex == null) return false;
      // 2. Strict episode parsing to block bleeding from other episodes
      const eps = extractEpisodes(s);
      if (eps.length > 0 && !eps.includes(reqEp)) return false;
      // 3. Drop massive unresolved proxy packs (No infoHash + No Ep Number + >20GB)
      if (!s.infoHash && eps.length === 0 && extractSizeGb(s) > 20) return false;
      return true;
    });
  }

// --- Consolidation pipeline ---
  // Order matters: sort/dedup/bingeGroup read the original name/title;
  // formatStreamDisplay must run last so it doesn't corrupt those reads.
  const sorted      = sortStreams(allStreams, sort, type);
  const deduped     = deduplicateStreams(sorted);
  let filtered      = applyFilters(deduped, filters);

  // Fallback 1: If strict filters blocked everything, revert to deduped pool
  if (filtered.length === 0 && deduped.length > 0) {
    filtered = deduped;
  }

  let tiered        = applySmartTiering(filtered, tierTop, tierBalanced, tierEfficient);

  // Fallback 2: If smart tiering blocked everything, revert to filtered pool
  if (tiered.length === 0 && filtered.length > 0) {
    tiered = filtered;
  }

  const normalized  = normalizeBingeGroup(tiered, imdbId);
  const formatted   = formatStreamDisplay(normalized, display);

  // Count surviving streams per addon (before sanitizing _addonIdx) for debug
  const survivingCounts = {};
  for (const s of formatted) {
    const idx = s._addonIdx ?? -1;
    survivingCounts[idx] = (survivingCounts[idx] ?? 0) + 1;
  }

  const displayed = formatted.map(sanitizeStream);

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
  // Store in Redis cache (non-fatal if it fails)
  if (redis) {
    try {
      await redis.set(cacheKey, JSON.stringify({ streams: final }), { ex: cacheTtl });
    } catch { /* non-fatal */ }
  }

  // --- Background fetch for next episode cache warming ---
  if (type === 'series' && season && episode) {
    const nextEp = parseInt(episode, 10) + 1;
    const nextId = `${imdbId}:${season}:${nextEp}`;
    
    // Build the URL to our own aggregator endpoint
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host;
    const warmupUrl = `${protocol}://${host}/api/stream?config=${encodeURIComponent(rawConfig)}&type=series&id=${nextId}`;
    
    // Fire and forget (don't await it). Catch errors so it doesn't crash the main process.
    fetch(warmupUrl).catch(() => {});
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
  res.status(200).json({ streams: final });
}

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
  res.status(200).json({ streams: final });
}
