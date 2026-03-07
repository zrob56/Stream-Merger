import test from 'node:test';
import assert from 'node:assert/strict';

import { applySmartTiering, classifyStreamTier } from '../api/utils/filter.js';

function makeStream(label, sizeGb, resolution) {
  return {
    name: `${label} ${resolution}`,
    title: `${sizeGb} GB ${resolution}`,
  };
}

function countTiers(streams, resolution, options) {
  const counts = { top: 0, balanced: 0, efficient: 0, unknown: 0 };
  for (const s of streams) {
    const t = classifyStreamTier(s, resolution, options);
    counts[t] += 1;
  }
  return counts;
}

test('runtime-present classifier is resolution-aware at same size/runtime', () => {
  // 15 GB over 120 min ~= 17.07 Mbps
  const s = makeStream('Sample', 15, '4k');
  const fourK = classifyStreamTier(s, '4k', { runtimeMinutes: 120 });
  const fhd = classifyStreamTier(s, '1080p', { runtimeMinutes: 120 });

  assert.equal(fourK, 'balanced');
  assert.equal(fhd, 'top');
});

test('runtime-missing path falls back to size thresholds', () => {
  const stream = makeStream('Fallback', 6, '1080p');
  const tier = classifyStreamTier(stream, '1080p', { runtimeMinutes: 0, groupMaxSizeGb: 20 });
  assert.equal(tier, 'balanced');
});

test('parity: classifier counts match selected tier slots for same grouped set', () => {
  const runtimeMinutes = 120;
  const group = [
    makeStream('Top', 30, '1080p'),      // ~34 Mbps -> top
    makeStream('Balanced', 12, '1080p'), // ~13.6 Mbps -> top per threshold 12 (fills top then spills)
    makeStream('Eff', 2, '1080p'),       // ~2.2 Mbps -> efficient
    makeStream('Unknown', 0, '1080p'),   // unknown
  ];

  const counts = countTiers(group, '1080p', { runtimeMinutes });
  assert.equal(counts.top, 2);
  assert.equal(counts.efficient, 1);
  assert.equal(counts.unknown, 1);

  const selected = applySmartTiering(group, 1, 1, 1, { runtimeMinutes });
  assert.equal(selected.length, 3);
});

test('unknown size/runtime streams are classified unknown and backfilled', () => {
  const streams = [
    { name: 'Unknown A', title: 'no size here' },
    { name: 'Unknown B', title: 'still no size' },
    { name: 'Known', title: '1.5 GB 1080p' },
  ];

  const t0 = classifyStreamTier(streams[0], '1080p', { runtimeMinutes: 0, groupMaxSizeGb: 2 });
  assert.equal(t0, 'unknown');

  const selected = applySmartTiering(streams, 1, 1, 1, { runtimeMinutes: 0 });
  assert.equal(selected.length, 3);
});

test('intra-tier quality sort: Remux leads over WEB-DL within the same tier', () => {
  const runtimeMinutes = 120;
  // Both ~22.8 Mbps -> top tier; WEB-DL listed first to confirm sort overrides arrival order
  const webdl = { name: 'WEB-DL 1080p', title: '20 GB 1080p', _source: 'WEB-DL', _hdrTier: 3, _audioTier: 3, _codecTier: 2, _seeders: 500 };
  const remux = { name: 'Remux 1080p',  title: '20 GB 1080p', _source: 'Remux',  _hdrTier: 3, _audioTier: 3, _codecTier: 2, _seeders: 100 };

  const selected = applySmartTiering([webdl, remux], 2, 0, 0, { runtimeMinutes });
  assert.equal(selected.length, 2);
  assert.equal(selected[0].name, 'Remux 1080p');
});

test('top-classified streams do not consume balanced/efficient slots before those tiers are filled', () => {
  const runtimeMinutes = 120;
  const streams = [
    makeStream('Top A', 20, '1080p'),      // ~22.8 Mbps -> top
    makeStream('Top B', 18, '1080p'),      // ~20.5 Mbps -> top
    makeStream('Balanced A', 5, '1080p'),  // ~5.7 Mbps  -> balanced
    makeStream('Efficient A', 1, '1080p'), // ~1.1 Mbps  -> efficient
  ];

  const selected = applySmartTiering(streams, 1, 1, 1, { runtimeMinutes });
  const names = selected.map(s => s.name);

  assert.equal(selected.length, 3);
  assert.ok(names.some(n => n.includes('Top A') || n.includes('Top B')));
  assert.ok(names.some(n => n.includes('Balanced A')));
  assert.ok(names.some(n => n.includes('Efficient A')));
});
