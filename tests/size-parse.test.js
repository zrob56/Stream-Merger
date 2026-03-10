import test from 'node:test';
import assert from 'node:assert/strict';

import { extractSizeGb } from '../api/utils/parse.js';

function approx(actual, expected, epsilon = 1e-6) {
  assert.ok(Math.abs(actual - expected) < epsilon, `expected ${actual} ~= ${expected}`);
}

test('extractSizeGb reads behaviorHints.videoSize as bytes (number + numeric string)', () => {
  approx(extractSizeGb({ behaviorHints: { videoSize: 2147483648 } }), 2);
  approx(extractSizeGb({ behaviorHints: { videoSize: '2147483648' } }), 2);
});

test('extractSizeGb parses bytes text and comma-formatted bytes', () => {
  approx(extractSizeGb({ title: 'size 2147483648 bytes' }), 2);
  approx(extractSizeGb({ title: 'size 2,147,483,648 bytes' }), 2);
});

test('extractSizeGb parses GiB/MiB and preserves GB/MB behavior', () => {
  approx(extractSizeGb({ title: '3.5 GiB' }), 3.5);
  approx(extractSizeGb({ title: '1536 MiB' }), 1.5);
  approx(extractSizeGb({ title: '3.5 GB' }), 3.5);
  approx(extractSizeGb({ title: '1536 MB' }), 1.5);
});

test('extractSizeGb treats plain large numbers as raw bytes', () => {
  approx(extractSizeGb({ title: 'release size 2147483648' }), 2);
  assert.equal(extractSizeGb({ title: 'imdb id 2147483648' }), 0);
  assert.equal(extractSizeGb({ title: 'episode 101' }), 0);
});

test('extractSizeGb sanity cap rejects absurd values', () => {
  assert.equal(extractSizeGb({ behaviorHints: { videoSize: 800 * 1024 * 1024 * 1024 } }), 0);
  assert.equal(extractSizeGb({ title: '999999999999999 bytes' }), 0);
});

test('extractSizeGb parses comma-formatted plain bytes with size context', () => {
  approx(extractSizeGb({ title: '💾 84,878,683,838' }), 84878683838 / (1024 ** 3), 0.01);
  approx(extractSizeGb({ title: 'file size 2,147,483,648' }), 2, 1e-6);
});

