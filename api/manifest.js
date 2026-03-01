// api/manifest.js
// Returns a standard Stremio manifest for the aggregator addon.
// The manifest advertises only the "stream" resource — catalog and meta
// are intentionally omitted so Stremio falls back to Cinemeta/Trakt.

export default function handler(req, res) {
  const proto = (req.headers['x-forwarded-proto'] ?? 'https').split(',')[0].trim();
  const host  = req.headers.host ?? '';
  const logo  = host ? `${proto}://${host}/logo.svg` : '';

  const manifest = {
    id: 'community.unified-stream-aggregator',
    version: '1.0.0',
    name: 'Unified Stream',
    description:
      'Aggregates streams from multiple Stremio addons in parallel. ' +
      'Deduplicates, sorts, and normalises bingeGroup for seamless autoplay.',
    ...(logo && { logo }),
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
