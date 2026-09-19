import './lib/env.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { runAll } from './providers/index.js';
import * as sbb from './providers/sbb.js';
import { cacheGet, cacheSet, appendHistory, readHistory } from './lib/store.js';
import { ogCard } from './lib/og.js';
import { toDisplayPrice } from './lib/currency.js';

const PORT = Number(process.env.FARES_PORT || 4055);
const UA = 'fare-comparator@https://sillytransfem.online (personal fare monitoring)';

const DEFAULT_ROUTES = [
  { from: 'Praha', to: 'Berlin Hbf', dateOffsetDays: 1 }, // Timetables 1.0.274 = heute/morgen; RIS::Journeys Paket XS pending -> nach Freigabe automatisch 14d
  { from: 'Berlin Hbf', to: 'Wien Hbf', dateOffsetDays: 1 },
  { from: 'Berlin Hbf', to: 'München Hbf', dateOffsetDays: 1 },
  { from: 'Praha', to: 'Wien Hbf', dateOffsetDays: 1 },
];
// Nach RIS::Journeys Freigabe: dateOffsetDays wieder auf 14 setzen - Provider nutzt dann automatisch RIS::Journeys für +14d

const routeKey = (r) => `${r.from}→${r.to}`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function doSearch(params, live = false) {
  const key = `${params.from}|${params.to}|${params.when}|${params.sparpreis ? 'spar' : 'flex'}`;
  if (!live) {
    const cached = cacheGet(key);
    if (cached) return cached;
  }
  // normalize station names, keep times
  const when = new Date(params.when || Date.now());
  const result = await runAll({ from: params.from, to: params.to, when, sparpreis: !!params.sparpreis, age: params.age, bahncard: params.bahncard }, 25000);
  cacheSet(key, result);
  return result;
}

async function scrapeRoute(route) {
  const when = new Date(Date.now() + route.dateOffsetDays * 86400000);
  const result = await doSearch({ from: route.from, to: route.to, when }, true);
  await appendHistory(routeKey(route), { from: route.from, to: route.to, when: when.toISOString(), result });
  return result;
}

async function periodicScrape() {
  for (const route of DEFAULT_ROUTES) {
    try {
      const r = await scrapeRoute(route);
      console.log(`[scrape] ${routeKey(route)} → ${r.offers.length} offers`, r.statuses.map((s) => `${s.label}:${s.status}`).join(' '));
    } catch (err) {
      console.error(`[scrape] ${routeKey(route)} failed:`, err.message);
    }
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  res.setHeader('Cache-Control', 'no-store');

  const send = (code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  try {
    if (u.pathname === '/' || u.pathname === '/index.html') {
      let html = await readFile(new URL('./web/index.html', import.meta.url), 'utf8');
      const from = (u.searchParams.get('from') || '').trim();
      const to = (u.searchParams.get('to') || '').trim();
      let ogTitle = 'fares';
      let ogDesc = 'Fare comparison across SBB, DB, Flix, CD/IDOS';
      let ogImage = 'https://fare.sillytransfem.online/og.png';
      if (from && to) {
        try {
          const when = u.searchParams.get('date') ? new Date(u.searchParams.get('date') + 'T12:00:00Z') : new Date();
          const result = await doSearch({ from, to, when });
          const priced = (result.offers || []).filter((o) => typeof o.price === 'number');
          const cheapest = priced.sort((a, b) => a.price - b.price)[0];
          if (cheapest) {
            ogTitle = `${from} → ${to}: ab ${toDisplayPrice(cheapest.price, cheapest.currency, 'EUR')} EUR`;
            ogDesc = `Cheapest fare ${cheapest.price.toFixed(2)} ${cheapest.currency} (${cheapest.providerLabel}) · ${priced.length} priced connection${priced.length === 1 ? '' : 's'}`;
            ogImage = `https://fare.sillytransfem.online/og.png?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${u.searchParams.get('date') ? '&date=' + u.searchParams.get('date') : ''}`;
          } else {
            ogTitle = `${from} → ${to}: no priced fares`;
            ogDesc = 'Only timetable results (no bookable price) for this route & date.';
          }
        } catch { /* fall back to generic embed */ }
      }
      html = html
        .replace(/(<meta property="og:title" content=")([^"]*)"/, `$1${esc(ogTitle)}"`)
        .replace(/(<meta property="og:description" content=")([^"]*)"/, `$1${esc(ogDesc)}"`)
        .replace(/(<meta property="og:image" content=")([^"]*)"/, `$1${esc(ogImage)}"`);
      return send(200, html, 'text/html; charset=utf-8');
    }
    if (u.pathname === '/og.png') {
      const from = (u.searchParams.get('from') || 'Praha').trim();
      const to = (u.searchParams.get('to') || 'Berlin Hbf').trim();
      const date = (u.searchParams.get('date') || new Date().toISOString().slice(0, 10)).slice(0, 10);
      let label = '', price = null, currency = 'EUR';
      try {
        const when = new Date(date + 'T12:00:00Z');
        const result = await doSearch({ from, to, when });
        const priced = (result.offers || []).filter((o) => typeof o.price === 'number').sort((a, b) => a.price - b.price);
        const c = priced[0];
        if (c) { label = c.providerLabel + ': '; price = c.price; currency = c.currency; }
      } catch { /* default values */ }
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=900');
      return res.end(ogCard({ from, to, date, label, price, currency }));
    }
    if (u.pathname === '/api/search') {
      const from = (u.searchParams.get('from') || '').trim();
      const to = (u.searchParams.get('to') || '').trim();
      const date = u.searchParams.get('date');
      const sparpreis = u.searchParams.get('sparpreis') === 'true';
      const age = parseInt(u.searchParams.get('age')) || undefined;
      const bahncard = u.searchParams.get('bahncard') || undefined;
      if (!from || !to) return send(400, { error: 'from and to are required' });
      const when = date ? new Date(date + 'T12:00:00Z') : new Date();
      const result = await doSearch({ from, to, when, sparpreis, age, bahncard });
      return send(200, result);
    }
    if (u.pathname === '/api/split') {
      const from = (u.searchParams.get('from') || '').trim();
      const to = (u.searchParams.get('to') || '').trim();
      const date = u.searchParams.get('date');
      const maxSplits = parseInt(u.searchParams.get('maxSplits')) || 5;
      if (!from || !to) return send(400, { error: 'from and to are required' });
      // Resolve EVA IDs using db provider
      const db = await import('./providers/db.js');
      const fromEva = await db.resolve(from);
      const toEva = await db.resolve(to);
      if (!fromEva || !toEva) return send(400, { error: `no EVA for ${from}(${fromEva||'?'})/${to}(${toEva||'?'})` });
      const dateStr = date || new Date().toISOString().slice(0, 10);
      const pyScript = '/opt/fares/scrapy_fares/vendo_split.py';
      const args = [pyScript, '--from-eva', fromEva, '--to-eva', toEva, '--date', dateStr, '--max-splits', String(maxSplits)];
      const venvPy = '/opt/fares/scrapy_fares/.venv/bin/python3';
      return new Promise((resolve) => {
        execFile(venvPy, args, { timeout: 120000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
          if (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message?.slice(0, 200) })); return resolve(); }
          try {
            const result = JSON.parse(stdout || '{}');
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(result));
            resolve();
          } catch (e) {
            res.writeHead(500); res.end(JSON.stringify({ error: 'parse error' })); resolve();
          }
        });
      });
    }
    if (u.pathname === '/api/suggest') {
      const q = (u.searchParams.get('q') || '').trim();
      if (q.length < 2) return send(200, { results: [] });
      try {
        const results = await sbb.suggest(q);
        return send(200, { results });
      } catch (err) {
        return send(500, { error: err.message });
      }
    }
    if (u.pathname === '/api/history') {
      const from = u.searchParams.get('from') || '';
      const to = u.searchParams.get('to') || '';
      const rows = from && to ? await readHistory(routeKey({ from, to })) : [];
      return send(200, { rows });
    }
    if (u.pathname === '/api/scrape') {
      await periodicScrape();
      return send(200, { ok: true });
    }
    if (u.pathname === '/health') return send(200, { ok: true, ua: UA });
    return send(404, { error: 'not found' });
  } catch (err) {
    return send(500, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fares listening on 127.0.0.1:${PORT} (UA: ${UA})`);
  periodicScrape().catch((e) => console.error('initial scrape failed', e));
  setInterval(() => periodicScrape().catch((e) => console.error('periodic scrape failed', e)), 30 * 60 * 1000);
});