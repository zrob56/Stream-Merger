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
import { deduplicateStreams, applyFilters, applySmartTiering, classifyStreamTier } from './utils/filter.js';
import { normalizeBingeGroup, formatStreamDisplay, sanitizeStream } from './utils/format.js';

// ---------------------------------------------------------------------------
// Redis cache (optional — requires UPSTASH_REDIS_REST_URL + TOKEN env vars)
// ---------------------------------------------------------------------------

let _redis = null;
const RUNTIME_TIMEOUT_MS = 1200;
const RUNTIME_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const runtimeCache = new Map();
const EARLY_EXIT_TIER_MARGIN = 0;
const BREAKER_WINDOW_SEC = 300;     // 5 min failure window
const BREAKER_THRESHOLD = 3;        // failures in window before cooldown
const BREAKER_COOLDOWN_SEC = 300;   // 5 min deprioritize period

function addonBreakerId(manifestUrl) {
  return createHash('sha1').update(manifestUrl).digest('hex').slice(0, 12);
}

function isTierSatisfied(count, target, margin = EARLY_EXIT_TIER_MARGIN) {
  if (target <= 0) return true;
  return count >= (target + margin);
}

export function isEarlyExitSatisfied(topC, balC, effC, tierTop, tierBalanced, tierEfficient, margin = EARLY_EXIT_TIER_MARGIN) {
  return (
    isTierSatisfied(topC, tierTop, margin) &&
    isTierSatisfied(balC, tierBalanced, margin) &&
    isTierSatisfied(effC, tierEfficient, margin)
  );
}

export function orderAddonsByBreakerState(addons, breakerState = {}) {
  return [...addons]
    .map((url, idx) => ({ url, idx, cooldownSec: breakerState[url] ?? 0 }))
    .sort((a, b) => {
      const ac = a.cooldownSec > 0 ? 1 : 0;
      const bc = b.cooldownSec > 0 ? 1 : 0;
      if (ac !== bc) return ac - bc;
      return a.idx - b.idx;
    });
}

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

function parseRuntimeMinutes(value) {
  if (typeof value === 'number' && value > 0) return Math.round(value);
  if (typeof value !== 'string') return 0;

  const s = value.trim().toLowerCase();
  if (!s) return 0;

  const iso = s.match(/^pt(?:(\d+)h)?(?:(\d+)m)?$/i);
  if (iso) {
    const h = parseInt(iso[1] ?? '0', 10);
    const m = parseInt(iso[2] ?? '0', 10);
    const total = (h * 60) + m;
    return total > 0 ? total : 0;
  }

  const min = s.match(/(\d{2,4})\s*min/);
  if (min) return parseInt(min[1], 10);

  const hm = s.match(/(\d{1,2})\s*h(?:\s*(\d{1,2})\s*m)?/);
  if (hm) {
    const h = parseInt(hm[1], 10);
    const m = parseInt(hm[2] ?? '0', 10);
    const total = (h * 60) + m;
    return total > 0 ? total : 0;
  }

  return 0;
}

function extractRuntimeFromMeta(meta) {
  if (!meta || typeof meta !== 'object') return 0;

  const candidates = [
    meta.runtime,
    meta.runtimeMinutes,
    meta.runtime_minutes,
    meta.duration,
    meta.movieRuntime,
  ];

  for (const c of candidates) {
    const mins = parseRuntimeMinutes(c);
    if (mins > 0) return mins;
  }

  if (typeof meta.description === 'string') {
    const fromDescription = parseRuntimeMinutes(meta.description);
    if (fromDescription > 0) return fromDescription;
  }

  return 0;
}

async function fetchRuntimeMinutes(type, imdbId) {
  const cacheKey = `${type}:${imdbId}`;
  const now = Date.now();
  const hit = runtimeCache.get(cacheKey);
  if (hit && hit.expiresAt > now) return hit.minutes;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUNTIME_TIMEOUT_MS);
  const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
  let minutes = 0;

  try {
    const r = await fetch(url, { signal: controller.signal });
    if (r.ok) {
      const data = await r.json();
      minutes = extractRuntimeFromMeta(data?.meta);
    }
  } catch {
    minutes = 0;
  } finally {
    clearTimeout(timer);
  }

  runtimeCache.set(cacheKey, { minutes, expiresAt: now + RUNTIME_CACHE_TTL_MS });
  return minutes;
}

async function getAddonBreakerState(redis, addons) {
  const state = {};
  if (!redis) return state;

  for (const manifestUrl of addons) {
    try {
      const id = addonBreakerId(manifestUrl);
      const ttl = await redis.ttl(`cb:cool:${id}`);
      state[manifestUrl] = ttl > 0 ? ttl : 0;
    } catch {
      state[manifestUrl] = 0;
    }
  }
  return state;
}

async function recordAddonFailure(redis, manifestUrl) {
  if (!redis) return;
  try {
    const id = addonBreakerId(manifestUrl);
    const failKey = `cb:fail:${id}`;
    const coolKey = `cb:cool:${id}`;
    const count = await redis.incr(failKey);
    if (count === 1) await redis.expire(failKey, BREAKER_WINDOW_SEC);
    if (count >= BREAKER_THRESHOLD) {
      await redis.set(coolKey, '1', { ex: BREAKER_COOLDOWN_SEC });
      await redis.del(failKey);
    }
  } catch { /* non-fatal */ }
}

async function recordAddonSuccess(redis, manifestUrl) {
  if (!redis) return;
  try {
    const id = addonBreakerId(manifestUrl);
    await redis.del(`cb:fail:${id}`);
  } catch { /* non-fatal */ }
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
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('X-Runtime-Minutes', '0');
    res.setHeader('X-Runtime-Source', 'fallback');
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
        const hitObj = typeof hit === 'string' ? JSON.parse(hit) : hit;
        const hitRuntimeMinutes = parseInt(hitObj?.runtimeMinutes ?? 0, 10) || 0;
        const hitRuntimeSource = hitRuntimeMinutes > 0 ? 'cinemeta' : 'fallback';
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
        res.setHeader('Vary', 'Accept-Encoding');
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Runtime-Minutes', String(hitRuntimeMinutes));
        res.setHeader('X-Runtime-Source', hitRuntimeSource);
        res.status(200).json(hitObj?.streams ? hitObj : { streams: [] });
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
  const runtimeMinutes = tierSlots > 0 ? await fetchRuntimeMinutes(type, imdbId) : 0;
  const runtimeSource = runtimeMinutes > 0 ? 'cinemeta' : 'fallback';
  const breakerState = await getAddonBreakerState(redis, addons);
  const fetchAddons = orderAddonsByBreakerState(addons, breakerState);
  let earlyExitTriggered = false;
  let earlyExitReason = '';

  const fetchPromises = fetchAddons.map((addon, i) => {
    const manifestUrl = addon.url;
    const streamUrl = buildStreamUrl(manifestUrl, type, stremioId);
    const timeout = addonTimeouts[manifestUrl] ?? FETCH_TIMEOUT_MS;

    return fetchWithTimeout(streamUrl, timeout, clientIp, abortController.signal)
      .then(result => {
        const rawStreams = result?.streams;
        if (Array.isArray(rawStreams) && rawStreams.length > 0) {
          
          const preppedStreams = rawStreams.map(s => ({
            ...s,
            _addonName: identifyAddonName(s, manifestUrl),
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

            let eligibleGroups = 0;
            let satisfiedGroups = 0;

            for (const r of ['4k', '1080p']) {
              const group = resGroups[r];
              if (group.length < tierSlots) continue;
              eligibleGroups++;

              let groupMaxSizeGb = 0;
              if (!(runtimeMinutes > 0)) {
                for (const s of group) {
                  const sz = extractSizeGb(s);
                  if (sz > groupMaxSizeGb) groupMaxSizeGb = sz;
                }
              }

              let topC = 0, balC = 0, effC = 0;
              for (const s of group) {
                const tier = classifyStreamTier(s, r, { runtimeMinutes, groupMaxSizeGb });
                if (tier === 'efficient') effC++;
                else if (tier === 'balanced') balC++;
                else if (tier === 'top') topC++;
              }

              if (isEarlyExitSatisfied(topC, balC, effC, tierTop, tierBalanced, tierEfficient, EARLY_EXIT_TIER_MARGIN)) {
                satisfiedGroups++;
              }
            }

            const perfectDistributionMet = eligibleGroups > 0 && satisfiedGroups === eligibleGroups;

            if (perfectDistributionMet) {
              earlyExitTriggered = true;
              earlyExitReason = 'smart-tiers(all-groups)';
              abortController.abort();
            }
          } else {
            if (currentDeduped.length >= fallbackTarget) {
              earlyExitTriggered = true;
              earlyExitReason = `fallbackTarget(${fallbackTarget})`;
              abortController.abort();
            }
          }
        }
        return { ...result, _addonUrl: manifestUrl };
      })
      .catch((err) => ({ streams: [], _addonUrl: manifestUrl, _error: String(err?.message ?? err ?? 'unknown') })); // Catch aborts silently so Promise.allSettled doesn't fail
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
          _addonUrl:      fetchAddons[i].url,
          _addonName:     identifyAddonName(s, fetchAddons[i].url),
          _trustProxies:  trustProxies,
        })));
      }
    }
  }

  if (redis) {
    const breakerWrites = [];
    for (let i = 0; i < results.length; i++) {
      const addonUrl = fetchAddons[i]?.url;
      if (!addonUrl) continue;
      const r = results[i];
      const errMsg = String(r.value?._error ?? r.reason?.message ?? '');
      const hadError = r.status === 'rejected' || Boolean(r.value?._error);
      const wasIntentionalAbort = earlyExitTriggered && /\babort/i.test(errMsg);
      const streamCount = r.status === 'fulfilled' ? (r.value?.streams?.length ?? 0) : 0;
      if (hadError && !wasIntentionalAbort) breakerWrites.push(recordAddonFailure(redis, addonUrl));
      else if (streamCount > 0) breakerWrites.push(recordAddonSuccess(redis, addonUrl));
    }
    await Promise.allSettled(breakerWrites);
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

  let tiered        = applySmartTiering(filtered, tierTop, tierBalanced, tierEfficient, { runtimeMinutes });

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

    lines.push(`Runtime for bitrate tiering: ${runtimeMinutes > 0 ? `${runtimeMinutes} min` : 'unavailable (size fallback)'} [source: ${runtimeSource}]`);
    lines.push(`Early-exit: ${earlyExitTriggered ? `triggered via ${earlyExitReason}` : 'not triggered'}; tier margin = 0`);
    const deprioritized = fetchAddons.filter(a => a.cooldownSec > 0);
    if (deprioritized.length > 0) {
      lines.push('Circuit breaker (deprioritized addons):');
      for (const a of deprioritized) {
        let host;
        try { host = new URL(a.url).hostname; } catch { host = a.url; }
        lines.push(`  ${host}: cooldown ${a.cooldownSec}s`);
      }
    }
    lines.push('');

    for (let i = 0; i < results.length; i++) {
      let host;
      try { host = new URL(fetchAddons[i].url).hostname; } catch { host = fetchAddons[i].url; }
      const r = results[i];
      if (r.status === 'rejected' || r.value?._error) {
        const reason = String(r.value?._error ?? r.reason?.message ?? r.reason ?? 'unknown').slice(0, 120);
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
      await redis.set(cacheKey, JSON.stringify({ streams: final, runtimeMinutes }), { ex: cacheTtl });
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
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('X-Runtime-Minutes', String(runtimeMinutes > 0 ? runtimeMinutes : 0));
  res.setHeader('X-Runtime-Source', runtimeSource);
  res.status(200).json({ streams: final });
}
