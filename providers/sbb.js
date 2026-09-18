import { randomUUID } from 'node:crypto';
import { offer } from '../lib/normalize.js';

// SBB (CH) via the public graphql.www.sbb.ch API used by www.sbb.ch itself.
// No login, no captcha. Delivers timetable AND prices (amount in cent, CHF).
// Endpoint + client headers reverse-engineered from the sbb.ch JS bundle.
const GQL = 'https://graphql.www.sbb.ch/graphql';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36';
const CLIENT = {
  'Content-Type': 'application/json',
  Accept: 'application/graphql-response+json',
  'apollographql-client-name': 'sbb-website',
  'apollographql-client-version': '18.1.0',
  'apollographql-client-origin': 'https://www.sbb.ch',
  Origin: 'https://www.sbb.ch',
  Referer: 'https://www.sbb.ch/de',
  'User-Agent': UA,
};

const TRANSPORT_MODES = [
  'REGIO', 'INTERCITY', 'INTERREGIO', 'HIGH_SPEED_TRAIN', 'URBAN_TRAIN',
  'TRAMWAY', 'BUS', 'SHIP', 'CABLEWAY_GONDOLA_CHAIRLIFT_FUNICULAR', 'SPECIAL_TRAIN',
];

// Local services: covered by Deutschlandticket (and similar national flat passes) → no price query.
const LOCAL_MODES = new Set(['REGIO', 'URBAN_TRAIN', 'TRAMWAY', 'BUS', 'SHIP', 'CABLEWAY_GONDOLA_CHAIRLIFT_FUNICULAR']);
// Long-distance running numbers (train-class horarium, railsystem runs the whole route fare).
const LONG_DISTANCE_PREFIXES = new Set(['ICE', 'IC', 'EC', 'EN', 'NJ', 'EJC', 'TGV', 'IEC', 'THA', 'EUR', 'RJ', 'WB', 'CNL', 'FLX', 'D']);

// German/foreign trips report vehicleMode 'TRAIN'; classify by product name prefix.
function isLocal(product) {
  const mode = product && product.vehicleMode;
  if (mode && mode !== 'TRAIN') return LOCAL_MODES.has(mode);
  const name = (product && product.name || '').split(/\s+/)[0].toUpperCase();
  return !LONG_DISTANCE_PREFIXES.has(name);
}

const PLACE_CACHE = new Map();

// Station name suggestions for the search box (STOP_PLACES only)
export async function suggest(q, limit = 10) {
  if (!q || q.trim().length < 2) return [];
  const data = await gql(FIND_PLACE, {
    language: 'DE',
    placeTypes: ['STOP_PLACES'],
    input: { value: q.trim(), type: 'NAME' },
    limit,
  });
  return Array.isArray(data.places) ? data.places.map((p) => ({ id: p.id, name: p.name })) : [];
}

async function gql(query, variables) {
  const res = await fetch(GQL, {
    method: 'POST',
    headers: CLIENT,
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw Object.assign(new Error(`sbb graphql http ${res.status}: ${body.slice(0, 200)}`), { code: 'HTTP' });
  }
  const json = await res.json();
  if (json.errors && !json.data) {
    const first = json.errors[0];
    throw new Error(`sbb graphql error: ${first && first.message} (${first && first.extensions && first.extensions.code})`);
  }
  return json.data;
}

const FIND_PLACE = `query BVIMapPlaces($language: LanguageEnum!, $placeTypes: [PlaceType!], $input: PlaceInput, $limit: PositiveInt) {
  places(language: $language, placeTypes: $placeTypes, input: $input, limit: $limit) { id name }
}`;

// SBB "place id" (7-digit UIC station number without country prefix), e.g. Zürich HB → 8503000
async function resolvePlace(name) {
  if (PLACE_CACHE.has(name)) return PLACE_CACHE.get(name);
  const data = await gql(FIND_PLACE, {
    language: 'DE',
    placeTypes: ['STOP_PLACES'],
    input: { value: name, type: 'NAME' },
    limit: 8,
  });
  const places = Array.isArray(data.places) ? data.places : [];
  const q = name.trim().toLowerCase();
  const pick = places.find((p) => p.name && p.name.trim().toLowerCase() === q) || places[0];
  const id = pick && pick.id ? pick.id : null;
  PLACE_CACHE.set(name, id);
  return id;
}

const TRIPS = `query Trips($input: TripInput!, $language: LanguageEnum!) {
  trips(tripInput: $input, language: $language) {
    trips {
      id
      valid
      isBuyable
      summary {
        duration
        arrival { time delay }
        lastStopPlace { id name }
        departure { time delay }
        firstStopPlace { id name }
        product { name line number vehicleMode }
        direction
        international
      }
      legs {
        duration
        __typename
        ... on PTRideLeg {
          start { id name }
          end { id name }
          departure { time delay }
          arrival { time delay }
          serviceJourney {
            direction
            serviceProducts { name line number vehicleMode }
          }
        }
      }
    }
  }
}`;

// Extract the ordered train chain per trip (PTRideLeg serviceProducts).
function tripServices(t) {
  const rides = [];
  for (const leg of Array.isArray(t.legs) ? t.legs : []) {
    if (leg.__typename !== 'PTRideLeg') continue;
    const sp = leg.serviceJourney && leg.serviceJourney.serviceProducts;
    if (Array.isArray(sp)) for (const p of sp) if (p) rides.push(p);
  }
  return rides;
}

const TRIP_PRICES = `query TripPrices($processId: ID!, $input: TripPricesQueryInput!) {
  tripPrices(processId: $processId, input: $input) {
    tripId
    tripPrices {
      price { amount currency }
      travelClass
      afterSaleFlexibility
    }
    bookingSystem
  }
}`;

export async function search({ from, to, when }) {
  try {
    const [fromId, toId] = await Promise.all([resolvePlace(from), resolvePlace(to)]);
    if (!fromId || !toId) return { status: 'error', error: `sbb station not resolved: ${from} (${fromId || '?'}) / ${to} (${toId || '?'})` };
    const whenDate = new Date(when);

    const tripsData = await gql(TRIPS, {
      input: {
        places: [
          { type: 'ID', value: fromId },
          { type: 'ID', value: toId },
        ],
        time: {
          date: whenDate.toISOString().slice(0, 10),
          time: `${String(whenDate.getHours()).padStart(2, '0')}:${String(whenDate.getMinutes()).padStart(2, '0')}`,
          type: 'DEPARTURE',
        },
        includeTransportModes: TRANSPORT_MODES,
      },
      language: 'DE',
    });
    const trips = tripsData && tripsData.trips && Array.isArray(tripsData.trips.trips)
      ? tripsData.trips.trips.filter((t) => t && t.summary)
      : [];
    if (trips.length === 0) return { status: 'empty', error: 'sbb: no trips returned' };

// Prices: only long-distance modes, always reductions NONE = full price (no Halbtax).
    // Local modes (RB/RE/S-Bahn…) are covered by Deutschlandticket → no fare query, note instead.
    let priceMap = new Map();
    const fareTrips = trips
      .slice(0, 10)
      .filter((t) => tripServices(t).some((p) => !isLocal(p)));
    if (fareTrips.length > 0) {
      try {
        const priceData = await gql(TRIP_PRICES, {
          processId: randomUUID(),
          input: {
            fromPlace: trips[0].summary.firstStopPlace.id,
            toPlace: trips[0].summary.lastStopPlace.id,
            travelClass: 'ANY_CLASS',
            tripIds: fareTrips.map((t) => t.id),
            passengers: [{ reductions: ['NONE'] }],
          },
        });
        for (const row of Array.isArray(priceData.tripPrices) ? priceData.tripPrices : []) {
          const picked = Array.isArray(row.tripPrices)
            ? (row.tripPrices.find((p) => p.travelClass === 'SECOND') || row.tripPrices[0])
            : null;
          if (picked && picked.price && typeof picked.price.amount === 'number') {
            priceMap.set(row.tripId, picked.price);
          }
        }
      } catch { /* fares optional */ }
    }

    const offers = trips.slice(0, 6).map((t) => {
      const s = t.summary;
      const product = s.product || {};
      const price = priceMap.get(t.id);
      const services = tripServices(t);
      const modes = services.map((p) => p.vehicleMode).filter(Boolean);
      const mode = modes[0] || product.vehicleMode || null;
      // D-Ticket ONLY if every ride of the chain is local (all-legs check).
      const local = services.length > 0 && services.every((p) => isLocal(p));
      const productName = services.length > 0 ? services.map((p) => p.name).join(' → ') : (product.name || null);
      // Long-distance fare shown (full price, reductions NONE = no Halbtax) when any leg is long-distance.
      const fare = !local && price ? price.amount / 100 : null;
      const hasFlx = services.some((p) => (p.name || '').startsWith('FLX '));
      let note = null;
      if (local) note = 'im Deutschlandticket';
      else if (hasFlx && !price) note = 'Preis via flixtrain.de (nicht über SBB buchbar)';
      const depTime = s.departure && s.departure.time ? new Date(s.departure.time) : null;
      const datePart = depTime ? depTime.toISOString().slice(0, 10) : '';
      const timePart = depTime ? `${String(depTime.getUTCHours()).padStart(2, '0')}:${String(depTime.getUTCMinutes()).padStart(2, '0')}` : '';
      const fstop = s.firstStopPlace || {};
      const lstop = s.lastStopPlace || {};
      // Official SBB deep-link format (stops JSON array + date/time, RFC-3986 encoded)
      const url = 'https://www.sbb.ch/de?' + [
        `stops=${encodeURIComponent(JSON.stringify([{ value: fstop.id || fromId, type: 'ID', label: fstop.name || from }, { value: lstop.id || toId, type: 'ID', label: lstop.name || to }]))}`,
        datePart && `date=${encodeURIComponent(`"${datePart}"`)}`,
        timePart && `time=${encodeURIComponent(`"${timePart}"`)}`,
        `moment=${encodeURIComponent('"DEPARTURE"')}`,
      ].filter(Boolean).join('&');
      return offer({
        provider: 'sbb', providerLabel: 'CH SBB',
        operator: mode ? { HIGH_SPEED_TRAIN: 'SBB', INTERCITY: 'SBB IC', INTERREGIO: 'SBB IR', REGIO: 'SBB Regio', SHIP: 'SBB Schifffahrt' }[mode] || 'SBB' : null,
        product: productName,
        departure: s.departure && s.departure.time, arrival: s.arrival && s.arrival.time,
        durationMin: s.duration,
        price: fare,
        currency: price ? price.currency : 'CHF',
        bookedOut: !local && !price && !hasFlx,
        note,
        url,
      });
    });
    return { status: 'ok', offers, meta: { source: 'graphql.www.sbb.ch', note: 'prices in CHF (SBB standard fare)' } };
  } catch (err) {
    if (err && err.code === 'HTTP') return { status: 'blocked', error: `sbb graphql: ${err.message}` };
    return { status: 'error', error: err && err.message ? err.message : String(err) };
  }
}