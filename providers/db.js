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
  ['erfurt hbf', '8010099'], ['halle hbf', '8010147'], ['kiel hbf', '8000172'],
  ['zürich hb', '8503000'], ['zurich hb', '8503000'], ['salzburg hbf', '8100002'], ['innsbruck hbf', '8100124'],
  ['klagenfurt hbf', '8100153'], ['graz hbf', '8100118'], ['lintz hbf', '8100013'], ['bratislava hl.st.', '5600001'],
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

async function resolve(name) {
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

function resolveTraveller(age, bahncard) {
  let typ = 'ERWACHSENER';
  if (age != null) {
    if (age < 5) typ = 'KLEINKIND';
    else if (age < 15) typ = 'KIND';
    else if (age < 27) typ = 'JUGENDLICH';
    else if (age < 65) typ = 'ERWACHSENER';
    else typ = 'SENIOR';
  }
  const ermaessigungen = [{ art: 'KEINE_ERMAESSIGUNG', klasse: 'KLASSENLOS' }];
  if (bahncard) {
    const bc = bahncard.toUpperCase().replace('BAHN_CARD_','').replace('BC','');
    if (bc === '25_1' || bc === '251') ermaessigungen[0] = { art: 'BAHNCARD25', klasse: 'KLASSE_2' };
    else if (bc === '25_2' || bc === '252') ermaessigungen[0] = { art: 'BAHNCARD25', klasse: 'KLASSE_1' };
    else if (bc === '50_1' || bc === '501') ermaessigungen[0] = { art: 'BAHNCARD50', klasse: 'KLASSE_2' };
    else if (bc === '50_2' || bc === '502') ermaessigungen[0] = { art: 'BAHNCARD50', klasse: 'KLASSE_1' };
  }
  return [{ typ, ermaessigungen, anzahl: 1, alter: age != null ? [age] : [] }];
}

// --- Web fare API via Oxylabs Web Unblocker (real prices, from→to, +14d) ---
// Uses curl because Web Unblocker routes different TLS fingerprints to different IP pools.
// Node.js JA3 → blocked pool; curl JA3 → residential pool.
// 2-step: fahrplan → ctxRecon → recon (delivers reiseAngebote with Sparpreis/Flexpreis)
async function tryWebFares(fromExtId, toExtId, whenDate, sparpreis = false, age, bahncard) {
  // SOCKS5 tunnel (port 1081) is always running; Oxylabs is optional fallback
  const pad = n => String(n).padStart(2, '0');
  const date = `${whenDate.getFullYear()}-${pad(whenDate.getMonth()+1)}-${pad(whenDate.getDate())}`;
  const time = `${pad(whenDate.getHours())}:${pad(whenDate.getMinutes())}:00`;
  const traveller = resolveTraveller(age, bahncard);

  // Proxy strategy: SOCKS5 tunnel (home PC or masklabs) → Oxylabs HTTP fallback
  const SOCKS5_PROXY = '127.0.0.1:1081';
  const OXY_PROXY = `http://${OXY.user}:${OXY.pass}@unblock.oxylabs.io:60000`;

  function curlPost(url, body, timeoutSec = 60) {
    const tmpFile = `/tmp/_oxy_${Date.now()}_${Math.random().toString(36).slice(2)}.json`;
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(body));
      return tryWithProxy(url, tmpFile, timeoutSec, SOCKS5_PROXY, true)
        .then(r => r || tryWithProxy(url, tmpFile, timeoutSec, OXY_PROXY, false))
        .finally(() => { try { fs.unlinkSync(tmpFile); } catch {} });
    } catch { return Promise.resolve(''); }
  }

  function tryWithProxy(url, tmpFile, timeoutSec, proxy, isSocks) {
    const args = ['-sk', '-X', 'POST',
      '-H', 'Content-Type: application/json; charset=UTF-8',
      '-H', 'Accept: application/json',
      '-H', 'X-Oxylabs-Geo-Location: Germany',
      '-H', 'x-oxylabs-force-headers: 1',
      '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      '-H', 'Origin: https://www.bahn.de',
      '-H', 'Referer: https://www.bahn.de/buchung/fahrplan/suche',
      '--max-time', String(timeoutSec),
      '-d', `@${tmpFile}`, url];
    if (isSocks) args.splice(1, 0, '--socks5-hostname', proxy);
    else args.splice(1, 0, '-x', proxy);
    return new Promise((resolve) => {
      execFile('curl', args, { timeout: (timeoutSec + 5) * 1000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        resolve(err ? '' : (stdout || ''));
      });
    });
  }

  function parseJson(stdout) {
    const i = stdout.indexOf('{');
    if (i < 0) return null;
    return JSON.parse(stdout.slice(i));
  }

  try {
    // Step 1: fahrplan → connections with ctxRecon
    const fahrplanPayload = {
      abfahrtsHalt: `A=1@L=${fromExtId}@`, anfrageZeitpunkt: `${date}T${time}`,
      ankunftsHalt: `A=1@L=${toExtId}@`, ankunftSuche: 'ABFAHRT', klasse: 'KLASSE_2',
      produktgattungen: ['ICE','EC_IC','IR','REGIONAL','SBAHN','BUS','SCHIFF','UBAHN','TRAM','ANRUFPFLICHTIG'],
      reisende: traveller, schnelleVerbindungen: true, deutschlandTicketVorhanden: false,
    };
    const fahrplanJson = parseJson(await curlPost('https://www.bahn.de/web/api/angebote/fahrplan', fahrplanPayload));
    if (!fahrplanJson) return { error: 'web-fares: no JSON from fahrplan' };
    if (fahrplanJson.status === 'ERROR') return { blocked: true, error: fahrplanJson.code };
    const verbindungen = fahrplanJson?.verbindungen || [];
    if (verbindungen.length === 0) return { empty: true };

    // Step 2: recon for connections missing price (parallel, max 3, 15s timeout each)
    const noPrice = verbindungen.filter(v => !v.angebotsPreis?.betrag && v.ctxRecon).slice(0, 3);
    if (noPrice.length > 0) {
      await Promise.all(noPrice.map(async v => {
        try {
          const reconPayload = { klasse: 'KLASSE_2', reisende: traveller, ctxRecon: v.ctxRecon, deutschlandTicketVorhanden: false };
          const reconJson = parseJson(await curlPost('https://www.bahn.de/web/api/angebote/recon', reconPayload, 15));
          const rv = reconJson?.verbindungen?.[0];
          if (rv?.angebotsPreis?.betrag) v.angebotsPreis = rv.angebotsPreis;
          if (rv?.reiseAngebote?.length) v.reiseAngebote = rv.reiseAngebote;
        } catch {}
      }));
    }
    // Sparpreis enrichment (parallel, max 3)
    if (sparpreis) {
      const sparCandidates = verbindungen.filter(v => v.ctxRecon && !v.reiseAngebote).slice(0, 3);
      if (sparCandidates.length > 0) {
        await Promise.all(sparCandidates.map(async v => {
          try {
            const reconPayload = { klasse: 'KLASSE_2', reisende: traveller, ctxRecon: v.ctxRecon, deutschlandTicketVorhanden: false };
            const reconJson = parseJson(await curlPost('https://www.bahn.de/web/api/angebote/recon', reconPayload, 15));
            const rv = reconJson?.verbindungen?.[0];
            if (rv?.reiseAngebote?.length) v.reiseAngebote = rv.reiseAngebote;
          } catch {}
        }));
      }
    }
    return { verbindungen };
  } catch (e) {
    return { error: `web-fares exception: ${e.message?.slice(0,100)}` };
  }
}

function parseWebFares(verbindungen, sparpreis = false) {
  const offers = [];
  for (const v of verbindungen.slice(0, 8)) {
    const segs = v.verbindungsAbschnitte || [];
    if (!segs.length) continue;
    const dep = segs[0]?.abfahrt?.sollzeit || segs[0]?.halte?.[0]?.abfahrt?.sollzeit;
    const last = segs[segs.length-1];
    const arr = last?.ankunft?.sollzeit || last?.halte?.[last.halte.length-1]?.ankunft?.sollzeit;
    const vm = segs[0]?.verkehrsmittel;

    // If sparpreis requested, extract from reiseAngebote
    let price = null;
    let fareLabel = sparpreis ? 'Sparpreis' : 'Flexpreis';
    if (sparpreis && v.reiseAngebote?.length) {
      const hinfahrt = v.reiseAngebote[0]?.hinfahrt?.fahrtAngebote || [];
      // Prefer "Super Sparpreis" > "Sparpreis" > first available
      const spar = hinfahrt.find(o => o.name?.includes('Super Sparpreis'))
        || hinfahrt.find(o => o.name?.includes('Sparpreis'))
        || hinfahrt[0];
      if (spar?.preis?.betrag != null) {
        price = spar.preis.betrag;
        fareLabel = spar.name || 'Sparpreis';
      }
    }
    if (price == null) {
      price = v.angebotsPreis?.betrag;
      fareLabel = sparpreis ? 'Sparpreis (Flexpreis-Fallback)' : 'Flexpreis';
    }

    offers.push(offer({
      provider: 'db', providerLabel: 'DB',
      operator: vm?.überName || vm?.name || 'Deutsche Bahn',
      product: vm?.name || vm?.kategorie || null,
      departure: dep, arrival: arr,
      price: typeof price === 'number' ? price : null,
      currency: v.angebotsPreis?.waehrung || 'EUR',
      fareType: fareLabel,
      url: `https://www.bahn.de/buchung?from=${encodeURIComponent(v.segments?.[0]?.origin?.name || v.verbindungsAbschnitte?.[0]?.abfahrtsOrt || '')}&to=${encodeURIComponent(v.verbindungsAbschnitte?.[0]?.ankunftsOrt || '')}`,
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
  const fromId = await resolve(from); const toId = await resolve(to);
  if (!fromId || !toId) {
    // Station not resolvable for DB (no EVA). SBB resolves it and covers the route → not an error.
    return { status: 'empty', error: `db: no EVA mapping for ${from}(${fromId||'?'})/${to}(${toId||'?'}) - SBB übernimmt die Strecke` };
  }
  const whenDate = new Date(when);

  // 0) Web fare API via Oxylabs (real prices). EVA IDs resolve from the same map / RIS::Stations.
  const wf = await tryWebFares(fromId, toId, whenDate, sparpreis, age, bahncard);
  if (wf.verbindungen) {
    const offers = parseWebFares(wf.verbindungen, sparpreis);
    if (offers.length > 0) {
      return { status: 'ok', offers, meta: { source: 'web-fares-oxy', note: sparpreis ? 'Sparpreis' : 'Flexpreis' } };
    }
  }
  if (wf.error || wf.blocked) console.log(`[db] web-fares: ${wf.error || 'blocked ' + wf.status} → fallback`);

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
