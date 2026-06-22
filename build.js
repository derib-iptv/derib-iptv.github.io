// build.js
// Generates a STATIC Stremio addon (also installable in Nuvio) from the public
// iptv-org API, merged with the curated Free-TV playlist for better reliability.
// Output is written to ./public, which you host on GitHub Pages.
//
// Requires Node 18+ (uses global fetch).  Run: node build.js
//
// Env overrides:
//   COUNTRIES=PK,US,GB        which countries to include
//   MAX_CHANNELS=3000         cap total channels
//   CHECK_STREAMS=0           skip the live dead-stream test (much faster build)
//   CHECK_TIMEOUT_MS=8000     per-stream timeout
//   CHECK_CONCURRENCY=40      how many streams to test at once
//   USE_FREETV=0              don't merge in the Free-TV playlist

const fs = require('fs');
const path = require('path');

const API = 'https://iptv-org.github.io/api';
const FREETV_URL = 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8';
const OUT = path.join(__dirname, 'public');
const ID_PREFIX = 'iptv-';

// US, Canada, UK, Australia, New Zealand, Pakistan, India, UAE
const DEFAULT_COUNTRIES = ['US', 'CA', 'GB', 'AU', 'NZ', 'PK', 'IN', 'AE'];

// These category rows show first, AND their channels survive the MAX_CHANNELS
// cap before anything else gets trimmed. Order here = order shown in the app.
const PRIORITY_CATEGORIES = ['sports', 'news', 'kids', 'animation', 'family'];

// Channels to ALWAYS include (bypass the cap), pin to the top, and surface in a
// dedicated "World Cup" row. Use exact iptv-org channel IDs — find one by
// searching the channel at https://iptv-org.github.io/ or in channels.json.
// The build logs which IDs it actually matched so you can correct any typos.
//
// Verified against iptv-org/database channels.csv + iptv-org/iptv streams/*.m3u
// on 2026-06-16. "has stream" = iptv-org currently lists a working stream URL
// for that id; "no stream" = the id is real but iptv-org has no free stream
// for it (usually because the broadcaster is pay-TV/cable-only). Entries with
// "no stream" are still listed below — the build log will report them as
// unmatched unless the Free-TV merge happens to supply one.
const FORCE_INCLUDE = new Set([
  // GB — BBC & ITV, shared rights deal. Both have working streams.
  'BBCOne.uk', 'BBCTwo.uk', 'ITV1.uk',

  // US — Fox/FS1 (English), Telemundo/Universo (Spanish).
  // 'FOX.us' is NOT a real iptv-org channel id (the Fox broadcast network has
  // no public stream listed at all) — using Fox Sports 1 instead, which does
  // have a stream. 'Telemundo.us' exists but has no stream entry; NBC
  // Universo does.
  'FoxSports1.us', 'NBCUniverso.us',

  // CA — TSN (Bell Media, English) / RDS (French) / CTV.
  // None of these ids currently have an iptv-org stream — TSN1-5.ca,
  // RDS.ca, RDS2.ca, RDSInfo.ca and CTV.ca are all cable/pay-only with
  // nothing in streams data. Kept so the build log flags them; if the
  // Free-TV merge ever supplies a feed for one, it'll start showing up.
  'CTV.ca', 'TSN1.ca', 'RDS.ca',

  // CA — CBC, English-language, both have working streams (unlike the
  // TSN/RDS/CTV ids above).
  'CBCTDT.ca', 'CBCNewsNetwork.ca',

  // AU — Optus Sport holds primary World Cup rights and is pay-only (no
  // free stream exists for it in iptv-org). SBS/Network 10 had some FTA
  // coverage historically, but as of 2026 none of SBS.au, SBSViceland.au,
  // or 10.au have a stream in iptv-org either.
  'SBS.au', 'SBSViceland.au', '10.au',

  // NZ — Sky Sport (Sky New Zealand), pay-only. No free iptv-org stream
  // for SkySport.nz / SkySport1-9.nz / SkySportPremierLeague.nz etc.
  'SkySport1.nz',

  // PK — PTV Sports, free-to-air state broadcaster. Has a working stream.
  'PTVSports.pk',

  // IN — Sony Sports Network (Sony Ten 1-4). All four have working streams
  // (Ten5 does not).
  'SonySportsTen1.in', 'SonySportsTen2.in', 'SonySportsTen3Hindi.in', 'SonySportsTen4.in',

  // AE/MENA — beIN Sports, pay-only. No free iptv-org stream under either
  // .qa (where beIN channels are registered) or .ae.
  'beINSports1.qa',
]);
const isForced = (c) => FORCE_INCLUDE.has(c.id);

// Hide channels from certain countries within certain categories only.
const HIDE_IN_CATEGORY = {
  news: ['IN'],   // drop Indian channels from the News row, keep them elsewhere
};

const COUNTRIES = (process.env.COUNTRIES
  ? process.env.COUNTRIES.split(',')
  : DEFAULT_COUNTRIES
).map((s) => s.trim().toUpperCase()).filter(Boolean);
const MAX_CHANNELS = parseInt(process.env.MAX_CHANNELS || '5000', 10);

const CHECK_STREAMS = process.env.CHECK_STREAMS !== '0';
const CHECK_TIMEOUT_MS = parseInt(process.env.CHECK_TIMEOUT_MS || '8000', 10);
const CHECK_CONCURRENCY = parseInt(process.env.CHECK_CONCURRENCY || '40', 10);
const USE_FREETV = process.env.USE_FREETV !== '0';

const isPriority = (c) => (c.categories || []).some((cat) => PRIORITY_CATEGORIES.includes(cat));

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

// --- Free-TV M3U parsing ---
function parseM3U(text) {
  const out = [];
  let pending = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attr = (k) => { const m = line.match(new RegExp(k + '="([^"]*)"')); return m ? m[1] : null; };
      const name = line.includes(',') ? line.slice(line.indexOf(',') + 1).trim() : null;
      pending = {
        id: attr('tvg-id'),
        name: attr('tvg-name') || name,
        logo: attr('tvg-logo'),
        country: ((attr('tvg-country') || '').split(';')[0].trim().toUpperCase()) || null,
      };
    } else if (line.startsWith('#')) {
      continue;
    } else if (pending) {
      pending.url = line;
      if (pending.id && pending.url) out.push(pending);
      pending = null;
    }
  }
  const seen = new Set();
  return out.filter((e) => (seen.has(e.id) ? false : seen.add(e.id)));
}

async function fetchFreeTV() {
  try {
    const res = await fetch(FREETV_URL, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseM3U(await res.text());
  } catch (e) {
    console.warn(`Free-TV fetch failed (${e.message}); continuing with iptv-org only.`);
    return [];
  }
}

// --- live stream check ---
async function isStreamAlive(s) {
  const headers = { 'User-Agent': s.user_agent || 'VLC/3.0.20 LibVLC/3.0.20' };
  if (s.referrer) headers.Referer = s.referrer;
  try {
    const res = await fetch(s.url, {
      method: 'GET', headers, redirect: 'follow',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!res.ok) { try { await res.body?.cancel(); } catch {} return false; }
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
    if (l.channel && l.url && !logoByChannel.has(l.channel)) logoByChannel.set(l.channel, l.url);
  }

  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const channelById = new Map(channels.map((c) => [c.id, c]));

  // --- merge in Free-TV ---
  const extraChannels = [];
  if (USE_FREETV) {
    const freetv = await fetchFreeTV();
    console.log(`Free-TV: parsed ${freetv.length} channels`);
    let injected = 0, added = 0;
    for (const ft of freetv) {
      const ftStream = { channel: ft.id, url: ft.url, _source: 'free-tv' };
      const arr = streamsByChannel.get(ft.id) || [];
      arr.unshift(ftStream);
      streamsByChannel.set(ft.id, arr);
      if (ft.logo && !logoByChannel.has(ft.id)) logoByChannel.set(ft.id, ft.logo);

      if (channelById.has(ft.id)) {
        injected++;
      } else if (ft.country) {
        extraChannels.push({
          id: ft.id, name: ft.name, country: ft.country,
          categories: ['general'], is_nsfw: false,
        });
        added++;
      }
    }
    console.log(`Free-TV: boosted ${injected} existing channels, added ${added} new ones`);
  }

  // de-dup streams per channel by url (Free-TV stays first)
  for (const [id, arr] of streamsByChannel) {
    const seen = new Set();
    streamsByChannel.set(id, arr.filter((s) => (seen.has(s.url) ? false : seen.add(s.url))));
  }

  const allChannels = channels.concat(extraChannels);
  let selected = allChannels.filter(
    (c) => streamsByChannel.has(c.id) && !c.is_nsfw && !c.closed
  );
  console.log(`${selected.length} channels have streams listed`);

  if (COUNTRIES.length) {
    selected = selected.filter((c) => COUNTRIES.includes((c.country || '').toUpperCase()));
    console.log(`${selected.length} after country filter (${COUNTRIES.join(', ')})`);
  }

  if (FORCE_INCLUDE.size) {
    const have = new Set(selected.map((c) => c.id));
    const found = [];
    for (const c of allChannels) {
      if (FORCE_INCLUDE.has(c.id) && streamsByChannel.has(c.id) && !c.is_nsfw && !c.closed) {
        found.push(c.id);
        if (!have.has(c.id)) selected.push(c);
      }
    }
    const missing = [...FORCE_INCLUDE].filter((id) => !found.includes(id));
    console.log(`World Cup force-include: matched ${found.length} (${found.join(', ') || 'none'})`);
    if (missing.length) console.log(`  NOT found in iptv-org data — fix these IDs: ${missing.join(', ')}`);
  }

  // Force-included first, then priority categories, then alphabetical.
  selected.sort((a, b) => {
    const fa = isForced(a), fb = isForced(b);
    if (fa !== fb) return fa ? -1 : 1;
    const pa = isPriority(a), pb = isPriority(b);
    if (pa !== pb) return pa ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  if (MAX_CHANNELS > 0 && selected.length > MAX_CHANNELS) {
    selected = selected.slice(0, MAX_CHANNELS);
    console.log(`capped to ${selected.length} channels (priority categories kept first)`);
  }

  const liveStreamsByChannel = new Map();
  if (CHECK_STREAMS) {
    console.log(`Testing streams for ${selected.length} channels (timeout ${CHECK_TIMEOUT_MS}ms, concurrency ${CHECK_CONCURRENCY})…`);
    let tested = 0;
    const checked = await pMap(selected, async (c) => {
      const alive = [];
      for (const s of (streamsByChannel.get(c.id) || [])) {
        if (await isStreamAlive(s)) alive.push(s);
      }
      if (++tested % 200 === 0) console.log(`  …tested ${tested}/${selected.length}`);
      if (alive.length) { liveStreamsByChannel.set(c.id, alive); return c; }
      if (isForced(c)) { liveStreamsByChannel.set(c.id, streamsByChannel.get(c.id) || []); return c; }
      return null;
    }, CHECK_CONCURRENCY);
    const before = selected.length;
    selected = checked.filter(Boolean);
    console.log(`Stream check: kept ${selected.length}, dropped ${before - selected.length} dead channels`);
  } else {
    for (const c of selected) liveStreamsByChannel.set(c.id, streamsByChannel.get(c.id) || []);
  }

  const byCategory = new Map();
  const worldCupMetas = [];
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
    if (FORCE_INCLUDE.has(c.id)) worldCupMetas.push(metaPreview);

    writeJSON(`meta/tv/${stremioId}.json`, {
      meta: { ...metaPreview, background: logo, genres, country: c.country },
    });

    // Sort streams: header-free first so Nuvio/VLC (which ignore proxyHeaders)
    // always attempt the most compatible stream before falling back to header-gated ones.
    const sortedStreams = (liveStreamsByChannel.get(c.id) || []).slice().sort((a, b) => {
      const aHasHeaders = !!(a.referrer || a.user_agent);
      const bHasHeaders = !!(b.referrer || b.user_agent);
      if (aHasHeaders !== bHasHeaders) return aHasHeaders ? 1 : -1; // header-free first
      // Within same tier: Free-TV before iptv-org (Free-TV tends to be more open)
      const aFree = a._source === 'free-tv', bFree = b._source === 'free-tv';
      if (aFree !== bFree) return aFree ? -1 : 1;
      return 0;
    });

    const channelStreams = sortedStreams.map((s) => {
      const headers = {};
      if (s.referrer) headers.Referer = s.referrer;
      if (s.user_agent) headers['User-Agent'] = s.user_agent;
      const hasHeaders = Object.keys(headers).length > 0;
      const sourceName = s._source === 'free-tv' ? 'Free-TV' : 'IPTV-org';
      const stream = {
        // Append [H] to the name so users can see which streams need headers
        // and are likely to fail on Nuvio/VLC without them.
        name: hasHeaders ? `${sourceName} [H]` : sourceName,
        title: s.quality ? `${c.name} • ${s.quality}` : c.name,
        url: s.url,
        behaviorHints: { notWebReady: true },
      };
      if (hasHeaders) stream.behaviorHints.proxyHeaders = { request: headers };
      return stream;
    });
    writeJSON(`stream/tv/${stremioId}.json`, { streams: channelStreams });

    for (const cat of cats) {
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(metaPreview);
    }
  }

  if (hiddenSkipped) console.log(`skipped ${hiddenSkipped} channels (hidden category only, e.g. Indian news)`);

  // Catalog row order: priority categories first (in listed order), then alphabetical.
  const catalogDefs = [];
  const sortedCats = [...byCategory.keys()].sort((a, b) => {
    const ia = PRIORITY_CATEGORIES.indexOf(a), ib = PRIORITY_CATEGORIES.indexOf(b);
    const ra = ia === -1 ? 999 : ia, rb = ib === -1 ? 999 : ib;
    if (ra !== rb) return ra - rb;
    return (categoryName.get(a) || a).localeCompare(categoryName.get(b) || b);
  });
  for (const cat of sortedCats) {
    const catalogId = 'iptv-' + safeId(cat);
    writeJSON(`catalog/tv/${catalogId}.json`, { metas: byCategory.get(cat) });
    catalogDefs.push({ type: 'tv', id: catalogId, name: `IPTV · ${categoryName.get(cat) || cat}` });
  }
  if (worldCupMetas.length) {
    writeJSON('catalog/tv/iptv-worldcup.json', { metas: worldCupMetas });
    catalogDefs.unshift({ type: 'tv', id: 'iptv-worldcup', name: '\u26bd World Cup' });
  }

  writeJSON('manifest.json', {
    id: 'org.iptvorg.static',
    version: '1.3.0',
    name: 'IPTV-org + Free-TV',
    description: 'Free-to-air channels from the iptv-org project, merged with the curated Free-TV playlist.',
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
