import './lib/env.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { runAll } from './providers/index.js';
import { cacheGet, cacheSet, appendHistory, readHistory } from './lib/store.js';

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

async function doSearch(params, live = false) {
  const key = `${params.from}|${params.to}|${params.when}`;
  if (!live) {
    const cached = cacheGet(key);
    if (cached) return cached;
  }
  // normalize station names, keep times
  const when = new Date(params.when || Date.now());
  const result = await runAll({ from: params.from, to: params.to, when }, 25000);
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
      const html = await readFile(new URL('./web/index.html', import.meta.url), 'utf8');
      return send(200, html, 'text/html; charset=utf-8');
    }
    if (u.pathname === '/api/search') {
      const from = (u.searchParams.get('from') || '').trim();
      const to = (u.searchParams.get('to') || '').trim();
      const date = u.searchParams.get('date');
      if (!from || !to) return send(400, { error: 'from and to are required' });
      const when = date ? new Date(date + 'T12:00:00Z') : new Date();
      const result = await doSearch({ from, to, when });
      return send(200, result);
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