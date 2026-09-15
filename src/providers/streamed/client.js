'use strict';

/**
 * Minimal client for the Streamed REST API (https://streamed.pk/docs).
 *
 * - No authentication required.
 * - Endpoints used:
 *   - GET /api/sports
 *   - GET /api/matches/all | /api/matches/all-today | /api/matches/live
 *   - GET /api/matches/[SPORT]
 *   - GET /api/stream/[SOURCE]/[ID]   (source + id come from match.sources[])
 *   - Images: badge/proxy/poster paths are resolved to absolute URLs here.
 *
 * Caching is a small in-memory TTL map: match listings change often
 * (60s TTL), stream listings are a little more stable (5min TTL).
 */

const API_BASE = (process.env.STREAMED_API_BASE || 'https://streamed.pk').replace(/\/+$/, '');

const MATCHES_TTL_MS = 60 * 1000;
const STREAMS_TTL_MS = 5 * 60 * 1000;
const SPORTS_TTL_MS = 60 * 60 * 1000;

const cache = new Map(); // key -> { expires, value }

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key, value, ttlMs) {
  cache.set(key, { expires: Date.now() + ttlMs, value });
}

function clearCache() {
  cache.clear();
}

async function fetchJson(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'streamed-stremio-addon/1.0' },
  });
  if (!res.ok) {
    throw new Error(`Streamed API ${path} responded with HTTP ${res.status}`);
  }
  return res.json();
}

/** @returns {Promise<Array<{id:string,name:string}>>} */
async function getSports() {
  const cached = cacheGet('sports');
  if (cached) return cached;
  const sports = await fetchJson('/api/sports');
  const list = Array.isArray(sports) ? sports : [];
  cacheSet('sports', list, SPORTS_TTL_MS);
  return list;
}

/**
 * Fetch a match listing. `which` is one of: 'all', 'all-today', 'live',
 * or a sport id such as 'football'.
 */
async function getMatches(which) {
  const key = `matches:${which}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const matches = await fetchJson(`/api/matches/${encodeURIComponent(which)}`);
  const list = Array.isArray(matches) ? matches : [];
  cacheSet(key, list, MATCHES_TTL_MS);
  return list;
}

/**
 * Find a single match by its API id. There is no single-match endpoint,
 * so the cached full listing is searched first, then today's and live
 * listings as a fallback.
 * @returns {Promise<object|null>}
 */
async function getMatchById(matchId) {
  for (const which of ['all', 'all-today', 'live']) {
    try {
      const matches = await getMatches(which);
      const found = matches.find((m) => m && m.id === matchId);
      if (found) return found;
    } catch {
      // Try the next listing; a single upstream failure must not fail lookup.
    }
  }
  return null;
}

/**
 * Fetch raw stream entries for one match source.
 * Unknown sources (e.g. "admin") are attempted generically — the endpoint
 * shape is /api/stream/[SOURCE]/[ID] for every source.
 * @returns {Promise<Array>} never rejects; returns [] on failure.
 */
async function getSourceStreams(source, id) {
  const key = `stream:${source}:${id}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const path = `/api/stream/${encodeURIComponent(source)}/${encodeURIComponent(id)}`;
    const streams = await fetchJson(path);
    const list = Array.isArray(streams) ? streams : [];
    cacheSet(key, list, STREAMS_TTL_MS);
    return list;
  } catch {
    return [];
  }
}

/**
 * Preferred source order when quality/language are equal. Sources not
 * listed here keep their relative order after the known ones.
 */
const SOURCE_PRIORITY = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'intel'];

function sourceRank(source) {
  const idx = SOURCE_PRIORITY.indexOf(String(source || '').toLowerCase());
  return idx === -1 ? SOURCE_PRIORITY.length : idx;
}

function isEnglish(language) {
  return String(language || '').toLowerCase().startsWith('eng');
}

/**
 * Sort raw Streamed stream entries best-first:
 *   1. HD before SD
 *   2. English before other languages
 *   3. Preferred source order (alpha → intel, unknown last)
 *   4. Lower streamNo first
 * Entries without an embedUrl are dropped; duplicate embedUrls are removed.
 */
function sortStreams(streams) {
  const seen = new Set();
  return (Array.isArray(streams) ? streams : [])
    .filter((s) => s && typeof s.embedUrl === 'string' && s.embedUrl.length > 0)
    .filter((s) => {
      if (seen.has(s.embedUrl)) return false;
      seen.add(s.embedUrl);
      return true;
    })
    .sort((a, b) => {
      if (Boolean(a.hd) !== Boolean(b.hd)) return a.hd ? -1 : 1;
      const aEn = isEnglish(a.language);
      const bEn = isEnglish(b.language);
      if (aEn !== bEn) return aEn ? -1 : 1;
      const rank = sourceRank(a.source) - sourceRank(b.source);
      if (rank !== 0) return rank;
      return (a.streamNo || 0) - (b.streamNo || 0);
    });
}

/**
 * Aggregate + sort every source of a match into one best-first list.
 * Each returned entry keeps its original fields plus `_sourceId`
 * (the match-source id it came from, useful for display/debugging).
 */
async function getStreamsForMatch(match) {
  const sources = (match && Array.isArray(match.sources) ? match.sources : []).filter(
    (s) => s && s.source && s.id
  );
  const settled = await Promise.all(
    sources.map((s) => getSourceStreams(s.source, s.id))
  );
  const combined = [];
  settled.forEach((list, i) => {
    for (const entry of list) {
      combined.push({ ...entry, _sourceId: sources[i].id });
    }
  });
  return sortStreams(combined);
}

/**
 * Resolve an image reference from a match object to an absolute URL.
 * - badge ids ("GwZg7...")  -> /api/images/badge/[id].webp
 * - poster paths ("/api/images/proxy/....webp") -> as-is on the API host
 */
function imageUrl(ref) {
  if (!ref || typeof ref !== 'string') return null;
  if (ref.startsWith('http://') || ref.startsWith('https://')) return ref;
  if (ref.startsWith('/')) return `${API_BASE}${ref}`;
  return `${API_BASE}/api/images/badge/${ref}.webp`;
}

module.exports = {
  API_BASE,
  getSports,
  getMatches,
  getMatchById,
  getSourceStreams,
  getStreamsForMatch,
  sortStreams,
  imageUrl,
  clearCache,
};
