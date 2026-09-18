import { offer } from '../lib/normalize.js';

const SEARCH_URL = 'https://global.api.flixbus.com/search/service/v4/search';
const CITIES_URL = 'https://global.api.flixbus.com/search/service/v4/cities';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36';

const CITY_CACHE = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function resolveCity(q) {
  if (CITY_CACHE.has(q)) return CITY_CACHE.get(q);
  const url = `${CITIES_URL}?q=${encodeURIComponent(q)}&lang=en&country_code=de`;
  const res = await fetch(url, { headers: { 'user-agent': UA, 'x-requesting-country-code': 'de' } });
  if (!res.ok) throw Object.assign(new Error(`flix city lookup ${res.status}`), { code: 'HTTP' });
  const json = await res.json();
  const first = Array.isArray(json) ? json[0] : (json.cities && json.cities[0]);
  const id = first && first.id;
  CITY_CACHE.set(q, id);
  return id;
}

export async function search({ from, to, when }) {
  let statusPayload = {};
  try {
    const [fromId, toId] = await Promise.all([resolveCity(from), resolveCity(to)]);
    if (!fromId || !toId) return { status: 'error', error: `flix cities not resolved: ${from} / ${to}` };
    const date = new Date(when);
    const departureDate = date.toISOString().replace(/\.[0-9]{3}Z/, 'Z');

    const body = {
      from_city_id: fromId, to_city_id: toId,
      departure_date: departureDate,
      products: { train: true, bus: true, car: false, black: false, bwc: false, transfer: false },
      currency: 'EUR', locale: 'en', search_by: 'cities', type: 'outward',
      passengers: [{ type: 'adult', count: 1 }],
    };
    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA, 'x-requesting-country-code': 'de', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 403) return { status: 'blocked', error: 'flixbus blocked datacenter IP (try WARP egress)' };
    if (!res.ok) return { status: 'error', error: `flix http ${res.status}` };
    statusPayload = { status: 'ok', offers: [] };

    const json = await res.json();
    const trips = (json.trips && json.trips.searches && json.trips.searches[0] && json.trips.searches[0].trip_s) ||
                  (json.trips && json.trips.search && json.trips.search.trip_s) || [];
    const offers = [];
    for (const t of Array.isArray(trips) ? trips : []) {
      const money = t.booking && t.booking.price;
      const departAt = t.departure_date && t.departure_date.replace(' ', 'T');
      const arriveAt = t.arrival_date && t.arrival_date.replace(' ', 'T');
      offers.push(offer({
        provider: 'flix', providerLabel: 'Flix',
        operator: t.vehicle_type === 'train' ? 'FlixTrain' : 'FlixBus',
        product: t.vehicle_type === 'train' ? 'FLX' : 'FlixBus',
        departure: departAt, arrival: arriveAt,
        price: money && money.price != null ? money.price : null,
        currency: money ? money.currency : 'EUR',
        url: `https://shop.flixbus.com/search?from_city_id=${fromId}&to_city_id=${toId}&rideDate=${date.toISOString().slice(0, 10)}&adult=1` + (t.ride_uuid ? `&departure_id=${t.ride_uuid}` : ''),
        bookedOut: !money,
      }));
    }
    offers.sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
    return { status: 'ok', offers };
  } catch (err) {
    if (err && err.code === 'HTTP') return { status: 'blocked', error: 'flix city API unreachable' };
    await sleep(0);
    return { status: 'error', error: err && err.message ? err.message : String(err) };
  }
}