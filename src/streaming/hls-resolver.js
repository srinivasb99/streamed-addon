'use strict';

const fs = require('fs');
const { chromium } = require('playwright-core');

const EMBED_HOSTS = new Set(['embed.st']);
const STREAM_HOST_PATTERN = /(^|\.)strmd\.st$/i;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
const SESSION_TTL_MS = 12 * 60 * 1000;
const MAX_SESSIONS = 4;

const sessions = new Map();
const pendingSessions = new Map();
let browserPromise;

function encodeEmbedUrl(embedUrl) {
  return Buffer.from(String(embedUrl), 'utf8').toString('base64url');
}

function decodeEmbedUrl(token) {
  if (!token || String(token).length > 4096) return null;
  try {
    const value = Buffer.from(String(token), 'base64url').toString('utf8');
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || !EMBED_HOSTS.has(parsed.hostname)) return null;
    if (!parsed.pathname.startsWith('/embed/')) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function playbackUrl(baseUrl, embedUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return `${base}/play/${encodeEmbedUrl(embedUrl)}.m3u8`;
}

function browserExecutablePath() {
  const configured = process.env.CHROMIUM_EXECUTABLE_PATH;
  const candidates = [
    configured,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function getBrowser() {
  if (!browserPromise) {
    const executablePath = browserExecutablePath();
    if (!executablePath) {
      throw new Error('Chromium executable not found');
    }
    browserPromise = chromium
      .launch({
        headless: true,
        executablePath,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-extensions',
          '--disable-sync',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-first-run',
          '--autoplay-policy=no-user-gesture-required',
        ],
      })
      .then((browser) => {
        browser.on('disconnected', () => {
          browserPromise = undefined;
          sessions.clear();
        });
        return browser;
      })
      .catch((error) => {
        browserPromise = undefined;
        throw error;
      });
  }
  return browserPromise;
}

async function closeSession(session) {
  if (!session) return;
  try {
    await session.context.close();
  } catch {
    // The browser may already have closed.
  }
}

async function evictExpiredSessions() {
  const now = Date.now();
  const expired = [...sessions.entries()].filter(([, session]) => session.expiresAt <= now);
  for (const [key, session] of expired) {
    sessions.delete(key);
    await closeSession(session);
  }

  while (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
    if (!oldest) break;
    sessions.delete(oldest[0]);
    await closeSession(oldest[1]);
  }
}

async function resolveSession(embedUrl) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1366, height: 768 },
    ignoreHTTPSErrors: true,
    locale: 'en-US',
  });
  const page = await context.newPage();
  const state = { resolved: false };

  await page.route('**/*', async (route) => {
    const request = route.request();
    const type = request.resourceType();
    const url = request.url();
    if (['image', 'stylesheet', 'font'].includes(type)) return route.abort();
    if (state.resolved && (type === 'media' || /\.(?:ts|m4s)(?:\?|$)/i.test(url))) {
      return route.abort();
    }
    return route.continue();
  });

  let manifestUrl = null;
  page.on('response', (response) => {
    if (!manifestUrl && response.status() === 200 && /\.m3u8(?:\?|$)/i.test(response.url())) {
      manifestUrl = response.url();
    }
  });

  try {
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    for (let attempt = 0; attempt < 12 && !manifestUrl; attempt += 1) {
      try {
        await page.mouse.click(683, 384);
        await page.evaluate(() => {
          for (const video of document.querySelectorAll('video')) {
            video.muted = true;
            const play = video.play();
            if (play && typeof play.catch === 'function') play.catch(() => {});
          }
        });
      } catch {
        // Some players begin automatically and do not expose clickable controls.
      }
      await page.waitForTimeout(500);
    }

    if (!manifestUrl) throw new Error('No playable HLS request was detected');
    state.resolved = true;
    await page
      .evaluate(() => {
        for (const video of document.querySelectorAll('video')) video.pause();
      })
      .catch(() => {});

    return {
      context,
      page,
      embedUrl,
      manifestUrl,
      expiresAt: Date.now() + SESSION_TTL_MS,
      lastUsedAt: Date.now(),
    };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

async function getSession(embedUrl, forceRefresh = false) {
  await evictExpiredSessions();
  if (!forceRefresh) {
    const existing = sessions.get(embedUrl);
    if (existing) {
      existing.lastUsedAt = Date.now();
      existing.expiresAt = Date.now() + SESSION_TTL_MS;
      return existing;
    }
    if (pendingSessions.has(embedUrl)) return pendingSessions.get(embedUrl);
  } else {
    const existing = sessions.get(embedUrl);
    sessions.delete(embedUrl);
    await closeSession(existing);
  }

  const pending = resolveSession(embedUrl)
    .then((session) => {
      sessions.set(embedUrl, session);
      return session;
    })
    .finally(() => pendingSessions.delete(embedUrl));
  pendingSessions.set(embedUrl, pending);
  return pending;
}

function validateManifestUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && STREAM_HOST_PATTERN.test(parsed.hostname) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function encodeManifestUrl(url) {
  return Buffer.from(String(url), 'utf8').toString('base64url');
}

function decodeManifestUrl(value) {
  if (!value || String(value).length > 8192) return null;
  try {
    return validateManifestUrl(Buffer.from(String(value), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function rewriteManifest(body, upstreamUrl, playbackPath) {
  return String(body)
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (!trimmed.startsWith('#')) {
        const absolute = new URL(trimmed, upstreamUrl).toString();
        if (/\.m3u8(?:\?|$)/i.test(absolute)) {
          return `${playbackPath}?manifest=${encodeURIComponent(encodeManifestUrl(absolute))}`;
        }
        return absolute;
      }

      return line.replace(/URI="([^"]+)"/g, (match, uri) => {
        try {
          return `URI="${new URL(uri, upstreamUrl).toString()}"`;
        } catch {
          return match;
        }
      });
    })
    .join('\n');
}

async function fetchThroughPage(page, targetUrl) {
  return page.evaluate(async (url) => {
    const response = await fetch(url, { cache: 'no-store', credentials: 'omit' });
    return {
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      body: await response.text(),
    };
  }, targetUrl);
}

async function getPlayableManifest(embedUrl, requestedManifestUrl, playbackPath) {
  let session = await getSession(embedUrl);
  let targetUrl = requestedManifestUrl || session.manifestUrl;
  if (!validateManifestUrl(targetUrl)) throw new Error('Invalid stream manifest URL');

  let response = await fetchThroughPage(session.page, targetUrl);
  if ([401, 403, 404].includes(response.status)) {
    session = await getSession(embedUrl, true);
    targetUrl = requestedManifestUrl ? validateManifestUrl(requestedManifestUrl) : session.manifestUrl;
    response = await fetchThroughPage(session.page, targetUrl);
  }
  if (response.status < 200 || response.status >= 300 || !response.body.includes('#EXTM3U')) {
    throw new Error(`HLS manifest returned HTTP ${response.status}`);
  }

  session.lastUsedAt = Date.now();
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return rewriteManifest(response.body, targetUrl, playbackPath);
}

async function closeAll() {
  const current = [...sessions.values()];
  sessions.clear();
  await Promise.all(current.map(closeSession));
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    browserPromise = undefined;
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = {
  decodeEmbedUrl,
  decodeManifestUrl,
  encodeEmbedUrl,
  encodeManifestUrl,
  getPlayableManifest,
  playbackUrl,
  rewriteManifest,
  closeAll,
};
