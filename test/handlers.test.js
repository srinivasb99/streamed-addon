'use strict';

/**
 * Handler-level tests with a stubbed Streamed API (no network).
 * Run with: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const client = require('../src/providers/streamed/client');
const { catalogHandler, metaHandler, streamHandler } = require('../src/stremio/handlers');

const MATCHES = [
  {
    id: 'm1',
    title: 'Lions vs Tigers',
    category: 'football',
    date: Date.now() + 3600 * 1000,
    popular: true,
    teams: { home: { name: 'Lions', badge: 'b1' }, away: { name: 'Tigers', badge: 'b2' } },
    sources: [
      { source: 'alpha', id: 'a1' },
      { source: 'mystery', id: 'x9' },
    ],
  },
  {
    id: 'm2',
    title: 'Bears vs Wolves',
    category: 'football',
    date: Date.now() + 7200 * 1000,
    popular: false,
    sources: [{ source: 'bravo', id: 'b9' }],
  },
];

const STREAMS_ALPHA = [
  { id: 'a1', streamNo: 2, language: 'Spanish', hd: false, embedUrl: 'https://embed.st/a/2', source: 'alpha' },
  { id: 'a1', streamNo: 1, language: 'English', hd: true, embedUrl: 'https://embed.st/a/1', source: 'alpha' },
];
const STREAMS_MYSTERY = [
  { id: 'x9', streamNo: 1, language: 'English', hd: true, embedUrl: 'https://embed.st/x/1', source: 'mystery' },
];

function stubFetch() {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const path = String(url).replace('https://streamed.pk', '');
    let body = [];
    if (path.startsWith('/api/sports')) body = [{ id: 'football', name: 'Football' }];
    else if (path.startsWith('/api/matches/')) body = MATCHES;
    else if (path.startsWith('/api/stream/alpha/')) body = STREAMS_ALPHA;
    else if (path.startsWith('/api/stream/mystery/')) body = STREAMS_MYSTERY;
    else if (path.startsWith('/api/stream/bravo/')) body = [];
    return { ok: true, status: 200, json: async () => body };
  };
  return () => {
    global.fetch = realFetch;
  };
}

test('catalogHandler returns sorted metas for live', async () => {
  const restore = stubFetch();
  try {
    client.clearCache();
    const { metas } = await catalogHandler({ type: 'tv', id: 'streamed_live', extra: {} });
    assert.equal(metas.length, 2);
    assert.equal(metas[0].id, 'strmd_m1'); // earlier kickoff first
    assert.equal(metas[0].type, 'tv');
    assert.deepEqual(metas[0].genres, ['Football']);
  } finally {
    restore();
  }
});

test('catalogHandler supports search + rejects bad type/catalog', async () => {
  const restore = stubFetch();
  try {
    client.clearCache();
    const found = await catalogHandler({ type: 'tv', id: 'streamed_today', extra: { search: 'wolves' } });
    assert.equal(found.metas.length, 1);
    assert.equal(found.metas[0].name, 'Bears vs Wolves');

    assert.deepEqual(await catalogHandler({ type: 'movie', id: 'streamed_live', extra: {} }), { metas: [] });
    assert.deepEqual(await catalogHandler({ type: 'tv', id: 'nope', extra: {} }), { metas: [] });
  } finally {
    restore();
  }
});

test('metaHandler returns full meta, null for unknown', async () => {
  const restore = stubFetch();
  try {
    client.clearCache();
    const { meta } = await metaHandler({ type: 'tv', id: 'strmd_m1' });
    assert.equal(meta.name, 'Lions vs Tigers');
    assert.equal(meta.videos, undefined);
    assert.equal(meta.behaviorHints, undefined);

    assert.deepEqual(await metaHandler({ type: 'tv', id: 'strmd_missing' }), { meta: null });
    assert.deepEqual(await metaHandler({ type: 'tv', id: 'tt123' }), { meta: null });
  } finally {
    restore();
  }
});

test('streamHandler aggregates all sources and sorts HD-first', async () => {
  const restore = stubFetch();
  try {
    client.clearCache();
    const { streams } = await streamHandler({ type: 'tv', id: 'strmd_m1' });
    assert.equal(streams.length, 3);
    // alpha HD English first, then unknown-source HD English (source rank last), then SD
    assert.match(streams[0].url, /^http:\/\/127\.0\.0\.1:7000\/play\/.+\.m3u8$/);
    assert.match(streams[1].url, /^http:\/\/127\.0\.0\.1:7000\/play\/.+\.m3u8$/);
    assert.match(streams[2].url, /^http:\/\/127\.0\.0\.1:7000\/play\/.+\.m3u8$/);
    for (const s of streams) {
      assert.equal(s.behaviorHints.notWebReady, true);
      assert.equal(s.behaviorHints.live, true);
      assert.ok(s.url, 'an addon-hosted HLS URL must be set');
      assert.equal(s.externalUrl, undefined, 'externalUrl would force browser playback');
      assert.ok(s.description);
    }
    assert.deepEqual(await streamHandler({ type: 'tv', id: 'tt123' }), { streams: [] });
  } finally {
    restore();
  }
});

test('streamHandler resolves the :play video id Stremio sends on press-play', async () => {
  const restore = stubFetch();
  try {
    client.clearCache();
    const { streams } = await streamHandler({ type: 'tv', id: 'strmd_m1:play' });
    assert.equal(streams.length, 3);
    assert.match(streams[0].url, /^http:\/\/127\.0\.0\.1:7000\/play\/.+\.m3u8$/);
  } finally {
    restore();
  }
});

test('streamHandler tolerates upstream failure', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  try {
    client.clearCache();
    assert.deepEqual(await catalogHandler({ type: 'tv', id: 'streamed_live', extra: {} }), { metas: [] });
    assert.deepEqual(await streamHandler({ type: 'tv', id: 'strmd_m1' }), { streams: [] });
  } finally {
    global.fetch = realFetch;
  }
});
