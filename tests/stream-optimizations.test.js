import test from 'node:test';
import assert from 'node:assert/strict';

import { isEarlyExitSatisfied, orderAddonsByBreakerState } from '../api/stream.js';
import { deduplicateStreams } from '../api/utils/filter.js';

test('early-exit exits exactly at target (margin=0)', () => {
  // Exact match satisfies.
  assert.equal(isEarlyExitSatisfied(1, 1, 1, 1, 1, 1), true);
  // One tier short does not satisfy.
  assert.equal(isEarlyExitSatisfied(0, 1, 1, 1, 1, 1), false);
});

test('early-exit ignores tiers that are disabled (target 0)', () => {
  // Only top tier requested. Balanced/efficient should not block exit.
  assert.equal(isEarlyExitSatisfied(2, 0, 0, 1, 0, 0), true);
});

test('circuit-breaker ordering deprioritizes unstable addons but keeps all', () => {
  const addons = ['https://a.test/manifest.json', 'https://b.test/manifest.json', 'https://c.test/manifest.json'];
  const breakerState = {
    'https://a.test/manifest.json': 0,
    'https://b.test/manifest.json': 120,
    'https://c.test/manifest.json': 0,
  };

  const ordered = orderAddonsByBreakerState(addons, breakerState);
  assert.deepEqual(ordered.map(a => a.url), [
    'https://a.test/manifest.json',
    'https://c.test/manifest.json',
    'https://b.test/manifest.json',
  ]);
  assert.equal(ordered.length, addons.length);
});

test('fuzzy dedup: same release tag (-tgx), size diff 0.08 GB → deduped to 1', () => {
  const streams = [
    { name: '1080p WEB-DL', title: 'Movie.1080p.WEB-DL-TGx.mkv', _addonName: 'Torrentio', _size: 10.00 },
    { name: '1080p WEB-DL', title: 'Movie.1080p.WEB-DL-TGx.mkv', _addonName: 'Comet',     _size: 10.08 },
  ];
  const result = deduplicateStreams(streams);
  assert.equal(result.length, 1);
  assert.ok(result[0]._sources.includes('Comet'));
});

test('fuzzy dedup: no release tag, size diff 0.08 GB → merged', () => {
  const streams = [
    { name: '1080p WEB-DL', title: 'Movie.1080p.WEB-DL.mkv', _addonName: 'AddonA', _size: 10.00 },
    { name: '1080p WEB-DL', title: 'Movie.1080p.WEB-DL.mkv', _addonName: 'AddonB', _size: 10.08 },
  ];
  const result = deduplicateStreams(streams);
  assert.equal(result.length, 1);
});

test('pass 1 dedup: same behaviorHints.filename, no infoHash/url → deduped to 1', () => {
  const streams = [
    { behaviorHints: { filename: 'Movie.1080p.WEB-DL-TGx.mkv' }, _addonName: 'StremThru' },
    { behaviorHints: { filename: 'Movie.1080p.WEB-DL-TGx.mkv' }, _addonName: 'Proxy' },
  ];
  const result = deduplicateStreams(streams);
  assert.equal(result.length, 1);
  assert.ok(result[0]._sources.includes('Proxy'));
});
