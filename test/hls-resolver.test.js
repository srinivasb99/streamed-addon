'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeEmbedUrl,
  decodeManifestUrl,
  encodeEmbedUrl,
  encodeManifestUrl,
  playbackUrl,
  rewriteManifest,
} = require('../src/streaming/hls-resolver');

test('playback URL round-trips an allowed embed page', () => {
  const embed = 'https://embed.st/embed/delta/event-id/1';
  const token = encodeEmbedUrl(embed);
  assert.equal(decodeEmbedUrl(token), embed);
  assert.equal(playbackUrl('https://addon.example/', embed), `https://addon.example/play/${token}.m3u8`);
});

test('playback URL rejects non-embed and non-HTTPS targets', () => {
  assert.equal(decodeEmbedUrl(encodeEmbedUrl('https://example.com/embed/x/1')), null);
  assert.equal(decodeEmbedUrl(encodeEmbedUrl('http://embed.st/embed/x/1')), null);
  assert.equal(decodeEmbedUrl(encodeEmbedUrl('https://embed.st/not-an-embed')), null);
});

test('manifest URL round-trips only the stream CDN', () => {
  const manifest = 'https://lb2.strmd.st/secure/token/source/event/1/playlist.m3u8';
  assert.equal(decodeManifestUrl(encodeManifestUrl(manifest)), manifest);
  assert.equal(decodeManifestUrl(encodeManifestUrl('https://example.com/file.m3u8')), null);
});

test('rewriteManifest makes segments absolute and keeps nested playlists on the resolver', () => {
  const upstream = 'https://lb2.strmd.st/secure/token/source/event/1/master.m3u8';
  const path = 'https://addon.example/play/embed-token.m3u8';
  const input = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="keys/live.key"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000',
    '720/playlist.m3u8',
    '#EXTINF:5,',
    '/media/segment.ts?sig=abc',
  ].join('\n');
  const output = rewriteManifest(input, upstream, path);

  assert.match(output, /URI="https:\/\/lb2\.strmd\.st\/secure\/token\/source\/event\/1\/keys\/live\.key"/);
  assert.match(output, new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?manifest=`));
  assert.match(output, /https:\/\/lb2\.strmd\.st\/media\/segment\.ts\?sig=abc/);
});
