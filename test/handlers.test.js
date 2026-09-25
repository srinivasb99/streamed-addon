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
  { id: 'a1', streamNo: 2, language: 'Spanish', hd: false, embedUrl: 'https://embed.st/embed/alpha/a1/2', source: 'alpha' },
  { id: 'a1', streamNo: 1, language: 'English', hd: true, embedUrl: 'https://embed.st/embed/alpha/a1/1', source: 'alpha' },
];
const STREAMS_MYSTERY = [
  { id: 'x9', streamNo: 1, language: 'English', hd: true, embedUrl: 'https://embed.st/embed/mystery/x9/1', source: 'mystery' },
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
    const { metas } = await catalogHandler({ type: 'tv', id: 'streamed_live_v2', extra: {} });
    assert.equal(metas.length, 2);
    assert.equal(metas[0].id, 'strmd2_m1'); // earlier kickoff first
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
    const found = await catalogHandler({ type: 'tv', id: 'streamed_today_v2', extra: { search: 'wolves' } });
    assert.equal(found.metas.length, 1);
    assert.equal(found.metas[0].name, 'Bears vs Wolves');

    assert.deepEqual(await catalogHandler({ type: 'movie', id: 'streamed_live', extra: {} }), { metas: [] });
    assert.deepEqual(await catalogHandler({ type: 'tv', id: 'nope', extra: {} }), { metas: [] });
  } finally {
    restore();
  }
});

test('catalogHandler honors Stremio skip pagination', async () => {
  const restore = stubFetch();
  try {
    client.clearCache();
    const { metas } = await catalogHandler({ type: 'tv', id: 'streamed_today_v2', extra: { skip: '1' } });
    assert.equal(metas.length, 1);
    assert.equal(metas[0].name, 'Bears vs Wolves');
  } finally {
    restore();
  }
});

test('catalogHandler maps friendly genre options to Streamed sport IDs', async () => {
  const restore = stubFetch();
  try {
    client.clearCache();
    const found = await catalogHandler({ type: 'tv', id: 'streamed_by_sport_v2', extra: { genre: 'Football' } });
    assert.equal(found.metas.length, 2);
    assert.deepEqual(found.metas.map((meta) => meta.genres[0]), ['Football', 'Football']);
  } finally {
    restore();
  }
});

test('catalogHandler supports first-class sport catalogs', async () => {
  const restore = stubFetch();
  try {
    client.clearCache();
    const found = await catalogHandler({ type: 'tv', id: 'streamed_sport_football_v2', extra: {} });
    assert.equal(found.metas.length, 2);
    assert.deepEqual(found.metas.map((meta) => meta.genres[0]), ['Football', 'Football']);
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

test('streamHandler returns safe Streamed browser embeds sorted HD-first', async () => {
  const restore = stubFetch();
  try {
    client.clearCache();
    const { streams } = await streamHandler({ type: 'tv', id: 'strmd_m1' });
    assert.equal(streams.length, 3);
    // alpha HD English first, then unknown-source HD English (source rank last), then SD
    assert.match(streams[0].externalUrl, /^https:\/\/embed\.st\/embed\//);
    assert.match(streams[1].externalUrl, /^https:\/\/embed\.st\/embed\//);
    assert.match(streams[2].externalUrl, /^https:\/\/embed\.st\/embed\//);
    for (const s of streams) {
      assert.equal(s.behaviorHints.live, undefined);
      assert.equal(s.url, undefined, 'Streamed supplies browser embed pages, not direct media URLs');
      assert.ok(s.externalUrl);
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
    assert.match(streams[0].externalUrl, /^https:\/\/embed\.st\/embed\//);
  } finally {
    restore();
  }
});

test('streamHandler excludes embed URLs outside Streamed', async () => {
  const restore = stubFetch();
  const originalGetStreamsForMatch = client.getStreamsForMatch;
  client.getStreamsForMatch = async () => [
    {
      source: 'alpha',
      hd: true,
      embedUrl: 'https://embed.st/embed/alpha/a1/1',
      streamNo: 1,
    },
    {
      source: 'bad',
      hd: true,
      embedUrl: 'https://example.com/embed/redirect',
      streamNo: 2,
    },
  ];
  try {
    client.clearCache();
    const { streams } = await streamHandler({ type: 'tv', id: 'strmd_m1' });
    assert.equal(streams.length, 1);
    assert.equal(streams[0].externalUrl, 'https://embed.st/embed/alpha/a1/1');
  } finally {
    client.getStreamsForMatch = originalGetStreamsForMatch;
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
