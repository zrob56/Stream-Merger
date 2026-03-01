// api/manifest.js
// Returns a standard Stremio manifest for the aggregator addon.
// The manifest advertises only the "stream" resource — catalog and meta
// are intentionally omitted so Stremio falls back to Cinemeta/Trakt.

/**
 * Decodes the base64 config string and extracts a display-safe addon count
 * to include in the manifest name so users can confirm their config loaded.
 *
 * @param {string} raw - base64 config string
 * @returns {{ addonCount: number, sort: string }}
 */
function parseConfig(raw) {
  try {
    const json = Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    const addonCount = Array.isArray(parsed.addons) ? parsed.addons.length : 0;
    const sort = typeof parsed.sort === 'string' ? parsed.sort : 'quality';
    return { addonCount, sort };
  } catch {
    return { addonCount: 0, sort: 'quality' };
  }
}

export default function handler(req, res) {
  const { config: rawConfig } = req.query;

  const { addonCount, sort } = rawConfig ? parseConfig(rawConfig) : { addonCount: 0, sort: 'quality' };

  const manifest = {
    id: 'community.unified-stream-aggregator',
    version: '1.0.0',
    name: `Unified Stream${addonCount ? ` (${addonCount} sources, sort: ${sort})` : ''}`,
    description:
      'Aggregates streams from multiple Stremio addons in parallel. ' +
      'Deduplicates, sorts, and normalises bingeGroup for seamless autoplay.',
    logo: 'https://i.imgur.com/0VZ3GnB.png',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    // No catalogs — rely on Cinemeta or Trakt for browsing.
    catalogs: [],
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
    },
  };

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600');
  res.status(200).json(manifest);
}
