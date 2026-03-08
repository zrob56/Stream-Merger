import test from 'node:test';
import assert from 'node:assert/strict';

import { formatStreamDisplay } from '../api/utils/format.js';
import { hasEmbeddedSubs } from '../api/utils/parse.js';
import { buildWarmupHeaders, getAddonBreakerState, needsIpForwarding } from '../api/stream.js';
import { fetchWithTimeout } from '../api/utils/parse.js';

test('subtitle display: confirmed marker uses 💬 and wins over likely marker', () => {
  const stream = {
    name: 'Example',
    title: 'Movie.2026.1080p subtitles',
    behaviorHints: { filename: 'Movie.2026.1080p.mkv' },
  };

  const [out] = formatStreamDisplay([stream], ['subs']);
  assert.ok(out.title.includes('\u{1F4AC}'));
  assert.ok(!out.title.includes('\u{1F5E3}\uFE0F'));
});

test('subtitle display: mkv-only streams show 🗣️ when subs are likely', () => {
  const stream = {
    name: 'Example',
    title: 'Movie.2026.1080p',
    behaviorHints: { filename: 'Movie.2026.1080p.mkv' },
  };

  const [out] = formatStreamDisplay([stream], ['subs']);
  assert.ok(out.title.includes('\u{1F5E3}\uFE0F'));
  assert.ok(!out.title.includes('\u{1F4AC}'));
});

test('subtitle display: no icon when subs display field is disabled', () => {
  const stream = {
    name: 'Example',
    title: 'Movie.2026.1080p subtitles',
    behaviorHints: { filename: 'Movie.2026.1080p.mkv' },
  };

  const [out] = formatStreamDisplay([stream], ['size']);
  assert.ok(!out.title.includes('\u{1F4AC}'));
  assert.ok(!out.title.includes('\u{1F5E3}\uFE0F'));
});

test('embedded subs compatibility helper remains true for likely-or-confirmed', () => {
  assert.equal(hasEmbeddedSubs({ title: 'title subtitles' }), true);
  assert.equal(hasEmbeddedSubs({ behaviorHints: { filename: 'x.mkv' } }), true);
  assert.equal(hasEmbeddedSubs({ title: 'plain title', behaviorHints: { filename: 'x.mp4' } }), false);
});

test('warmup header forwarding follows session-sensitive addon policy', () => {
  assert.equal(needsIpForwarding('https://torrentio.strem.fun/manifest.json'), false);
  assert.equal(needsIpForwarding('https://sootio.com/manifest.json'), true);

  const none = buildWarmupHeaders('1.2.3.4', ['https://torrentio.strem.fun/manifest.json']);
  assert.deepEqual(none, {});

  const yes = buildWarmupHeaders('1.2.3.4', [
    'https://torrentio.strem.fun/manifest.json',
    'https://sootio.com/manifest.json',
  ]);
  assert.deepEqual(yes, { 'X-Forwarded-For': '1.2.3.4', 'X-Real-IP': '1.2.3.4' });
});

test('breaker state uses pipeline when available', async () => {
  const redis = {
    pipeline() {
      const calls = [];
      return {
        ttl(key) { calls.push(key); return this; },
        async exec() {
          assert.equal(calls.length, 2);
          return [[null, 120], [null, -1]];
        },
      };
    },
  };

  const state = await getAddonBreakerState(redis, ['https://a.test/manifest.json', 'https://b.test/manifest.json']);
  assert.equal(state['https://a.test/manifest.json'], 120);
  assert.equal(state['https://b.test/manifest.json'], 0);
});

test('breaker state falls back to ttl calls when pipeline fails', async () => {
  let ttlCalls = 0;
  const redis = {
    pipeline() {
      return {
        ttl() { return this; },
        async exec() { throw new Error('pipeline unavailable'); },
      };
    },
    async ttl() {
      ttlCalls += 1;
      return ttlCalls === 1 ? 55 : -1;
    },
  };

  const state = await getAddonBreakerState(redis, ['https://a.test/manifest.json', 'https://b.test/manifest.json']);
  assert.equal(state['https://a.test/manifest.json'], 55);
  assert.equal(state['https://b.test/manifest.json'], 0);
});

test('fetchWithTimeout registers external abort listener with once and removes it', async () => {
  const originalFetch = global.fetch;
  const calls = { once: undefined, added: 0, removed: 0 };
  const externalSignal = {
    aborted: false,
    addEventListener(_evt, _fn, opts) {
      calls.added += 1;
      calls.once = opts?.once;
    },
    removeEventListener() {
      calls.removed += 1;
    },
  };

  global.fetch = async () => ({ ok: true, json: async () => ({ streams: [] }) });
  try {
    await fetchWithTimeout('https://example.test/ok', 1000, null, externalSignal);
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls.added, 1);
  assert.equal(calls.once, true);
  assert.equal(calls.removed, 1);
});
