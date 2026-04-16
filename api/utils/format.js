// api/utils/format.js
// BingeGroup normalization, stream display formatting, and stream sanitization.

import {
  extractResolution, formatTagsWithIcons, getCacheTier, isCachedDebrid,
  extractSeeders, extractSizeGb, RESOLUTION_ICONS, hasLikelySubs, hasConfirmedSubs, extractSubtitleLanguages,
} from './parse.js';

// ---------------------------------------------------------------------------
// BingeGroup normalization — the autoplay fix
// ---------------------------------------------------------------------------

/**
 * Rewrites behaviorHints.bingeGroup so Stremio treats all top results as
 * belonging to the same sequential group, enabling autoplay across sources.
 *
 * @param {object[]} streams
 * @param {string}   imdbId
 * @returns {object[]}
 */
export function normalizeBingeGroup(streams, imdbId) {
  return streams.map((stream) => {
    const resolution = extractResolution(stream);
    
    // Universal binge group: locks to the Aggregator and Resolution, 
    // completely ignoring which sub-addon the stream came from.
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
export function formatStreamDisplay(streams, display) {
  const show = new Set(display);
  return streams.map((stream) => {
    const nameParts = [];

    if (show.has('source')) {
      const src = stream._sources?.length
        ? (stream._sources.length > 2
            ? `${stream._sources[0]} +${stream._sources.length - 1}`
            : stream._sources.join(' + '))
        : (stream._addonName || 'Unknown');
      nameParts.push(src);
    }
    if (show.has('resolution')) {
      const res = extractResolution(stream);
      if (res !== 'unknown') {
        const icon = RESOLUTION_ICONS[res] ?? '';
        nameParts.push(icon ? `${icon} ${res.toUpperCase()}` : res.toUpperCase());
      }
    }
    if (show.has('cached')) {
      const tier = getCacheTier(stream);
      if (tier === 'cached')   nameParts.push('⚡');
      if (tier === 'download') nameParts.push('⏳');
    }

    const titleParts = [];

    if (show.has('filename')) {
      // Prefer the raw torrent filename stored in behaviorHints; fall back to
      // first line of stream.title (which is the next cleanest field).
      const fn = stream.behaviorHints?.filename || (stream.title ?? '').split('\n')[0].trim();
      if (fn) titleParts.push(fn);
    }
    if (show.has('tags')) {
      const t = formatTagsWithIcons(stream);
      if (t) titleParts.push(t);
    }

    // Seeders + size on one line
    const bottomLine = [];
    if (show.has('seeders')) {
      const s = extractSeeders(stream);
      if (s > 0) bottomLine.push(`👤 ${s}`);
    }
    if (show.has('size')) {
      const gb = extractSizeGb(stream);
      if (gb > 0) {
        const sizeStr = gb < 1 ? `${Math.round(gb * 1024)} MB` : `${gb.toFixed(2)} GB`;
        bottomLine.push(`💾 ${sizeStr}`);
      }
    }
    if (show.has('subs')) {
      const subLangs = extractSubtitleLanguages(stream);
      if (subLangs.length > 0) {
        bottomLine.push(`\u{1F4AC} ${subLangs.join('/')}`);
      } else if (hasConfirmedSubs(stream)) {
        bottomLine.push('\u{1F4AC}');
      } else if (hasLikelySubs(stream)) {
        bottomLine.push('\u{1F5E3}\uFE0F');
      }
    }
    if (bottomLine.length) titleParts.push(bottomLine.join('   '));

    return {
      ...stream,
      name:  nameParts.length  ? nameParts.join(' · ')  : (stream.name  ?? ''),
      title: titleParts.length ? titleParts.join('\n')  : (stream.title ?? ''),
    };
  });
}

// ---------------------------------------------------------------------------
// Stream sanitization
// ---------------------------------------------------------------------------

/**
 * Strips internal tracking fields and normalizes the stream object for Stremio.
 * Removes P2P fields (infoHash, fileIdx, sources) when a direct URL is present,
 * since Stremio silently drops streams that have multiple playable source types.
 *
 * @param {object} stream
 * @returns {object}
 */
export function sanitizeStream({ _addonIdx, _addonUrl, _addonName, _sources, description, ...s }) {
  for (const key of Object.keys(s)) {
    if (key.startsWith('_')) delete s[key];
  }
  
  // If an HTTP URL is present, we only delete 'sources' (tracker lists).
  // We MUST keep 'infoHash' and 'fileIdx' so Stremio can track watch progress.
  if (s.url) {
    delete s.sources;
  }
  
  return s;
}
