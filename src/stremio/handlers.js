'use strict';

/**
 * Stremio catalog / meta / stream handlers: each takes `{type, id, extra}`
 * and returns a Promise of the response object. HTTP serving is plain
 * Express (see src/server.js).
 *
 * ID scheme: every match is exposed as `strmd2_<matchId>` where <matchId>
 * is the Streamed API match id (URL-encoded inside the Stremio id). Stremio's
 * `tv` type is a one-video type, so the playable video ID is the meta ID.
 * The older `:play` form remains accepted for already-installed manifests.
 *
 * Both the current one-video form and the older `:play` form resolve to the
 * same match so existing installs continue to work during the migration.
 */

const client = require('../providers/streamed/client');

const ID_PREFIX = 'strmd2_';
const LEGACY_ID_PREFIX = 'strmd_';
const STREMIO_TYPE = 'tv';
const VIDEO_SUFFIX = ':play';

function toStremioId(matchId) {
  return `${ID_PREFIX}${encodeURIComponent(matchId)}`;
}

function toVideoId(matchId) {
  return `${toStremioId(matchId)}${VIDEO_SUFFIX}`;
}

function fromStremioId(stremioId) {
  const clean = String(stremioId || '').replace(/\.json$/, '');
  const prefix = [ID_PREFIX, LEGACY_ID_PREFIX].find((candidate) => clean.startsWith(candidate));
  if (!prefix) return null;
  try {
    const decoded = decodeURIComponent(clean.slice(prefix.length));
    // Accept both the meta id and the video id (meta id + ":play").
    // Match ids are URL-encoded slugs, so a literal trailing ":play"
    // can only be our own video suffix — never part of a real match id.
    return decoded.endsWith(VIDEO_SUFFIX) ? decoded.slice(0, -VIDEO_SUFFIX.length) : decoded;
  } catch {
    return null;
  }
}

function formatKickoff(date) {
  const ts = Number(date);
  if (!Number.isFinite(ts)) return 'Time TBA';
  return new Date(ts).toLocaleString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sportLabel(category) {
  if (!category) return 'Sports';
  return category
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function toSafeEmbedUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol === 'https:' &&
      url.hostname === 'embed.st' &&
      url.pathname.startsWith('/embed/') &&
      !url.username &&
      !url.password
    ) {
      return url.toString();
    }
  } catch {
    // Ignore malformed or unexpected upstream embed URLs.
  }
  return null;
}

/**
 * Match -> Stremio Meta Preview object.
 * posterShape "landscape" suits match posters; genres carry the sport name
 * so the `genre` catalog extra and Stremio filtering work.
 */
function toMetaPreview(match, sportsById = {}) {
  const teams = (match && match.teams) || {};
  const home = teams.home && teams.home.name;
  const away = teams.away && teams.away.name;
  const poster = client.imageUrl(match.poster, 'poster') || client.imageUrl(home && teams.home.badge);
  const background = client.imageUrl(match.poster, 'poster');
  const logo = client.imageUrl(home && teams.home.badge) || client.imageUrl(away && teams.away.badge);
  const sportName = sportsById[match.category] || sportLabel(match.category);

  return {
    id: toStremioId(match.id),
    type: STREMIO_TYPE,
    name: match.title || 'Untitled match',
    poster: poster || undefined,
    posterShape: 'landscape',
    background: background || undefined,
    logo: logo || undefined,
    description: [match.title, sportName, `Kickoff: ${formatKickoff(match.date)}`]
      .filter(Boolean)
      .join('\n'),
    releaseInfo: Number.isFinite(Number(match.date))
      ? new Date(Number(match.date)).toISOString().slice(0, 10)
      : undefined,
    genres: [sportName].filter(Boolean),
  };
}

async function getSportsById() {
  try {
    const sports = await client.getSports();
    return Object.fromEntries(sports.map((s) => [s.id, s.name]));
  } catch {
    return {}; // callers fall back to formatted category slugs
  }
}

/**
 * Resolve which match listing backs a catalog request.
 * - streamed_live    -> /api/matches/live
 * - streamed_today   -> /api/matches/all-today
 * - streamed_popular -> /api/matches/all, popular first
 * - streamed_by_sport + genre=<sportId> -> /api/matches/[SPORT]
 * - streamed_by_sport without genre -> today's matches across sports
 */
async function resolveCatalogMatches(catalogId, extra) {
  const normalizedId = String(catalogId || '').replace(/_v2$/, '');
  const genre = extra && extra.genre ? String(extra.genre).trim() : '';
  let sportId = genre;
  if (genre) {
    const sports = await client.getSports().catch(() => []);
    const match = sports.find(
      (sport) =>
        String(sport.id).toLowerCase() === genre.toLowerCase() ||
        String(sport.name).toLowerCase() === genre.toLowerCase()
    );
    sportId = match ? match.id : genre;
  }

  if (normalizedId === 'streamed_live') {
    const matches = await client.getMatches('live');
    return sportId ? matches.filter((match) => match.category === sportId) : matches;
  }
  if (normalizedId === 'streamed_today') {
    const matches = await client.getMatches('all-today');
    return sportId ? matches.filter((match) => match.category === sportId) : matches;
  }
  if (normalizedId === 'streamed_popular') {
    const all = await client.getMatches('all');
    const filtered = sportId ? all.filter((match) => match.category === sportId) : all;
    return [...filtered].sort((a, b) => Number(Boolean(b.popular)) - Number(Boolean(a.popular)));
  }
  if (normalizedId.startsWith('streamed_sport_')) {
    const sportId = normalizedId.slice('streamed_sport_'.length);
    return client.getMatches(sportId);
  }
  if (normalizedId === 'streamed_by_sport') {
    if (sportId) return client.getMatches(String(sportId));
    return client.getMatches('all-today');
  }
  return null; // unknown catalog
}

/** A match counts as live if it kicked off within the last 4 hours. */
function isLive(match) {
  const ts = Number(match && match.date);
  if (!Number.isFinite(ts)) return false;
  const now = Date.now();
  return ts <= now && now - ts < 4 * 60 * 60 * 1000;
}

/** SDK catalog handler: ({ type, id, extra }) => Promise<{ metas }> */
async function catalogHandler({ type, id, extra }) {
  try {
    if (type !== STREMIO_TYPE) return { metas: [] };
    const matches = await resolveCatalogMatches(id, extra || {});
    if (!matches) return { metas: [] };

    const sportsById = await getSportsById();

    let filtered = matches;
    if (extra && extra.search) {
      const q = String(extra.search).toLowerCase();
      filtered = matches.filter((m) => String((m && m.title) || '').toLowerCase().includes(q));
    }

    // Keep the Popular catalog useful while prioritizing live events elsewhere.
    const isPopularCatalog = String(id || '').replace(/_v2$/, '') === 'streamed_popular';
    filtered = [...filtered].sort((a, b) => {
      if (isPopularCatalog) {
        const popularDiff = Number(Boolean(b.popular)) - Number(Boolean(a.popular));
        if (popularDiff !== 0) return popularDiff;
      }
      const liveDiff = Number(isLive(b)) - Number(isLive(a));
      if (liveDiff !== 0) return liveDiff;
      return Number(a.date || 0) - Number(b.date || 0);
    });

    // Stremio uses `skip` for catalog pagination. Returning the same first
    // page for every request makes large catalogs impossible to browse.
    const parsedSkip = Number.parseInt(extra && extra.skip, 10);
    const skip = Number.isFinite(parsedSkip) ? Math.max(0, parsedSkip) : 0;
    return { metas: filtered.slice(skip, skip + 100).map((m) => toMetaPreview(m, sportsById)) };
  } catch {
    return { metas: [] };
  }
}

/** SDK meta handler: ({ type, id }) => Promise<{ meta }> */
async function metaHandler({ type, id }) {
  try {
    if (type !== STREMIO_TYPE) return { meta: null };
    const matchId = fromStremioId(id);
    if (!matchId) return { meta: null };
    const match = await client.getMatchById(matchId);
    if (!match) return { meta: null };

    const sportsById = await getSportsById();
    const preview = toMetaPreview(match, sportsById);
    const teams = match.teams || {};
    return {
      meta: {
        ...preview,
        description: [
          match.title,
          [teams.home && teams.home.name, teams.away && teams.away.name].filter(Boolean).join(' vs '),
          `${sportsById[match.category] || sportLabel(match.category)} — Kickoff: ${formatKickoff(match.date)}`,
          match.popular ? 'Popular' : null,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    };
  } catch {
    return { meta: null };
  }
}

/**
 * SDK stream handler: ({ type, id }) => Promise<{ streams }>.
 *
 * Aggregates every source of the match, already sorted best-first
 * (HD → English → preferred source → lowest stream number).
 *
 * Streamed returns browser embed pages rather than direct video files. Use
 * Stremio's externalUrl field and accept only Streamed's HTTPS embed host.
 */
async function streamHandler({ type, id }) {
  try {
    if (type !== STREMIO_TYPE) return { streams: [] };
    const matchId = fromStremioId(id);
    if (!matchId) return { streams: [] };
    const match = await client.getMatchById(matchId);
    if (!match) return { streams: [] };

    const streams = await client.getStreamsForMatch(match);
    return {
      streams: streams.flatMap((s) => {
        const externalUrl = toSafeEmbedUrl(s.embedUrl);
        if (!externalUrl) return [];

        const quality = s.hd ? 'HD' : 'SD';
        const lang = s.language || 'Unknown';
        const source = String(s.source || 'unknown').toUpperCase();
        return {
          name: `Streamed ${quality}`,
          description: `${match.title}\n${lang} · ${quality} · Source ${source} · Stream ${s.streamNo || 1}`,
          externalUrl,
          behaviorHints: {
            bingeGroup: `streamed-${String(s.source || 'unknown').toLowerCase()}-${s.hd ? 'hd' : 'sd'}`,
          },
        };
      }),
    };
  } catch {
    return { streams: [] };
  }
}

module.exports = {
  ID_PREFIX,
  LEGACY_ID_PREFIX,
  STREMIO_TYPE,
  VIDEO_SUFFIX,
  toStremioId,
  toVideoId,
  fromStremioId,
  isLive,
  toMetaPreview,
  catalogHandler,
  metaHandler,
  streamHandler,
};
