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

const PLACE_CACHE = new Map();

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
    }
  }
}`;

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

    // Prices for up to 10 trips in one call (amounts in cent, CHF)
    let priceMap = new Map();
    try {
      const priceData = await gql(TRIP_PRICES, {
        processId: randomUUID(),
        input: {
          fromPlace: trips[0].summary.firstStopPlace.id,
          toPlace: trips[0].summary.lastStopPlace.id,
          travelClass: 'ANY_CLASS',
          tripIds: trips.slice(0, 10).map((t) => t.id),
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

    const offers = trips.slice(0, 6).map((t) => {
      const s = t.summary;
      const product = s.product || {};
      const price = priceMap.get(t.id);
      const mode = product.vehicleMode || null;
      return offer({
        provider: 'sbb', providerLabel: 'CH SBB',
        operator: mode ? { HIGH_SPEED_TRAIN: 'SBB', INTERCITY: 'SBB IC', INTERREGIO: 'SBB IR', REGIO: 'SBB Regio', SHIP: 'SBB Schifffahrt' }[mode] || 'SBB' : null,
        product: product.name || null,
        departure: s.departure && s.departure.time, arrival: s.arrival && s.arrival.time,
        durationMin: s.duration,
        price: price ? price.amount / 100 : null,
        currency: price ? price.currency : 'CHF',
        bookedOut: !price,
        url: `https://www.sbb.ch/fahrplan?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      });
    });
    return { status: 'ok', offers, meta: { source: 'graphql.www.sbb.ch', note: 'prices in CHF (SBB standard fare)' } };
  } catch (err) {
    if (err && err.code === 'HTTP') return { status: 'blocked', error: `sbb graphql: ${err.message}` };
    return { status: 'error', error: err && err.message ? err.message : String(err) };
  }
}