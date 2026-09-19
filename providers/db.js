import fs from 'node:fs';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { offer } from '../lib/normalize.js';

// Integrated DB provider: web fare API via Oxylabs Web Unblocker + RIS::Journeys + Timetables fallbacks
// Priority: 1) www.bahn.de/web/api/angebote/fahrplan via Web Unblocker (real prices, +14d),
//           2) RIS::Journeys for safe-plan fallback, 3) Timetables plan for today/tomorrow
const UA = 'fare-comparator@https://sillytransfem.online (personal fare monitoring)';

const OXY = {
  user: process.env.OXYLABS_USER || '',
  pass: process.env.OXYLABS_PASS || '',
};

// Credentials come from .env / environment (DB_CLIENT_ID, DB_CLIENT_SECRET). See lib/env.js
const CLIENT_ID = process.env.DB_CLIENT_ID || '';
const CLIENT_SECRET = process.env.DB_CLIENT_SECRET || '';
const CERT_PATH = process.env.DB_CERT_PATH || '/opt/fares/bahnprice-cert.pem';
const KEY_PATH = process.env.DB_KEY_PATH || '/opt/fares/bahnprice-key.pem';

const BASE_TIMETABLES = 'https://apis.deutschebahn.com/db-api-marketplace/apis/timetables/v1';
// RIS::Journeys and RIS::Stations bases - pending approval returns 404/403 until freigeschaltet
const BASE_RIS_JOURNEYS = 'https://apis.deutschebahn.com/db-api-marketplace/apis/ris-journeys/v1';
const BASE_RIS_STATIONS = 'https://apis.deutschebahn.com/db-api-marketplace/apis/ris-stations/v1';

const EVA_MAP = new Map([
  ['berlin hbf', '8011160'], ['berlin', '8011160'],
  ['wien hbf', '8103000'], ['wien', '8103000'], ['vienna', '8103000'],
  ['münchen hbf', '8000261'], ['muenchen hbf', '8000261'], ['münchen', '8000261'], ['muenchen', '8000261'],
  ['praha', '5400001'], ['praha hl.n.', '5400001'], ['prague', '5400001'],
  ['hamburg hbf', '8002549'], ['köln hbf', '8000207'], ['frankfurt hbf', '8000105'],
  ['stuttgart hbf', '8000096'], ['dresden hbf', '8010085'], ['leipzig hbf', '8010205'],
  ['nürnberg hbf', '8000284'], ['frankfurt(m) flug', '8070003'], ['frankfurt flughafen', '8070003'],
  ['berlin südkreuz', '8011113'], ['düsseldorf hbf', '8000085'], ['essen hbf', '8000098'],
  ['hannover hbf', '8000152'], ['bremen hbf', '8000050'], ['freiburg hbf', '8000107'],
  ['dortmund hbf', '8000080'], ['mannheim hbf', '8000244'], ['karlsruhe hbf', '8000191'],
  ['würzburg hbf', '8000260'], ['augsburg hbf', '8000013'],
  ['erfurt hbf', '8010099'], ['halle hbf', '8010147'], ['kiel hbf', '8000199'],
  ['aschaffenburg hbf', '8000010'], ['aschaffenburg', '8000010'],
  ['aachen hbf', '8000001'], ['bielefeld hbf', '8000036'], ['bochum hbf', '8000041'],
  ['bonn hbf', '8000044'], ['braunschweig hbf', '8000049'],
  ['duisburg hbf', '8000086'], ['oberhausen hbf', '8000286'],
  ['flensburg hbf', '8000140'], ['rostock hbf', '8000451'], ['schwerin hbf', '8000480'],
  ['magdeburg hbf', '8000327'], ['ulm hbf', '8000523'], ['heidelberg hbf', '8000156'],
  ['darmstadt hbf', '8000240'], ['konstanz hbf', '8000335'], ['lindau hbf', '8000317'],
  ['bielefeld hbf', '8000036'], ['giessen hbf', '8000145'], ['kaiserslautern hbf', '8000219'],
  ['saarbrücken hbf', '8000456'], ['koblenz hbf', '8000233'], ['mainz hbf', '8000329'],
  ['wiesbaden hbf', '8000545'], ['lübeck hbf', '8000323'], ['rheine hbf', '8000317'],
  ['münster hbf', '8000379'], ['osnabrück hbf', '8000414'], ['oldenburg hbf', '8000408'],
  ['paderborn hbf', '8000415'], ['potsdam hbf', '8000425'], ['regensburg hbf', '8000440'],
  ['chemnitz hbf', '8000165'], ['cottbus hbf', '8000180'], ['bayreuth hbf', '8000028'],
  ['hof hbf', '8000173'], ['passau hbf', '8000422'], ['landshut hbf', '8000248'],
  ['ingolstadt hbf', '8000196'], ['fürth hbf', '8000130'], ['pforzheim hbf', '8000424'],
  ['heilbronn hbf', '8000160'], ['tübingen hbf', '8000518'], ['worms hbf', '8000554'],
  ['wuppertal hbf', '8000556'], ['solingen hbf', '8000488'],
  ['zürich hb', '8503000'], ['zurich hb', '8503000'], ['basel sbb', '8500010'],
  ['salzburg hbf', '8100002'], ['innsbruck hbf', '8100124'],
  ['klagenfurt hbf', '8100153'], ['graz hbf', '8100118'], ['linz hbf', '8100013'],
  ['bratislava hl.st.', '5600001'],
  ['budapest keleti', '5500003'], ['warschau', '5100048'], ['warszawa', '5100048'],
]);

function getAgent() {
  try {
    if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
      const cert = fs.readFileSync(CERT_PATH, 'utf8');
      const key = fs.readFileSync(KEY_PATH, 'utf8');
      return new https.Agent({ cert, key, keepAlive: true });
    }
  } catch {}
  return undefined;
}

function baseHeaders(accept = 'application/json') {
  return {
    'DB-Client-Id': CLIENT_ID,
    'DB-Api-Key': CLIENT_SECRET,
    'Accept': accept,
    'User-Agent': UA,
  };
}

export async function resolve(name) {
  const key = name.trim().toLowerCase();
  if (EVA_MAP.has(key)) return EVA_MAP.get(key);
  // Try RIS::Stations if subscribed (Testzugang)
  try {
    const url = `${BASE_RIS_STATIONS}/stations?search=${encodeURIComponent(name)}`;
    const res = await fetch(url, { headers: baseHeaders(), agent: getAgent() });
    if (res.ok) {
      const json = await res.json().catch(() => null);
      const list = Array.isArray(json) ? json : (json && json.stations) || [];
      if (list.length > 0 && list[0].eva) return String(list[0].eva);
    }
  } catch {}
  // Try bahn.de ort-lookup via Web Unblocker (extId = EVA). Only when configured.
  try {
    if (OXY.user && OXY.pass) {
      const url = `https://www.bahn.de/web/api/reiseloesung/orte?suchbegriff=${encodeURIComponent(name)}&typ=ALL&limit=1`;
      const r = await fetch(url, { headers: { 'x-oxylabs-geo-location': 'Germany', 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
      if (r.ok) {
        const json = await r.json().catch(() => null);
        const hit = Array.isArray(json) ? json[0] : null;
        if (hit && hit.extId) return String(hit.extId);
      }
    }
  } catch {}
  return null;
}

function formatDate(d) { const pad=(n)=>String(n).padStart(2,'0'); return `${String(d.getFullYear()).slice(-2)}${pad(d.getMonth()+1)}${pad(d.getDate())}`; }
function formatHour(d) { return String(d.getHours()).padStart(2,'0'); }

function parsePlanXml(xml) {
  const entries=[]; const sRe=/<s\b([^>]*?)>([\s\S]*?)<\/s>/g; let m;
  while((m=sRe.exec(xml))!==null){
    const inner=m[2];
    const tlMatch=inner.match(/<tl\b([^>]*?)>/); const dpMatch=inner.match(/<dp\b([^>]*?)>/); const arMatch=inner.match(/<ar\b([^>]*?)>/);
    const parseAttrs=(s)=>{ if(!s) return {}; const o={}; const re=/(\w+)="([^"]*)"/g; let x; while((x=re.exec(s))!==null) o[x[1]]=x[2]; return o; };
    entries.push({ tl: tlMatch?parseAttrs(tlMatch[1]):{}, dp: dpMatch?parseAttrs(dpMatch[1]):{}, ar: arMatch?parseAttrs(arMatch[1]):{} });
  }
  return entries;
}
function toIsoFromYYMMDDHHMM(yyMMdd, hhmm){
  const yy=2000+Number(yyMMdd.slice(0,2)); const mm=Number(yyMMdd.slice(2,4))-1; const dd=Number(yyMMdd.slice(4,6));
  const hh=Number(hhmm.slice(0,2)); const mi=Number(hhmm.slice(2,4));
  const isSummer=mm>=3&&mm<=9; const offset=isSummer?2:1;
  return new Date(Date.UTC(yy,mm,dd,hh-offset,mi)).toISOString();
}


// --- Vendo Backend (DB Navigator mobile API) via Python/curl_cffi bridge ---
// app.services-bahn.de/mob is NOT behind Akamai - works directly from any VPS.
// Python script uses curl_cffi with Chrome TLS impersonation.
// Accepts either EVA codes OR station names (Vendo resolves names automatically).
async function tryVendoFares(fromStation, toStation, whenDate, age, bahncard) {
  const pad = n => String(n).padStart(2, '0');
  const date = `${whenDate.getFullYear()}-${pad(whenDate.getMonth()+1)}-${pad(whenDate.getDate())}`;
  const time = `${pad(whenDate.getHours())}:${pad(whenDate.getMinutes())}:00`;
  const pyScript = '/opt/fares/scrapy_fares/vendo_fares.py';

  const args = [pyScript, '--from', fromStation, '--to', toStation, '--date', date, '--time', time];
  if (age != null) args.push('--age', String(age));
  if (bahncard) args.push('--bahncard', bahncard);
  const venvPy = '/opt/fares/scrapy_fares/.venv/bin/python3';

  return new Promise((resolve) => {
    execFile(venvPy, args, { timeout: 45000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ error: `vendo: ${err.message?.slice(0,120)}` });
      try {
        const d = JSON.parse(stdout || '{}');
        if (d.error) return resolve({ error: d.error });
        return resolve({ offers: d.offers || [] });
      } catch (e) {
        return resolve({ error: `vendo: JSON parse failed: ${e.message?.slice(0,100)}` });
      }
    });
  });
}

function parseVendoOffers(vendoOffers, fromStation, toStation, whenDate) {
  const offers = [];
  const pad = n => String(n).padStart(2, '0');
  const dateStr = `${whenDate.getFullYear()}-${pad(whenDate.getMonth()+1)}-${pad(whenDate.getDate())}`;
  for (const o of vendoOffers.slice(0, 8)) {
    const product = o.product || 'DB';
    const from = encodeURIComponent(fromStation);
    const to = encodeURIComponent(toStation);
    const soid = encodeURIComponent(`O=${fromStation}`);
    const zoid = encodeURIComponent(`O=${toStation}`);
    const url = `https://www.bahn.de/buchung/fahrplan/suche#sts=true&so=${from}&zo=${to}&soid=${soid}&zoid=${zoid}&kl=2&hd=${dateStr}T${pad(whenDate.getHours())}:${pad(whenDate.getMinutes())}:00&hza=D&ar=false&s=false&d=false&hz=%5B%5D&fm=false&bp=false`;
    offers.push(offer({
      provider: 'db', providerLabel: 'DB',
      operator: product.startsWith('ICE') || product.startsWith('EC') || product.startsWith('IC') ? 'Deutsche Bahn' : product,
      product: product,
      departure: o.departure, arrival: o.arrival,
      price: typeof o.price === 'number' ? o.price : null,
      currency: o.currency || 'EUR',
      fareType: 'Flexpreis',
      url: url,
    }));
  }
  return offers;
}

// --- RIS::Journeys attempt (supports +14d, real from→to) ---
async function tryRisJourneys(fromId, toId, whenDate) {
  // Documented RIS::Journeys endpoints vary; try most likely patterns. Pending approval returns 404/"API not found"
  const dateIso = whenDate.toISOString().slice(0,10); // YYYY-MM-DD
  const timeIso = whenDate.toISOString().slice(11,16); // HH:MM
  const candidates = [
    `${BASE_RIS_JOURNEYS}/journeys?origin=${fromId}&destination=${toId}&date=${dateIso}&time=${timeIso}`,
    `${BASE_RIS_JOURNEYS}/journeys?from=${fromId}&to=${toId}&date=${dateIso}`,
    `${BASE_RIS_JOURNEYS}/journey?originEva=${fromId}&destinationEva=${toId}&date=${dateIso}T${timeIso}:00`,
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: baseHeaders('application/json'), agent: getAgent() });
      if (res.status === 404 && (await res.clone().text()).includes('API not found')) {
        // Pending Genehmigung - product not yet enabled for this Client ID
        return { pending: true, url, status: 404 };
      }
      if (res.status === 401 || res.status === 403) return { blocked: true, status: res.status, url };
      if (!res.ok) continue;
      const json = await res.json();
      const journeys = json.journeys || json.connections || json.results || (Array.isArray(json) ? json : []);
      if (Array.isArray(journeys) && journeys.length > 0) return { journeys, url };
    } catch {}
  }
  return null;
}

// --- Timetables fallback (departure board, today/tomorrow only) ---
async function tryTimetables(fromId, whenDate) {
  const dateStr = formatDate(whenDate); const hourStr = formatHour(whenDate);
  const tryFetch = async (ds, hs) => {
    const u = `${BASE_TIMETABLES}/plan/${fromId}/${ds}/${hs}`;
    const r = await fetch(u, { headers: baseHeaders('application/xml'), agent: getAgent() });
    if (r.status === 401 || r.status === 403) return { blocked: true, status: r.status };
    if (r.status === 404) return { empty: true };
    if (!r.ok) return { error: `timetables http ${r.status}` };
    const xml = await r.text(); const entries = parsePlanXml(xml); return { entries };
  };
  let res = await tryFetch(dateStr, hourStr);
  if (res.blocked) return res;
  if ((res.empty || (res.entries && res.entries.length===0))) {
    const nextHour = String((Number(hourStr)+1)%24).padStart(2,'0');
    const nextDate = nextHour==='00' ? formatDate(new Date(whenDate.getTime()+3600000)) : dateStr;
    const r2 = await tryFetch(nextDate, nextHour);
    if (r2.entries && r2.entries.length>0) return r2;
  }
  return res;
}

export async function search({ from, to, when, sparpreis, age, bahncard }) {
  const whenDate = new Date(when);

  // 0) Vendo Backend (DB Navigator mobile API) — accepts station names directly
  // No EVA resolution needed for Vendo (it resolves names automatically)
  const vf = await tryVendoFares(from, to, whenDate, age, bahncard);
  if (vf.offers && vf.offers.length > 0) {
    const offers = parseVendoOffers(vf.offers, from, to, whenDate);
    if (offers.length > 0) {
      return { status: 'ok', offers, meta: { source: 'vendo-mob', note: sparpreis ? 'Sparpreis (vendo)' : 'Flexpreis (vendo)' } };
    }
  }
  if (vf.error) console.log(`[db] vendo: ${vf.error} → fallback`);

  // Fallback: RIS::Journeys / Timetables need EVA codes
  const fromId = await resolve(from); const toId = await resolve(to);
  if (!fromId || !toId) {
    return { status: 'empty', error: `db: no EVA mapping for ${from}(${fromId||'?'})/${to}(${toId||'?'}) - SBB übernimmt die Strecke` };
  }

  // 1) Try RIS::Journeys (ideal for comparator, supports +14d)
  const ris = await tryRisJourneys(fromId, toId, whenDate);
  if (ris && ris.journeys) {
    const offers = ris.journeys.slice(0,4).map(j => {
      // RIS::Journeys format: legs with departure/arrival, try to normalize
      const first = j.legs ? j.legs[0] : j;
      const last = j.legs ? j.legs[j.legs.length-1] : j;
      const dep = first.departure || first.departureTime || first.scheduledDeparture || whenDate.toISOString();
      const arr = last.arrival || last.arrivalTime || null;
      const line = first.line || j.line || {};
      return offer({
        provider: 'db', providerLabel: 'DB', operator: line.operator?.name || 'Deutsche Bahn',
        product: line.name || line.product || null,
        departure: dep, arrival: arr,
        price: null, currency: 'EUR',
        url: `https://www.bahn.de/buchung?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      });
    });
    return { status: 'ok', offers, meta: { source: 'ris-journeys-1.0.273', note: 'timetable-only, price via bahn.de shop' } };
  }
  if (ris && ris.pending) {
    // Journeys not yet approved - fall through to Timetables with clear note, don't error out
    console.log(`[db] RIS::Journeys pending approval (Paket XS) - falling back to Timetables for ${from}→${to}`);
  }
  if (ris && ris.blocked) return { status: 'blocked', error: `ris-journeys ${ris.status} - check Produktfreigabe im Portal` };

  // 2) Fallback Timetables (today/tomorrow only)
  const hoursAhead = (whenDate.getTime() - Date.now())/3600000;
  if (hoursAhead > 36) {
    return { status: 'empty', error: `timetables: +${Math.round(hoursAhead/24)}d zu weit in Zukunft (Timetables nur heute/morgen). RIS::Journeys Paket XS ist beantragt (Anstehende Genehmigung) - sobald freigeschaltet geht +14d automatisch.` };
  }
  const tt = await tryTimetables(fromId, whenDate);
  if (tt.blocked) return { status: 'blocked', error: `timetables ${tt.status} - check Client ID/Secret` };
  if (tt.error) return { status: 'error', error: tt.error };
  if (!tt.entries || tt.entries.length===0) return { status: 'empty', error: `timetables: <timetable/> leer für ${from} ${formatDate(whenDate)}/${formatHour(whenDate)} (Berlin oft leer, München ok). Warte auf RIS::Journeys Freigabe für echte Journeys.` };
  const offers = tt.entries.slice(0,4).map(e=>{
    const depPt = e.dp.pt || e.ar.pt; let depIso = whenDate.toISOString();
    if (depPt && depPt.length>=10) depIso = toIsoFromYYMMDDHHMM(depPt.slice(0,6), depPt.slice(6,10));
    const tl=e.tl; const name=tl.c?`${tl.c} ${tl.n||''}`.trim():null;
    return offer({ provider:'db', providerLabel:'DB', operator:'Deutsche Bahn', product:name, departure:depIso, arrival:null, price:null, currency:'EUR', url:`https://www.bahn.de/buchung?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` });
  });
  return { status: 'ok', offers, meta: { source: 'timetables-1.0.274', note: 'timetable-only, RIS::Journeys pending - fallback' } };
}
