// api/addons.js
// Proxy for the Stremio community addon registry.
// Filters to stream-capable addons and returns a cleaned array.
// Edge-cached for 1 hour (registry changes rarely).

const REGISTRY_URL = 'https://stremio-addons.com/catalog.json';
const FETCH_TIMEOUT_MS = 10000;

function deriveConfigUrl(entry) {
  const hints = entry?.manifest?.behaviorHints;
  if (hints?.configurationURL) return hints.configurationURL;
  if (entry?.manifest?.homepage) return entry.manifest.homepage;
  try {
    const u = new URL(entry.transportUrl);
    return u.origin;
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let catalog;
  try {
    const response = await fetch(REGISTRY_URL, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Registry responded with HTTP ${response.status}`);
    }
    catalog = await response.json();
  } catch (err) {
    clearTimeout(timer);
    res.status(502).json({ error: `Failed to fetch addon registry: ${err.message}` });
    return;
  }
  clearTimeout(timer);

  // The catalog is an array of addon descriptor objects.
  // Each entry has a `manifest` sub-object and a `transportUrl`.
  const entries = Array.isArray(catalog) ? catalog : [];

  const streamAddons = entries
    .filter((entry) => {
      const resources = entry?.manifest?.resources;
      if (!Array.isArray(resources)) return false;
      // resources can be strings like "stream" or objects like { name: "stream", ... }
      return resources.some((r) =>
        typeof r === 'string' ? r === 'stream' : r?.name === 'stream'
      );
    })
    .map((entry) => ({
      name:         entry.manifest?.name ?? 'Unknown',
      description:  entry.manifest?.description ?? '',
      logo:         entry.manifest?.logo ?? null,
      transportUrl: entry.transportUrl ?? null,
      types:        Array.isArray(entry.manifest?.types) ? entry.manifest.types : [],
      configUrl:    deriveConfigUrl(entry),
    }))
    .filter((a) => a.transportUrl); // drop any entries missing a usable URL

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
  res.status(200).json(streamAddons);
}
