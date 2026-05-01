import test from 'node:test';
import assert from 'node:assert/strict';

import { isEarlyExitSatisfied, orderAddonsByBreakerState } from '../api/stream.js';
import { deduplicateStreams, applyFilters } from '../api/utils/filter.js';

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

const BLANK_FILTERS = {
  excludeTerms: [], requiredHdr: [], requiredCodec: [], requiredSource: [],
  requiredAudio: [], cachedOnly: false, minSeeders: 0, maxSizeGb: 0, minResolution: null, allowAdult: false,
};

test('trailer filter: keeps large streams whose title contains trailer keywords (The Interview, Extras)', () => {
  const streams = [
    // "The Interview" — real movie, ~8 GB file
    { name: 'The Interview 2014 1080p BluRay x264', _size: 8.2 },
    // "Extras" BBC show — real episode, ~1.5 GB
    { name: 'Extras S01E01 1080p WEB-DL', _size: 1.5 },
    // Actual trailer — tiny, no size info
    { name: 'Movie Official Trailer 2024 HD' },
    // Actual featurette — tiny
    { name: 'Making of Featurette 720p', _size: 0.05 },
  ];
  const result = applyFilters(streams, BLANK_FILTERS);
  assert.equal(result.length, 2, 'large streams with keyword titles should survive; tiny trailers should be dropped');
  assert.ok(result.some(s => s.name.includes('The Interview')));
  assert.ok(result.some(s => s.name.includes('Extras')));
});

test('trailer filter: still drops real trailers and featurettes (tiny or no size)', () => {
  const streams = [
    { name: 'Official Trailer 1080p' },                         // no size → drop
    { name: 'Behind The Scenes Featurette', _size: 0.1 },       // tiny → drop
    { name: 'Deleted Scene Extended Cut', _size: 0.08 },        // tiny → drop
    { name: 'Normal Movie 1080p BluRay', _size: 10.0 },         // keep
  ];
  const result = applyFilters(streams, BLANK_FILTERS);
  assert.equal(result.length, 1);
  assert.ok(result[0].name.includes('Normal Movie'));
});

test('adult filter: blocks explicit titles by default', () => {
  const streams = [
    { name: 'Lincoln 2012 1080p BluRay x264', _size: 8.1 },
    { name: 'Balls Deep in Paris Lincoln 1080p', _size: 2.4 },
    { name: 'Family Movie Night', title: 'No adult terms here', _size: 1.2 },
  ];
  const result = applyFilters(streams, BLANK_FILTERS);
  assert.equal(result.length, 2);
  assert.ok(result.some(s => s.name.includes('Lincoln 2012')));
  assert.ok(!result.some(s => s.name.includes('Balls Deep in Paris')));
});

test('adult filter: can be explicitly disabled with allowAdult=true', () => {
  const streams = [
    { name: 'Balls Deep in Paris Lincoln 1080p', _size: 2.4 },
  ];
  const result = applyFilters(streams, { ...BLANK_FILTERS, allowAdult: true });
  assert.equal(result.length, 1);
});
