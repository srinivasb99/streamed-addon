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

## Honest limitation

Streamed provides **browser embed pages** (`embed.st`), not direct video
files. Each Stremio stream entry therefore sets both `url` and `externalUrl`
to the embed page with `behaviorHints.notWebReady: true` — exactly what the
[Stremio stream docs](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/stream.md)
prescribe for URLs "which should be opened in a browser". In Stremio clients
these play via *open externally* / the web player, not as native direct streams.

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
| `GET /catalog/tv/streamed_live.json` | Currently live matches |
| `GET /catalog/tv/streamed_today.json` | Matches scheduled today |
| `GET /catalog/tv/streamed_popular.json` | All matches, popular first |
| `GET /catalog/tv/streamed_by_sport.json` | Today's matches, all sports |
| `GET /catalog/tv/streamed_by_sport/genre%3Dfootball.json` | Matches for one sport |
| `GET /meta/tv/:id.json` | Match details (`:id` = `strmd_<matchId>`) |
| `GET /stream/tv/:id.json` | Sorted streams for a match |
| `GET /api/sports` | Sport list (powers the landing-page filter) |
| `GET /api/preview/live` | Live matches as meta previews (landing page) |
| `GET /health` | Health check (also the Render health check path) |

## Project layout

- `src/app/` — Express entry point (`npm start`)
- `src/stremio/manifest.js` — manifest
- `src/stremio/handlers.js` — catalog/meta/stream handlers + Stremio mapping
- `src/providers/streamed/client.js` — Streamed API client, TTL caching, stream sorting
- `views/public/` — landing page (`index.html`, `styles.css`, `app.js`)
- `views/assets/` — addon icon
- `test/` — offline unit tests (`npm test`)
