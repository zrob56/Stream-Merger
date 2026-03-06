// api/utils/parse.js
// Shared constants, tag extractors, signal detectors, and request helpers.

export const FETCH_TIMEOUT_MS = 4500;

export const DISPLAY_DEFAULTS = ['source', 'resolution', 'cached', 'tags', 'filename', 'seeders', 'size'];

export const RESOLUTION_TAGS = ['4k', '2160p', '1080p', '720p', '480p', '360p'];
export const VALID_MIN_RES   = new Set(['4k', '2160p', '1080p', '720p', '480p', '360p']);
export const QUALITY_ORDER = ['4k', '2160p', '1080p', '720p', '480p', '360p', 'unknown'];

export const RESOLUTION_ICONS = {
  '4k':    '🔵', '2160p': '🔵', '1080p': '🟢',
  '720p':  '🟡', '480p':  '🔴', '360p':  '🔴',
};

export const SOURCE_TAGS = [
  [/\bremux\b/i, 'Remux'], [/\bblu[- ]?ray\b/i, 'BluRay'], [/\bweb[- ]?dl\b/i, 'WEB-DL'],
  [/\bwebrip\b/i, 'WEBRip'], [/\bhdtv\b/i, 'HDTV'], [/\bdvd\b/i, 'DVD'],
];
export const HDR_TAGS = [
  [/\bdolby[\s.]?vision\b|\bDV\b/i, 'DV'], [/\bhdr10\+/i, 'HDR10+'],
  [/\bhdr10\b/i, 'HDR10'], [/\bhdr\b/i, 'HDR'], [/\bhlg\b/i, 'HLG'],
];
export const CODEC_TAGS = [
  [/\bav1\b/i, 'AV1'], [/\bx265\b|\bh\.265\b|\bhevc\b/i, 'x265'], [/\bx264\b|\bh\.264\b|\bavc\b/i, 'x264'],
];
export const AUDIO_TAGS = [
  [/\batmos\b/i, 'Atmos'], [/\btruehd\b/i, 'TrueHD'], [/\bdd\+|\bddp\b|\beac[- ]?3\b/i, 'DD+'],
  [/\bdts[- ]?hd\b/i, 'DTS-HD'], [/\bdts\b/i, 'DTS'], [/\baac\b/i, 'AAC'],
];

export const HDR_LABELS    = HDR_TAGS.map(([, label]) => label);
export const CODEC_LABELS  = CODEC_TAGS.map(([, label]) => label);
export const SOURCE_LABELS = SOURCE_TAGS.map(([, label]) => label);
export const AUDIO_LABELS  = AUDIO_TAGS.map(([, label]) => label);
const ALL_TAGS = [...SOURCE_TAGS, ...HDR_TAGS, ...CODEC_TAGS, ...AUDIO_TAGS];

function getHaystack(stream) {
  return `${stream.name ?? ''} ${stream.title ?? ''} ${stream.description ?? ''} ${stream.behaviorHints?.filename ?? ''}`.toLowerCase();
}

// --- Memoization-Aware Extractors ---

export function extractResolution(stream) {
  if (stream._res !== undefined) return stream._res; // Instant bailout
  const h = getHaystack(stream);
  if (/\b(4k|2160p|2160|uhd)\b/.test(h)) return '4k';
  if (/\b(1080p|1080i|1080|fhd)\b/.test(h)) return '1080p';
  if (/\b(720p|720|hd)\b/.test(h)) return '720p';
  if (/\b(480p|480|576p|576|sd|dvd|dvdrip)\b/.test(h)) return '480p';
  if (/\b(360p|360)\b/.test(h)) return '360p';
  
  const size = extractSizeGb(stream);
  if (size > 0) {
    const eps = extractEpisodes(stream);
    const isPack = /\b(season|complete|pack|bundle)\b/i.test(h) || eps.length > 1;
    if (!isPack) {
      const isSeries = eps.length === 1 || /\b(episode|ep)\b/i.test(h);
      if (isSeries) {
        if (size > 3.5) return '4k'; if (size > 1.2) return '1080p';
        if (size > 0.4) return '720p'; return '480p';
      } else {
        if (size > 12) return '4k'; if (size > 3.0) return '1080p';
        if (size > 0.8) return '720p'; return '480p';
      }
    }
  }
  return 'unknown';
}

export function extractSourceQuality(stream) {
  if (stream._source !== undefined) return stream._source;
  const h = getHaystack(stream);
  for (const [re, label] of SOURCE_TAGS) if (re.test(h)) return label;
  return 'unknown';
}

export function extractEpisodes(stream) {
  const h = getHaystack(stream);
  const eps = new Set();
  let m;
  const sxeRegex = /s\d{1,2}\s*e(\d{1,3})/gi; while ((m = sxeRegex.exec(h)) !== null) eps.add(parseInt(m[1], 10));
  const xRegex = /(?:\b|^)\d{1,2}x(\d{1,3})\b/gi; while ((m = xRegex.exec(h)) !== null) eps.add(parseInt(m[1], 10));
  const rangeRegex = /e(\d{1,3})\s*-\s*(?:e)?(\d{1,3})/gi; while ((m = rangeRegex.exec(h)) !== null) {
    const start = parseInt(m[1], 10), end = parseInt(m[2], 10);
    if (start < end && end - start < 100) for (let i = start; i <= end; i++) eps.add(i);
  }
  const epRegex = /(?:episode|ep)\s*0*(\d{1,3})\b/gi; while ((m = epRegex.exec(h)) !== null) eps.add(parseInt(m[1], 10));
  const standaloneRegex = /\be0*(\d{1,3})\b/gi; while ((m = standaloneRegex.exec(h)) !== null) eps.add(parseInt(m[1], 10));
  return Array.from(eps);
}

export function extractSizeGb(stream) {
  if (stream._size !== undefined) return stream._size;
  
  // 1. Check for native byte sizes first (most accurate)
  const rawBytes = stream.behaviorHints?.videoSize ?? stream.size;
  if (typeof rawBytes === 'number' && rawBytes > 0) {
    // Convert bytes to GB
    return rawBytes / (1024 * 1024 * 1024);
  }

  // 2. Fallback to text parsing if native sizes aren't provided
  const h = getHaystack(stream);
  const matchGb = h.match(/([\d.]+)\s*gb/); if (matchGb) return parseFloat(matchGb[1]);
  const matchMb = h.match(/([\d.]+)\s*mb/); if (matchMb) return parseFloat(matchMb[1]) / 1024;
  return 0;
}

export function extractSeeders(stream) {
  if (stream._seeders !== undefined) return stream._seeders;
  const h = getHaystack(stream);
  const match = h.match(/(?:👤|s:|seeders:)\s*(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

export function extractQualityTags(stream) {
  const h = getHaystack(stream);
  const tags = [];
  for (const [re, label] of ALL_TAGS) if (re.test(h)) tags.push(label);
  return tags;
}

export function formatTagsWithIcons(stream) {
  const h = getHaystack(stream);
  const parts = [];
  const src = SOURCE_TAGS.filter(([re]) => re.test(h)).map(([, l]) => l);
  const hdr = HDR_TAGS.filter(([re]) => re.test(h)).map(([, l]) => l);
  const codec = CODEC_TAGS.filter(([re]) => re.test(h)).map(([, l]) => l);
  const audio = AUDIO_TAGS.filter(([re]) => re.test(h)).map(([, l]) => l);
  if (src.length) parts.push(`🎬 ${src.join(' · ')}`);
  if (hdr.length) parts.push(`✨ ${hdr.join(' · ')}`);
  if (codec.length) parts.push(`🎞️ ${codec.join(' · ')}`);
  if (audio.length) parts.push(`🔊 ${audio.join(' · ')}`);
  return parts.join('  ');
}

export function getCacheTier(stream) {
  if (stream._cacheTier !== undefined) return stream._cacheTier;
  const h = getHaystack(stream);
  if (/\b(uncached|download|store|add to)\b/i.test(h) || /\[download\]/i.test(h) || /\[rd download\]/i.test(h) || /\[uncached\]/i.test(h)) return 'download';
  if (h.includes('cached') || h.includes('⚡') || h.includes('🟢') || h.includes('rd+') || h.includes('ad+') || h.includes('pm+') || h.includes('dl+') || h.includes('tb+') || /\[(rd|ad|pm|dl|tb)\]/.test(h)) return 'cached';
  if (typeof stream.url === 'string' && !stream.infoHash && !stream.url.startsWith('magnet:')) {
    const addon = (stream._addonName || '').toLowerCase();
    const proxyAddons = ['torrentio', 'stremthru', 'comet', 'mediafusion', 'torrentsdb'];
    if (proxyAddons.includes(addon) && !stream._trustProxies) return 'download';
    return 'cached';
  }
  return 'p2p';
}

export function isCachedDebrid(stream) { return getCacheTier(stream) === 'cached'; }
export function isEnglishAudio(stream) { return /\b(english|eng)\b/.test(getHaystack(stream)); }
export function hasEmbeddedSubs(stream) { return /\b(subs?|subtitles?|hardcoded|esub)\b/.test(getHaystack(stream)); }

export function parseConfig(raw) {
  try {
    const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(normalized, 'base64').toString('utf8');
    const parsed = JSON.parse(json);

    let sort = parsed.sort;
    if (!Array.isArray(sort)) sort = typeof sort === 'string' ? [sort] : ['cached', 'resolution', 'seeders', 'size', 'source'];
    sort = sort.map(s => s === 'quality' ? 'resolution' : s);

    let display = parsed.display;
    if (!Array.isArray(display) || display.length === 0) display = DISPLAY_DEFAULTS.slice();
    display = display.filter(k => DISPLAY_DEFAULTS.includes(k));
    if (display.length === 0) display = DISPLAY_DEFAULTS.slice();

    const limit = typeof parsed.limit === 'number' && parsed.limit > 0 ? Math.floor(parsed.limit) : 0;
    const tierTop = typeof parsed.tierTop === 'number' && parsed.tierTop > 0 ? Math.floor(parsed.tierTop) : 0;
    const tierBalanced = typeof parsed.tierBalanced === 'number' && parsed.tierBalanced > 0 ? Math.floor(parsed.tierBalanced) : 0;
    const tierEfficient = typeof parsed.tierEfficient === 'number' && parsed.tierEfficient > 0 ? Math.floor(parsed.tierEfficient) : 0;
    const addonCap = typeof parsed.addonCap === 'number' && parsed.addonCap > 0 ? Math.floor(parsed.addonCap) : 0;
    const debug = Boolean(parsed.debug);
    const trustProxies = Boolean(parsed.trustProxies);

    const rf = parsed.filters ?? {};
    const filters = {
      cachedOnly: Boolean(rf.cachedOnly),
      minSeeders: Math.max(0, parseInt(rf.minSeeders ?? 0, 10) || 0),
      maxSizeGb: Math.max(0, parseFloat(rf.maxSizeGb ?? 0) || 0),
      minResolution: VALID_MIN_RES.has(rf.minResolution) ? rf.minResolution : '',
      excludeTerms: Array.isArray(rf.excludeTerms) ? rf.excludeTerms.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim().toLowerCase()) : [],
      requiredHdr: (rf.requiredHdr ?? []).filter(t => HDR_LABELS.includes(t)),
      requiredCodec: (rf.requiredCodec ?? []).filter(t => CODEC_LABELS.includes(t)),
      requiredSource: (rf.requiredSource ?? []).filter(t => SOURCE_LABELS.includes(t)),
      requiredAudio: (rf.requiredAudio ?? []).filter(t => AUDIO_LABELS.includes(t)),
    };

    const addonTimeouts = (parsed.addonTimeouts && typeof parsed.addonTimeouts === 'object')
      ? Object.fromEntries(Object.entries(parsed.addonTimeouts).filter(([k, v]) => typeof k === 'string' && typeof v === 'number' && v > 0).map(([k, v]) => [k, Math.min(60000, Math.max(1000, Math.round(v)))]))
      : {};

    return { addons: Array.isArray(parsed.addons) ? parsed.addons : [], sort, display, limit, tierTop, tierBalanced, tierEfficient, addonCap, debug, trustProxies, filters, addonTimeouts };
  } catch {
    return {
      addons: [], sort: ['cached', 'resolution', 'seeders', 'size'], display: DISPLAY_DEFAULTS.slice(),
      limit: 0, tierTop: 0, tierBalanced: 0, tierEfficient: 0, addonCap: 0, debug: false, trustProxies: false,
      filters: { cachedOnly: false, minSeeders: 0, maxSizeGb: 0, minResolution: '', excludeTerms: [], requiredHdr: [], requiredCodec: [], requiredSource: [], requiredAudio: [] },
      addonTimeouts: {},
    };
  }
}

export function parseId(id) {
  const parts = id.split(':');
  return { imdbId: parts[0], season: parts[1] ?? null, episode: parts[2] ?? null };
}

export function buildStreamUrl(manifestUrl, type, id) {
  const base = manifestUrl.replace(/\/manifest\.json$/, '');
  return `${base}/stream/${type}/${id}.json`;
}

// EARLY BAILOUT ADDITION: externalSignal parameter
export function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS, clientIp = null, externalSignal = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // If the global early bailout triggers, abort this specific fetch too
  if (externalSignal) {
    externalSignal.addEventListener('abort', () => controller.abort());
  }

  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Stremio/4.4.168' };
  if (clientIp) { headers['X-Forwarded-For'] = clientIp; headers['X-Real-IP'] = clientIp; }

  return fetch(url, { signal: controller.signal, headers })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return res.json();
    })
    .finally(() => clearTimeout(timer));
}
