'use strict';

const pkg = require('../../package.json');

const SPORT_CATALOGS = [
  ['basketball', 'Basketball'],
  ['football', 'Football'],
  ['american-football', 'American Football'],
  ['hockey', 'Hockey'],
  ['baseball', 'Baseball'],
  ['motor-sports', 'Motor Sports'],
  ['fight', 'Fight (UFC, Boxing)'],
  ['tennis', 'Tennis'],
  ['rugby', 'Rugby'],
  ['golf', 'Golf'],
  ['billiards', 'Billiards'],
  ['afl', 'AFL'],
  ['darts', 'Darts'],
  ['cricket', 'Cricket'],
  ['other', 'Other'],
];

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
      'Open Streamed browser embeds for live football, basketball, tennis, MMA and more. ' +
      'Browse Live, Today and per-sport catalogs, then choose a source.',
    logo: baseUrl ? `${baseUrl}/assets/icon.svg` : undefined,
    resources: [
      { name: 'catalog', types: ['tv'] },
      { name: 'meta', types: ['tv'], idPrefixes: ['strmd2_', 'strmd_'] },
      { name: 'stream', types: ['tv'], idPrefixes: ['strmd2_', 'strmd_'] },
    ],
    types: ['tv'],
    idPrefixes: ['strmd2_', 'strmd_'],
    catalogs: [
      {
        type: 'tv',
        id: 'streamed_live_v2',
        name: 'Streamed — Live Now',
        extra: [{ name: 'search', isRequired: false }],
      },
      {
        type: 'tv',
        id: 'streamed_today_v2',
        name: 'Streamed — Today',
        extra: [{ name: 'search', isRequired: false }],
      },
      {
        type: 'tv',
        id: 'streamed_popular_v2',
        name: 'Streamed — Popular',
        extra: [{ name: 'search', isRequired: false }],
      },
      ...SPORT_CATALOGS.map(([id, name]) => ({
        type: 'tv',
        id: `streamed_sport_${id}_v2`,
        name: `Streamed — ${name}`,
        extra: [{ name: 'search', isRequired: false }],
      })),
    ],
  };
}

module.exports = { SPORT_CATALOGS, buildManifest };
