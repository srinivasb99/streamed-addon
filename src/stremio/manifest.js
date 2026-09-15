'use strict';

const pkg = require('../../package.json');

/**
 * Manifest for the Streamed addon. Live sports do not map to Stremio's
 * movie/series catalogs, so matches are exposed as type "tv" (the
 * conventional type for live channels). No login or configuration is
 * required — the Streamed API is free without authentication.
 *
 * @param {string} [baseUrl] - origin of the running server, for the logo URL.
 */
function buildManifest(baseUrl = '') {
  return {
    id: 'community.streamedaddon',
    version: pkg.version || '1.0.0',
    name: 'Streamed',
    description:
      'Live sports streams from Streamed (streamed.pk): football, basketball, tennis, MMA and more. ' +
      'Browse Live, Today and per-sport catalogs, then pick a sorted HD-first stream.',
    logo: baseUrl ? `${baseUrl}/assets/icon.svg` : undefined,
    resources: [
      { name: 'catalog', types: ['tv'] },
      { name: 'meta', types: ['tv'], idPrefixes: ['strmd_'] },
      { name: 'stream', types: ['tv'], idPrefixes: ['strmd_'] },
    ],
    types: ['tv'],
    idPrefixes: ['strmd_'],
    catalogs: [
      { type: 'tv', id: 'streamed_live', name: 'Streamed — Live Now' },
      { type: 'tv', id: 'streamed_today', name: 'Streamed — Today' },
      { type: 'tv', id: 'streamed_popular', name: 'Streamed — Popular' },
      {
        type: 'tv',
        id: 'streamed_by_sport',
        name: 'Streamed — By Sport',
        extra: [{ name: 'genre', isRequired: false }],
      },
    ],
  };
}

module.exports = { buildManifest };
