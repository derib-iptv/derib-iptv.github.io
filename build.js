// build.js
// Generates a STATIC Stremio addon (also installable in Nuvio) from the public
// iptv-org API. Output is written to ./public, which you host on GitHub Pages.
//
// Requires Node 18+ (uses global fetch).  Run: node build.js
//
// To change which countries appear, edit DEFAULT_COUNTRIES below
// (ISO 3166-1 alpha-2 codes), or override at runtime with env vars:
//   COUNTRIES=PK,US,GB   MAX_CHANNELS=3000   node build.js

const fs = require('fs');
const path = require('path');

const API = 'https://iptv-org.github.io/api';
const OUT = path.join(__dirname, 'public');
const ID_PREFIX = 'iptv-';

// US, Canada, UK, Australia, New Zealand, Pakistan, India, UAE
const DEFAULT_COUNTRIES = ['US', 'CA', 'GB', 'AU', 'NZ', 'PK', 'IN', 'AE'];

// Hide channels from certain countries within certain categories only.
// Below: drop Indian channels from the News row, but keep them everywhere else.
// A channel that exists ONLY in a hidden category is skipped entirely.
const HIDE_IN_CATEGORY = {
  news: ['IN'],   // category id -> country codes to exclude from that category
};

const COUNTRIES = (process.env.COUNTRIES
  ? process.env.COUNTRIES.split(',')
  : DEFAULT_COUNTRIES
).map((s) => s.trim().toUpperCase()).filter(Boolean);
const MAX_CHANNELS = parseInt(process.env.MAX_CHANNELS || '20000', 10);

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

async function main() {
  // Start clean so removed channels don't linger between builds.
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
  console.log(`${selected.length} channels have playable streams`);

  if (COUNTRIES.length) {
    selected = selected.filter((c) => COUNTRIES.includes((c.country || '').toUpperCase()));
    console.log(`${selected.length} after country filter (${COUNTRIES.join(', ')})`);
  }

  selected.sort((a, b) => a.name.localeCompare(b.name));
  if (MAX_CHANNELS > 0 && selected.length > MAX_CHANNELS) {
    selected = selected.slice(0, MAX_CHANNELS);
    console.log(`capped to ${selected.length} channels (MAX_CHANNELS=${MAX_CHANNELS})`);
  }

  const byCategory = new Map();
  let skipped = 0;

  for (const c of selected) {
    const country = (c.country || '').toUpperCase();
    const rawCats = c.categories && c.categories.length ? c.categories : ['general'];

    // Remove any categories where this country is hidden (e.g. IN in news).
    const cats = rawCats.filter((cat) => {
      const hidden = HIDE_IN_CATEGORY[cat];
      return !(hidden && hidden.includes(country));
    });

    // If the channel only existed in hidden categories, skip it entirely.
    if (cats.length === 0) { skipped++; continue; }

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

    const channelStreams = streamsByChannel.get(c.id).map((s) => {
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

  if (skipped) console.log(`skipped ${skipped} channels (hidden category only, e.g. Indian news)`);

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

  // Critical: stop GitHub Pages from running the tree through Jekyll.
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

  console.log(`Done. ${byCategory.size} catalogs, ${fileCount} files written to ./public`);
  if (fileCount > 6000) {
    console.warn(`WARNING: ${fileCount} files may be too many for GitHub Pages. Lower MAX_CHANNELS.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
