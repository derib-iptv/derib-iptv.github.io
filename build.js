// build.js
// Generates a STATIC Stremio addon (also installable in Nuvio) from the public
// iptv-org API. Output is written to ./public, which you host on GitHub Pages.
//
// Requires Node 18+ (uses global fetch).  Run: node build.js
//
// Env overrides:
//   COUNTRIES=PK,US,GB        which countries to include
//   MAX_CHANNELS=3000         cap total channels
//   CHECK_STREAMS=0           skip the live dead-stream test (much faster build)
//   CHECK_TIMEOUT_MS=8000     per-stream timeout
//   CHECK_CONCURRENCY=40      how many streams to test at once

const fs = require('fs');
const path = require('path');

const API = 'https://iptv-org.github.io/api';
const OUT = path.join(__dirname, 'public');
const ID_PREFIX = 'iptv-';

// US, Canada, UK, Australia, New Zealand, Pakistan, India, UAE
const DEFAULT_COUNTRIES = ['US', 'CA', 'GB', 'AU', 'NZ', 'PK', 'IN', 'AE'];

// Hide channels from certain countries within certain categories only.
const HIDE_IN_CATEGORY = {
  news: ['IN'],   // drop Indian channels from the News row, keep them elsewhere
};

const COUNTRIES = (process.env.COUNTRIES
  ? process.env.COUNTRIES.split(',')
  : DEFAULT_COUNTRIES
).map((s) => s.trim().toUpperCase()).filter(Boolean);
const MAX_CHANNELS = parseInt(process.env.MAX_CHANNELS || '5000', 10);

const CHECK_STREAMS = process.env.CHECK_STREAMS !== '0';        // on by default
const CHECK_TIMEOUT_MS = parseInt(process.env.CHECK_TIMEOUT_MS || '8000', 10);
const CHECK_CONCURRENCY = parseInt(process.env.CHECK_CONCURRENCY || '40', 10);

let fileCount = 0;

async function getJSON(name) {
  const res = await fetch(`${API}/${name}`);
  if (!res.ok) throw new Error(`Failed to fetch ${name}: ${res.status}`);
  return res.json();
}

function safeId(id) {
  return String(id).replace(/[^A-Za-z0-9.\-]/g, '_');
}

function writeJSON(relPath, data) {
  const full = path.join(OUT, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(data));
  fileCount++;
}

// Probe a single stream URL. Returns true if it responds with a usable playlist.
async function isStreamAlive(s) {
  const headers = { 'User-Agent': s.user_agent || 'VLC/3.0.20 LibVLC/3.0.20' };
  if (s.referrer) headers.Referer = s.referrer;
  try {
    const res = await fetch(s.url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!res.ok) { try { await res.body?.cancel(); } catch {} return false; }
    // For HLS, confirm the body is actually a playlist, not an error page.
    if (/\.m3u8(\?|$)/i.test(s.url)) {
      const text = await res.text();
      return /#EXTM3U/.test(text);
    }
    try { await res.body?.cancel(); } catch {}
    return true;
  } catch {
    return false;
  }
}

// Simple concurrency-limited map.
async function pMap(items, fn, concurrency) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, worker));
  return results;
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  console.log('Downloading iptv-org data…');
  const [channels, streams, logos, categories] = await Promise.all([
    getJSON('channels.json'),
    getJSON('streams.json'),
    getJSON('logos.json'),
    getJSON('categories.json'),
  ]);

  const streamsByChannel = new Map();
  for (const s of streams) {
    if (!s.channel || !s.url) continue;
    if (!streamsByChannel.has(s.channel)) streamsByChannel.set(s.channel, []);
    streamsByChannel.get(s.channel).push(s);
  }

  const logoByChannel = new Map();
  for (const l of logos) {
    if (l.channel && l.url && !logoByChannel.has(l.channel)) {
      logoByChannel.set(l.channel, l.url);
    }
  }

  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  let selected = channels.filter(
    (c) => streamsByChannel.has(c.id) && !c.is_nsfw && !c.closed
  );
  console.log(`${selected.length} channels have streams listed`);

  if (COUNTRIES.length) {
    selected = selected.filter((c) => COUNTRIES.includes((c.country || '').toUpperCase()));
    console.log(`${selected.length} after country filter (${COUNTRIES.join(', ')})`);
  }

  selected.sort((a, b) => a.name.localeCompare(b.name));
  if (MAX_CHANNELS > 0 && selected.length > MAX_CHANNELS) {
    selected = selected.slice(0, MAX_CHANNELS);
    console.log(`capped to ${selected.length} channels (MAX_CHANNELS=${MAX_CHANNELS})`);
  }

  // Keep only the streams that actually respond. Channels with none survive get dropped.
  const liveStreamsByChannel = new Map();
  if (CHECK_STREAMS) {
    console.log(`Testing streams for ${selected.length} channels (timeout ${CHECK_TIMEOUT_MS}ms, concurrency ${CHECK_CONCURRENCY})…`);
    let tested = 0;
    const checked = await pMap(selected, async (c) => {
      const candidates = streamsByChannel.get(c.id) || [];
      const alive = [];
      for (const s of candidates) {
        if (await isStreamAlive(s)) alive.push(s);
      }
      if (++tested % 200 === 0) console.log(`  …tested ${tested}/${selected.length}`);
      if (alive.length) { liveStreamsByChannel.set(c.id, alive); return c; }
      return null;
    }, CHECK_CONCURRENCY);
    const before = selected.length;
    selected = checked.filter(Boolean);
    console.log(`Stream check: kept ${selected.length}, dropped ${before - selected.length} dead channels`);
  } else {
    for (const c of selected) liveStreamsByChannel.set(c.id, streamsByChannel.get(c.id) || []);
  }

  const byCategory = new Map();
  let hiddenSkipped = 0;

  for (const c of selected) {
    const country = (c.country || '').toUpperCase();
    const rawCats = c.categories && c.categories.length ? c.categories : ['general'];
    const cats = rawCats.filter((cat) => {
      const hidden = HIDE_IN_CATEGORY[cat];
      return !(hidden && hidden.includes(country));
    });
    if (cats.length === 0) { hiddenSkipped++; continue; }

    const logo = logoByChannel.get(c.id) || null;
    const stremioId = ID_PREFIX + safeId(c.id);
    const genres = cats.map((id) => categoryName.get(id) || id);

    const metaPreview = {
      id: stremioId, type: 'tv', name: c.name,
      poster: logo, posterShape: 'square', logo,
    };

    writeJSON(`meta/tv/${stremioId}.json`, {
      meta: { ...metaPreview, background: logo, genres, country: c.country },
    });

    const channelStreams = (liveStreamsByChannel.get(c.id) || []).map((s) => {
      const headers = {};
      if (s.referrer) headers.Referer = s.referrer;
      if (s.user_agent) headers['User-Agent'] = s.user_agent;
      const stream = {
        name: 'IPTV-org',
        title: s.quality ? `${c.name} • ${s.quality}` : c.name,
        url: s.url,
        behaviorHints: { notWebReady: true },
      };
      if (Object.keys(headers).length) stream.behaviorHints.proxyHeaders = { request: headers };
      return stream;
    });
    writeJSON(`stream/tv/${stremioId}.json`, { streams: channelStreams });

    for (const cat of cats) {
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(metaPreview);
    }
  }

  if (hiddenSkipped) console.log(`skipped ${hiddenSkipped} channels (hidden category only, e.g. Indian news)`);

  const catalogDefs = [];
  const sortedCats = [...byCategory.keys()].sort((a, b) =>
    (categoryName.get(a) || a).localeCompare(categoryName.get(b) || b)
  );
  for (const cat of sortedCats) {
    const catalogId = 'iptv-' + safeId(cat);
    writeJSON(`catalog/tv/${catalogId}.json`, { metas: byCategory.get(cat) });
    catalogDefs.push({ type: 'tv', id: catalogId, name: `IPTV · ${categoryName.get(cat) || cat}` });
  }

  writeJSON('manifest.json', {
    id: 'org.iptvorg.static',
    version: '1.0.0',
    name: 'IPTV-org',
    description: 'Free-to-air channels indexed by the public iptv-org project.',
    logo: 'https://iptv-org.github.io/logo.png',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    idPrefixes: [ID_PREFIX],
    catalogs: catalogDefs,
    behaviorHints: { configurable: false },
  });

  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

  console.log(`Done. ${selected.length - hiddenSkipped} channels, ${byCategory.size} catalogs, ${fileCount} files written to ./public`);
  if (fileCount > 6000) {
    console.warn(`WARNING: ${fileCount} files may be too many for GitHub Pages. Lower MAX_CHANNELS.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
