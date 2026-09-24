'use strict';

require('dotenv').config();
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const express = require('express');
const cors = require('cors');

const { buildManifest } = require('../stremio/manifest');
const { catalogHandler, isLive, metaHandler, streamHandler, toMetaPreview } = require('../stremio/handlers');
const client = require('../providers/streamed/client');
const {
  decodeEmbedUrl,
  decodeManifestUrl,
  fetchStreamedResource,
  getPlayableManifest,
} = require('../streaming/hls-resolver');

/** "genre=football&search=x" -> { genre: 'football', search: 'x' } */
function parseExtra(extraStr) {
  return Object.fromEntries(new URLSearchParams(String(extraStr || '')));
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Stremio's addon client/proxy does not reliably reuse a cached JSON body
  // after a conditional request. Express would otherwise turn these protocol
  // responses into 304s, which makes valid catalog/meta data appear empty in
  // the Stremio UI. Keep addon protocol responses explicit 200 JSON responses;
  // upstream API data is already cached by the provider client.
  app.disable('etag');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10kb' }));
  app.use(cors({ origin: true, credentials: false, methods: ['GET', 'OPTIONS'] }));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // Addon protocol payloads are dynamic and Stremio already maintains its own
  // addon cache. Prevent an intermediary or the desktop proxy from preserving
  // an earlier empty catalog/meta response.
  app.use(['/manifest.json', '/catalog', '/meta', '/stream'], (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  });

  // Minimal request log — path/method/status/duration only, no query/headers.
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      console.log(
        JSON.stringify({
          msg: 'request',
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Date.now() - start,
        })
      );
    });
    next();
  });

  const startedAt = Date.now();
  app.get('/health', (req, res) =>
    res.json({ ok: true, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) })
  );

  // Landing page assets + app (FebBox-style config UI, static files).
  app.use('/assets', express.static(path.join(__dirname, '..', '..', 'views', 'assets'), { maxAge: '1d' }));
  // The landing page contains the current manifest origin and install
  // instructions; do not let browsers hold an outdated deployment notice.
  app.use(express.static(path.join(__dirname, '..', '..', 'views', 'public'), { maxAge: 0 }));

  // Stremio addon protocol endpoints (same handlers the SDK version used).
  app.get('/manifest.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.json(buildManifest(`${req.protocol}://${req.get('host')}`));
  });
  app.get('/catalog/:type/:id/:extra.json', (req, res) =>
    catalogHandler({ type: req.params.type, id: req.params.id, extra: parseExtra(req.params.extra) }).then((r) =>
      res.json(r)
    )
  );
  app.get('/catalog/:type/:id.json', (req, res) =>
    catalogHandler({ type: req.params.type, id: req.params.id, extra: {} }).then((r) => res.json(r))
  );
  app.get('/meta/:type/:id.json', (req, res) =>
    metaHandler({ type: req.params.type, id: req.params.id }).then((r) => res.json(r))
  );
  app.get('/stream/:type/:id.json', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    return streamHandler({ type: req.params.type, id: req.params.id, baseUrl }).then((r) => res.json(r));
  });

  // HLS.js in Stremio Web needs every playlist, key, and media segment to be
  // same-origin/CORS-readable. Native desktop clients use this same route, and
  // Range requests are passed through for efficient media delivery.
  app.get('/resource/:token', async (req, res) => {
    const resourceUrl = decodeManifestUrl(req.params.token);
    if (!resourceUrl) return res.status(400).type('text/plain').send('Invalid HLS resource URL');

    try {
      const upstream = await fetchStreamedResource(resourceUrl, {
        method: req.method,
        range: req.get('range'),
      });
      res.status(upstream.status);
      for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const value = upstream.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'HEAD' || !upstream.body) return res.end();
      await pipeline(Readable.fromWeb(upstream.body), res);
    } catch (error) {
      if (!res.headersSent) {
        res.status(502).type('text/plain').send('HLS resource could not be loaded');
      } else {
        res.destroy(error);
      }
    }
  });

  // Stremio requests this URL as media. Resolve the protected embed lazily and
  // proxy its HLS playlists while preserving the original CDN host as origin.
  app.get('/play/:token.m3u8', async (req, res) => {
    const embedUrl = decodeEmbedUrl(req.params.token);
    if (!embedUrl) return res.status(400).type('text/plain').send('Invalid playback URL');

    // Stremio Web probes stream URLs with HEAD before handing them to Hls.js.
    // Do not launch the Chromium resolver for that probe; the URL is our own
    // HTTPS HLS endpoint and its content type is known up front.
    if (req.method === 'HEAD') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.status(200).end();
    }

    const requestedManifest = req.query.manifest ? decodeManifestUrl(req.query.manifest) : null;
    if (req.query.manifest && !requestedManifest) {
      return res.status(400).type('text/plain').send('Invalid manifest URL');
    }

    try {
      const playbackPath = `${req.protocol}://${req.get('host')}${req.path}`;
      const manifest = await getPlayableManifest(embedUrl, requestedManifest, playbackPath);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.send(manifest);
    } catch (error) {
      console.error(
        JSON.stringify({ msg: 'hls_resolution_failed', path: req.path, error: String(error.message || error) })
      );
      return res.status(502).type('text/plain').send('Live stream could not be resolved');
    }
  });

  // Extra JSON APIs powering the landing page (live preview + sport chips).
  app.get('/api/sports', async (req, res) => {
    try {
      res.json(await client.getSports());
    } catch {
      res.status(502).json({ error: 'Could not reach the Streamed API.' });
    }
  });
  app.get('/api/preview/live', async (req, res) => {
    try {
      const sports = await client.getSports().catch(() => []);
      const sportsById = Object.fromEntries(sports.map((s) => [s.id, s.name]));
      const matches = await client.getMatches('live');
      res.json({
        metas: matches.slice(0, 24).map((m) => ({
          ...toMetaPreview(m, sportsById),
          isLive: isLive(m),
          startTime: Number(m.date),
        })),
      });
    } catch {
      res.status(502).json({ error: 'Could not reach the Streamed API.' });
    }
  });
  app.get('/api/preview/today', async (req, res) => {
    try {
      const sports = await client.getSports().catch(() => []);
      const sportsById = Object.fromEntries(sports.map((s) => [s.id, s.name]));
      const matches = await client.getMatches('all-today');
      res.json({
        metas: matches.map((m) => ({
          ...toMetaPreview(m, sportsById),
          isLive: isLive(m),
          startTime: Number(m.date),
        })),
      });
    } catch {
      res.status(502).json({ error: 'Could not reach the Streamed API.' });
    }
  });

  // Generic error handler: never leak stack traces.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(JSON.stringify({ msg: 'unhandled_error', path: req.path }));
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp, parseExtra };
