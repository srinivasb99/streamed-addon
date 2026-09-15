'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const { buildManifest } = require('../stremio/manifest');
const { catalogHandler, metaHandler, streamHandler } = require('../stremio/handlers');
const client = require('../providers/streamed/client');

/** "genre=football&search=x" -> { genre: 'football', search: 'x' } */
function parseExtra(extraStr) {
  const out = {};
  for (const part of String(extraStr || '').split('&')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    try {
      out[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1));
    } catch {
      // Skip malformed segments.
    }
  }
  return out;
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
  app.get('/stream/:type/:id.json', (req, res) =>
    streamHandler({ type: req.params.type, id: req.params.id }).then((r) => res.json(r))
  );

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
      const { toMetaPreview } = require('../stremio/handlers');
      const sports = await client.getSports().catch(() => []);
      const sportsById = Object.fromEntries(sports.map((s) => [s.id, s.name]));
      const matches = await client.getMatches('live');
      res.json({ metas: matches.slice(0, 24).map((m) => toMetaPreview(m, sportsById)) });
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
