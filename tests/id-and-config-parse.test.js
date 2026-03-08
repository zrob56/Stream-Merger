import test from 'node:test';
import assert from 'node:assert/strict';

import { parseConfig, parseId } from '../api/utils/parse.js';

test('parseId keeps provider-prefixed movie IDs intact', () => {
  const out = parseId('tmdb:603');
  assert.equal(out.imdbId, 'tmdb:603');
  assert.equal(out.season, null);
  assert.equal(out.episode, null);
});

test('parseId extracts season/episode from the right for prefixed series IDs', () => {
  const out = parseId('tmdb:1399:1:2');
  assert.equal(out.imdbId, 'tmdb:1399');
  assert.equal(out.season, '1');
  assert.equal(out.episode, '2');
});

test('parseId still works for imdb series IDs', () => {
  const out = parseId('tt0903747:1:1');
  assert.equal(out.imdbId, 'tt0903747');
  assert.equal(out.season, '1');
  assert.equal(out.episode, '1');
});

test('parseConfig normalizes addons to objects with url for string inputs', () => {
  const raw = Buffer.from(JSON.stringify({
    addons: [
      'https://a.test/manifest.json',
      { url: 'https://b.test/manifest.json', name: 'B' },
      '   ',
    ],
  }), 'utf8').toString('base64');

  const parsed = parseConfig(raw);
  assert.deepEqual(parsed.addons, [
    { url: 'https://a.test/manifest.json' },
    { url: 'https://b.test/manifest.json', name: 'B' },
  ]);
});
