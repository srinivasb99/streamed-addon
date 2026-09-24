# Streamed Addon for Stremio

Live sports in Stremio, powered by the free [Streamed API](https://streamed.pk/docs)
(`streamed.pk` — no account, no token required). Plain Express server
following the [Stremio addon protocol](https://github.com/Stremio/stremio-addon-sdk/tree/master/docs),
with a FebBox-style landing page (brand header, live preview grid, install box,
light/dark mode).

## What it does

- **Catalogs** (type `tv`): Live Now, Today, Popular, and By Sport (via `genre`).
  Each match appears as a playable channel with poster, teams and kickoff time.
- **Meta**: match details for every catalog item.
- **Streams**: aggregates **every source** of a match (`alpha` … `intel`, plus
  undocumented ones like `admin`), then sorts best-first:
  1. HD before SD
  2. English before other languages
  3. Preferred source order
  4. Lowest stream number

Matches use Stremio's one-video `tv` model: the stream request uses the match
meta ID (`strmd2_<matchId>`). The handler also accepts the legacy `strmd_` prefix and `:play` suffix
so existing installations can migrate without breaking.

## Playback compatibility

Streamed provides **browser embed pages** (`embed.st`), not direct video
files. The addon resolves the embed to an HLS playlist at playback time and
serves the playlist, nested playlists, encryption keys, and media segments
through its own HTTPS origin. This keeps the HLS request tree CORS-readable
for Stremio Web and passes byte-range requests through for native desktop
players. The stream response uses Stremio's `url` field for the addon-hosted
HLS endpoint; the embed page itself is not returned as a direct video URL.

## Run it

```bash
npm install
cp .env.example .env   # optional; defaults to https://streamed.pk
npm start              # serves on PORT (default 7000)
```

Install in Stremio: open `http://<host>:7000` and click **Install**, or add
`http://<host>:7000/manifest.json` via Addons → paste URL → Install.
(Remote URLs need HTTPS — see the [SDK docs](https://github.com/Stremio/stremio-addon-sdk).)

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /` | Landing page: live preview + install box |
| `GET /manifest.json` | Stremio manifest |
| `GET /catalog/tv/streamed_live_v2.json` | Currently live matches |
| `GET /catalog/tv/streamed_today_v2.json` | Matches scheduled today |
| `GET /catalog/tv/streamed_popular_v2.json` | All matches, popular first |
| `GET /catalog/tv/streamed_sport_football_v2.json` | Football matches |
| `GET /catalog/tv/streamed_sport_american-football_v2.json` | American Football matches |
| `GET /catalog/tv/streamed_sport_tennis_v2.json` | Tennis matches |
| `GET /meta/tv/:id.json` | Match details (`:id` = `strmd2_<matchId>`) |
| `GET /stream/tv/:id.json` | Sorted streams for a match |
| `GET /play/:token.m3u8` | Resolved HLS playlist for playback |
| `GET /resource/:token` | Proxied HLS keys and media segments |
| `GET /api/sports` | Sport list (powers the landing-page filter) |
| `GET /api/preview/live` | Live matches as meta previews (landing page) |
| `GET /api/preview/today` | All matches scheduled today as meta previews (landing page) |
| `GET /health` | Health check (also the Render health check path) |

The manifest exposes first-class catalogs for every sport so Stremio’s catalog selector can filter directly by Football, American Football, Tennis, and the other supported categories. Search is advertised for each catalog, and `skip` is honored for catalog pagination. The legacy `streamed_by_sport_v2` endpoint remains accepted for existing installs.

## Project layout

- `src/app/` — Express entry point (`npm start`)
- `src/stremio/manifest.js` — manifest
- `src/stremio/handlers.js` — catalog/meta/stream handlers + Stremio mapping
- `src/providers/streamed/client.js` — Streamed API client, TTL caching, stream sorting
- `views/public/` — landing page (`index.html`, `styles.css`, `app.js`)
- `views/assets/` — addon icon
- `test/` — offline unit tests (`npm test`)
