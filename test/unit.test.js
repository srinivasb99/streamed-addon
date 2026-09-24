'use strict';

/**
 * Offline unit checks (no network): sorting, id codec, meta mapping,
 * and manifest shape. Run with: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const client = require('../src/providers/streamed/client');
const { buildManifest } = require('../src/stremio/manifest');
const { toStremioId, toVideoId, fromStremioId, toMetaPreview } = require('../src/stremio/handlers');
const { parseExtra } = require('../src/app');

test('Stremio extra path decodes spaces, plus signs, and pagination values', () => {
  assert.deepEqual(parseExtra('search=New+York+%26+LA&skip=100'), {
    search: 'New York & LA',
    skip: '100',
  });
});

test('sortStreams orders HD, then English, then source priority, then streamNo', () => {
  const input = [
    { embedUrl: 'https://e/sd-es', hd: false, language: 'Spanish', source: 'alpha', streamNo: 1 },
    { embedUrl: 'https://e/hd-es', hd: true, language: 'Spanish', source: 'alpha', streamNo: 1 },
    { embedUrl: 'https://e/hd-en-golf', hd: true, language: 'English', source: 'golf', streamNo: 2 },
    { embedUrl: 'https://e/hd-en-delta', hd: true, language: 'English', source: 'delta', streamNo: 3 },
    { embedUrl: 'https://e/hd-en-delta', hd: true, language: 'English', source: 'delta', streamNo: 3 },
    { embedUrl: '', hd: true, language: 'English', source: 'alpha', streamNo: 1 },
    { embedUrl: 'https://e/hd-en-alpha2', hd: true, language: 'English', source: 'alpha', streamNo: 2 },
    { embedUrl: 'https://e/hd-en-alpha1', hd: true, language: 'English', source: 'alpha', streamNo: 1 },
  ];
  const out = client.sortStreams(input).map((s) => s.embedUrl);
  assert.deepEqual(out, [
    'https://e/hd-en-alpha1',
    'https://e/hd-en-alpha2',
    'https://e/hd-en-delta',
    'https://e/hd-en-golf',
    'https://e/hd-es',
    'https://e/sd-es',
  ]);
});

test('stremio id codec round-trips match ids with special chars', () => {
  const id = 'américa-de-cali vs deportivo/pasto?x=1';
  assert.equal(fromStremioId(toStremioId(id)), id);
  assert.equal(fromStremioId(`strmd_${encodeURIComponent(id)}`), id);
  assert.equal(fromStremioId('tt12345'), null);
  assert.equal(fromStremioId(toStremioId(id) + '.json'), id);
});

test('video id (meta id + :play) resolves to the same match', () => {
  const id = 'kansas-city-chiefs-vs-denver-broncos-2475389';
  assert.equal(toVideoId(id), `${toStremioId(id)}:play`);
  // This is the exact id Stremio sends when the user presses play.
  assert.equal(fromStremioId(toVideoId(id)), id);
  assert.equal(fromStremioId(`${toVideoId(id)}.json`), id);
  // A match id that merely contains a colon elsewhere is untouched.
  assert.equal(fromStremioId(toStremioId('weird:id')), 'weird:id');
});

test('toMetaPreview builds a valid meta preview with image URLs', () => {
  const preview = toMetaPreview(
    {
      id: 'm1',
      title: 'A vs B',
      category: 'football',
      date: 1789434000000,
      poster: '/api/images/proxy/abc.webp',
      popular: true,
      teams: { home: { name: 'A', badge: 'badgeA' } },
      sources: [{ source: 'echo', id: 'x' }],
    },
    { football: 'Football' }
  );
  assert.equal(preview.id, 'strmd2_m1');
  assert.equal(preview.type, 'tv');
  assert.equal(preview.poster, 'https://streamed.pk/api/images/proxy/abc.webp');
  assert.deepEqual(preview.genres, ['Football']);
});

test('imageUrl resolves badge ids and absolute paths', () => {
  assert.equal(client.imageUrl('badgeA'), 'https://streamed.pk/api/images/badge/badgeA.webp');
  assert.equal(client.imageUrl('posterA', 'poster'), 'https://streamed.pk/api/images/proxy/posterA.webp');
  assert.equal(client.imageUrl('/api/images/proxy/x.webp'), 'https://streamed.pk/api/images/proxy/x.webp');
  assert.equal(client.imageUrl(null), null);
});

test('manifest satisfies Stremio required fields', () => {
  const m = buildManifest();
  for (const field of ['id', 'version', 'name', 'description', 'resources', 'types', 'catalogs']) {
    assert.ok(m[field], `missing ${field}`);
  }
  const resourceNames = m.resources.map((resource) => (typeof resource === 'string' ? resource : resource.name));
  assert.ok(resourceNames.includes('stream'));
  assert.ok(resourceNames.includes('catalog'));
  assert.ok(resourceNames.includes('meta'));
  assert.ok(m.idPrefixes.includes('strmd2_'));
});
