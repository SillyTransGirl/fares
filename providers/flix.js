import { offer } from '../lib/normalize.js';
import { ProxyAgent } from 'undici';

// FlixBus/FlixTrain via the public mobile endpoints the Flix apps use.
//  - GET /search/autocomplete/cities  → resolve city → numeric legacy_id
//  - GET /mobile/v1/trip/search.json  → trips[*].items = bookable connections
// The mobile headers are reverse-engineered from Flix's own traffic; the
// auth token is the public mobile client token. Blocks plain datacenter IPs,
// so requests go out through the MaskLabs SOCKS5 tunnel (fare-tunnel.service,
// :1081) when available → PROXY_URL env override.
const AUTOCOMPLETE_URL = 'https://global.api.flixbus.com/search/autocomplete/cities';
const TRIP_URL = 'https://global.api.flixbus.com/mobile/v1/trip/search.json';
const MOBILE_AUTH = 'k8LKgcuFoHnN5x/NdDYD6QSvjB4=';
const MOBILE_UA = 'FlixBus/7.55.0 (iPhone; iOS 16.5; Scale/2.00)';

const PROXY_URL = process.env.PROXY_URL || 'socks5://127.0.0.1:1081';
const dispatcher = new ProxyAgent(PROXY_URL);

let proxyDead = false;

async function proxiedFetch(url, opts = {}) {
  if (proxyDead) return fetch(url, opts); // tunnel down → direct (will likely 403)
  try {
    return await fetch(url, { ...opts, dispatcher });
  } catch {
    proxyDead = true;
    return fetch(url, opts);
  }
}

const CITY_CACHE = new Map();

function pickLegacy(list, q) {
  const arr = Array.isArray(list) ? list : [];
  const ql = q.trim().toLowerCase();
  // prefer exact city match, fall back to first
  const exact = arr.find((c) => c && c.name && c.name.trim().toLowerCase() === ql);
  const any = exact || arr.find((c) => c && c.name) || null;
  return any && any.legacy_id != null ? any.legacy_id : null;
}

// Resolve a city (or station) name to a numeric Flix id for trip search.
export async function resolveCity(q) {
  if (CITY_CACHE.has(q)) return CITY_CACHE.get(q);
  const url = `${AUTOCOMPLETE_URL}?q=${encodeURIComponent(q)}&lang=en&country=DE&flixbus_cities_only=true&is_train_only=false&stations=false&popular_stations=false`;
  const res = await proxiedFetch(url, {
    headers: { 'user-agent': MOBILE_UA, 'x-user-country': 'de', 'accept-language': 'de-DE' },
  });
  if (!res.ok) throw Object.assign(new Error(`flix autocomplete http ${res.status}`), { code: 'HTTP' });
  const json = await res.json();
  const id = pickLegacy(json, q);
  CITY_CACHE.set(q, id);
  return id;
}

function tsToIso(ts) {
  // mobile API returns unix seconds (absolute); tz is informational
  return typeof ts === 'number' ? new Date(ts * 1000).toISOString() : null;
}

export async function search({ from, to, when }) {
  try {
    const [fromId, toId] = await Promise.all([resolveCity(from), resolveCity(to)]);
    if (!fromId || !toId) return { status: 'error', error: `flix cities not resolved: ${from} / ${to}` };

    const date = new Date(when);
    const departureDate = `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;

    const url = `${TRIP_URL}?from=${fromId}&to=${toId}&departure_date=${departureDate}&search_by=cities&currency=EUR&adult=1&children=0`;
    const res = await proxiedFetch(url, {
      headers: {
        'user-agent': MOBILE_UA,
        'x-api-authentication': MOBILE_AUTH,
        'x-user-country': 'de',
        'accept-language': 'de-DE',
        accept: 'application/json',
      },
    });
    if (res.status === 403) return { status: 'blocked', error: 'flix mobile API 403 (Tunnel down? PROXY_URL?)' };
    if (!res.ok) return { status: 'error', error: `flix http ${res.status}` };

    const json = await res.json();
    const trips = Array.isArray(json.trips) ? json.trips : [];
    const offers = [];
    for (const trip of trips) {
      const stationFrom = (trip.from && trip.from.name) || from;
      const stationTo = (trip.to && trip.to.name) || to;
      for (const it of Array.isArray(trip.items) ? trip.items : []) {
        const seats = it.available && typeof it.available.seats === 'number' ? it.available.seats : 0;
        if (seats <= 0) continue;
        const price = typeof it.price_total_sum === 'number' ? it.price_total_sum : null;
        const operatorList = Array.isArray(it.operated_by) ? it.operated_by.map((o) => o && o.label).filter(Boolean) : [];
        const isTrain = /train/.test(it.transfer_type_key || '');
        const operator = operatorList[0] || (isTrain ? 'FlixTrain GmbH' : 'FlixBus');
        const depIso = tsToIso(it.departure && it.departure.timestamp);
        const arrIso = tsToIso(it.arrival && it.arrival.timestamp);
        offers.push(offer({
          provider: 'flix', providerLabel: 'Flix',
          operator: isTrain ? 'FlixTrain' : 'FlixBus',
          product: `${isTrain ? 'FLX' : 'FlixBus'} ${stationFrom} → ${stationTo}`,
          departure: depIso, arrival: arrIso,
          price,
          currency: 'EUR',
          bookedOut: price == null,
          url: `https://shop.flixbus.com/search?from_city_id=${fromId}&to_city_id=${toId}&rideDate=${date.toISOString().slice(0, 10)}&adult=1`,
        }));
      }
    }
    // dedupe same departure+destination+price, keep the full price range
    const seen = new Set();
    const uniq = offers.filter((o) => {
      const k = `${o.departure}|${o.product}|${o.price}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    uniq.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    return { status: 'ok', offers: uniq.slice(0, 10) };
  } catch (err) {
    if (err && err.code === 'HTTP') return { status: 'blocked', error: `flix city autocomplete: ${err.message}` };
    return { status: 'error', error: err && err.message ? err.message : String(err) };
  }
}