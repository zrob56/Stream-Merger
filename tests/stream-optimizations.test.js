import test from 'node:test';
import assert from 'node:assert/strict';

import { isEarlyExitSatisfied, orderAddonsByBreakerState } from '../api/stream.js';

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
