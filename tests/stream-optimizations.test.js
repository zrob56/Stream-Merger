import test from 'node:test';
import assert from 'node:assert/strict';

import { isEarlyExitSatisfied, orderAddonsByBreakerState } from '../api/stream.js';

test('early-exit uses +1 margin per requested tier', () => {
  // Targets top=1 balanced=1 efficient=1 with margin +1.
  assert.equal(isEarlyExitSatisfied(1, 1, 1, 1, 1, 1), false);
  assert.equal(isEarlyExitSatisfied(2, 2, 2, 1, 1, 1), true);
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
