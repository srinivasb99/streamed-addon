'use strict';

const pkg = require('../../package.json');

const SPORT_OPTIONS = [
  'Basketball',
  'Football',
  'American Football',
  'Hockey',
  'Baseball',
  'Motor Sports',
  'Fight (UFC, Boxing)',
  'Tennis',
  'Rugby',
  'Golf',
  'Billiards',
  'AFL',
  'Darts',
  'Cricket',
  'Other',
];

const SPORT_EXTRA = {
  name: 'genre',
  isRequired: false,
  options: SPORT_OPTIONS,
  optionsLimit: 1,
};

/**
 * Manifest for the Streamed addon. Live sports do not map to Stremio's
 * movie/series catalogs, so matches are exposed as type "tv" (the
 * conventional type for live channels). No login or configuration is
 * required.
 *
 * @param {string} [baseUrl] - origin of the running server, for the logo URL.
 */
function buildManifest(baseUrl = '') {
  return {
    id: 'community.streamedaddon',
    version: pkg.version || '1.0.0',
    name: 'Streamed',
    description:
      'Live football, basketball, tennis, MMA and more with in-app playback. ' +
      'Browse Live, Today and per-sport catalogs, then pick a sorted HD-first stream.',
    logo: baseUrl ? `${baseUrl}/assets/icon.svg` : undefined,
    resources: [
      { name: 'catalog', types: ['tv'] },
      { name: 'meta', types: ['tv'], idPrefixes: ['strmd2_', 'strmd_'] },
      { name: 'stream', types: ['tv'], idPrefixes: ['strmd2_', 'strmd_'] },
    ],
    types: ['tv'],
    idPrefixes: ['strmd2_', 'strmd_'],
    catalogs: [
      { type: 'tv', id: 'streamed_live_v2', name: 'Streamed — Live Now', extra: [SPORT_EXTRA] },
      { type: 'tv', id: 'streamed_today_v2', name: 'Streamed — Today', extra: [SPORT_EXTRA] },
      { type: 'tv', id: 'streamed_popular_v2', name: 'Streamed — Popular', extra: [SPORT_EXTRA] },
      {
        type: 'tv',
        id: 'streamed_by_sport_v2',
        name: 'Streamed — By Sport',
        extra: [SPORT_EXTRA],
      },
    ],
  };
}

module.exports = { SPORT_OPTIONS, buildManifest };
