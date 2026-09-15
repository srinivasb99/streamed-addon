'use strict';

/**
 * Stremio catalog / meta / stream handlers: each takes `{type, id, extra}`
 * and returns a Promise of the response object. HTTP serving is plain
 * Express (see src/app/index.js).
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
const { playbackUrl } = require('../streaming/hls-resolver');

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

/**
 * Match -> Stremio Meta Preview object.
 * posterShape "landscape" suits match posters; genres carry the sport name
 * so the `genre` catalog extra and Stremio filtering work.
 */
function toMetaPreview(match, sportsById = {}) {
  const teams = (match && match.teams) || {};
  const home = teams.home && teams.home.name;
  const away = teams.away && teams.away.name;
  const poster = client.imageUrl(match.poster) || client.imageUrl(home && teams.home.badge);
  const background = client.imageUrl(match.poster);
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
  if (normalizedId === 'streamed_live') return client.getMatches('live');
  if (normalizedId === 'streamed_today') return client.getMatches('all-today');
  if (normalizedId === 'streamed_popular') {
    const all = await client.getMatches('all');
    return [...all].sort((a, b) => Number(Boolean(b.popular)) - Number(Boolean(a.popular)));
  }
  if (normalizedId === 'streamed_by_sport') {
    const genre = extra && extra.genre;
    if (genre) return client.getMatches(String(genre));
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

    // Live first, then chronological kickoff order.
    filtered = [...filtered].sort((a, b) => {
      const liveDiff = Number(isLive(b)) - Number(isLive(a));
      if (liveDiff !== 0) return liveDiff;
      return Number(a.date || 0) - Number(b.date || 0);
    });

    return { metas: filtered.slice(0, 100).map((m) => toMetaPreview(m, sportsById)) };
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
 * Embed pages are exposed as addon-hosted HLS resolver URLs. The resolver
 * extracts the selected source's media playlist only when playback begins,
 * so Stremio receives a real video URL and keeps playback in its own player.
 */
async function streamHandler({ type, id, baseUrl = process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:7000' }) {
  try {
    if (type !== STREMIO_TYPE) return { streams: [] };
    const matchId = fromStremioId(id);
    if (!matchId) return { streams: [] };
    const match = await client.getMatchById(matchId);
    if (!match) return { streams: [] };

    const streams = await client.getStreamsForMatch(match);
    return {
      streams: streams.map((s) => {
        const quality = s.hd ? 'HD' : 'SD';
        const lang = s.language || 'Unknown';
        const source = String(s.source || 'unknown').toUpperCase();
        return {
          name: `Streamed ${quality}`,
          description: `${match.title}\n${lang} · ${quality} · Source ${source} · Stream ${s.streamNo || 1}`,
          url: playbackUrl(baseUrl, s.embedUrl),
          behaviorHints: {
            notWebReady: true,
            live: true,
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
