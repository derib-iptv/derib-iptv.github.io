// build.js
// Generates a STATIC Stremio addon (also installable in Nuvio) from the public
// iptv-org API. Output is written to ./public, which you host on GitHub Pages.
//
// Stremio resolves every resource path RELATIVE to the manifest URL, so the
// output works no matter what username/repo you host it under — no base URL needed.
//
// Requires Node 18+ (uses global fetch).  Run: node build.js

const fs = require('fs');
const path = require('path');

const API = 'https://iptv-org.github.io/api';
const OUT = path.join(__dirname, 'public');
const ID_PREFIX = 'iptv-';

async function getJSON(name) {
  const res = await fetch(`${API}/${name}`);
  if (!res.ok) throw new Error(`Failed to fetch ${name}: ${res.status}`);
  return res.json();
}

// Channel ids look like "AnhuiTV.cn"; keep them filename/URL safe.
function safeId(id) {
  return String(id).replace(/[^A-Za-z0-9.\-]/g, '_');
}

function writeJSON(relPath, data) {
  const full = path.join(OUT, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(data));
}

async function main() {
  console.log('Downloading iptv-org data…');
  const [channels, streams, logos, categories] = await Promise.all([
    getJSON('channels.json'),
    getJSON('streams.json'),
    getJSON('logos.json'),
    getJSON('categories.json'),
  ]);

  // channelId -> [streams]
  const streamsByChannel = new Map();
  for (const s of streams) {
    if (!s.channel || !s.url) continue;            // skip unmatched / empty
    if (!streamsByChannel.has(s.channel)) streamsByChannel.set(s.channel, []);
    streamsByChannel.get(s.channel).push(s);
  }

  // channelId -> first logo url
  const logoByChannel = new Map();
  for (const l of logos) {
    if (l.channel && l.url && !logoByChannel.has(l.channel)) {
      logoByChannel.set(l.channel, l.url);
    }
  }

  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  // Keep only channels that have at least one stream and aren't NSFW or closed.
  const live = channels.filter(
    (c) => streamsByChannel.has(c.id) && !c.is_nsfw && !c.closed
  );
  console.log(`${live.length} channels with playable streams`);

  const byCategory = new Map(); // categoryId -> [metaPreview]

  for (const c of live) {
    const logo = logoByChannel.get(c.id) || null;
    const stremioId = ID_PREFIX + safeId(c.id);
    const genres = (c.categories || []).map((id) => categoryName.get(id) || id);

    const metaPreview = {
      id: stremioId,
      type: 'tv',
      name: c.name,
      poster: logo,
      posterShape: 'square',
      logo,
    };

    // ---- meta/tv/<id>.json ----
    writeJSON(`meta/tv/${stremioId}.json`, {
      meta: { ...metaPreview, background: logo, genres, country: c.country },
    });

    // ---- stream/tv/<id>.json ----
    const channelStreams = streamsByChannel.get(c.id).map((s) => {
      const headers = {};
      if (s.referrer) headers.Referer = s.referrer;
      if (s.user_agent) headers['User-Agent'] = s.user_agent;

      const stream = {
        name: 'IPTV-org',
        title: s.quality ? `${c.name} • ${s.quality}` : c.name,
        url: s.url,
        // Live HLS is rarely "web ready"; many streams also need original headers.
        behaviorHints: { notWebReady: true },
      };
      if (Object.keys(headers).length) {
        stream.behaviorHints.proxyHeaders = { request: headers };
      }
      return stream;
    });
    writeJSON(`stream/tv/${stremioId}.json`, { streams: channelStreams });

    // group for catalogs
    const cats = c.categories && c.categories.length ? c.categories : ['general'];
    for (const cat of cats) {
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(metaPreview);
    }
  }

  // ---- One catalog per category (robust on static hosting: no spaces/encoding in paths) ----
  const catalogDefs = [];
  const sortedCats = [...byCategory.keys()].sort((a, b) =>
    (categoryName.get(a) || a).localeCompare(categoryName.get(b) || b)
  );
  for (const cat of sortedCats) {
    const catalogId = 'iptv-' + safeId(cat);
    writeJSON(`catalog/tv/${catalogId}.json`, { metas: byCategory.get(cat) });
    catalogDefs.push({
      type: 'tv',
      id: catalogId,
      name: `IPTV · ${categoryName.get(cat) || cat}`,
    });
  }

  // ---- manifest.json ----
  writeJSON('manifest.json', {
    id: 'org.iptvorg.static',
    version: '1.0.0',
    name: 'IPTV-org',
    description:
      'Free-to-air channels indexed by the public iptv-org project. Streams are served by their original broadcasters.',
    logo: 'https://iptv-org.github.io/logo.png',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    idPrefixes: [ID_PREFIX],
    catalogs: catalogDefs,
    behaviorHints: { configurable: false },
  });

  console.log(`Done. ${catalogDefs.length} catalogs written to ./public`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
