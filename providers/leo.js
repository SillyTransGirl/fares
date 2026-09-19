import { offer } from '../lib/normalize.js';

// LEO Express provider — GraphQL API at graph.leoexpress.com
// No auth required for search. Covers CZ, PL, SK, DE, AT, HU routes.
const GRAPHQL_URL = 'https://graph.leoexpress.com/le';

const SEARCH_QUERY = `query searchResults($from: String, $to: String, $date: String, $persons: [RateArgument], $services: [ServiceArgument], $currency: String, $timestamp: Int, $locale: String, $token: String, $platform: String) {
  searchResults(from: $from, to: $to, date: $date, persons: $persons, services: $services, currency: $currency, timestamp: $timestamp, locale: $locale, token: $token, platform: $platform) {
    return_msg
    return_code
    connections {
      origin { id name }
      destination { id name }
      departure
      arrival
      traveltime
      totaltime
      lines {
        line_id
        origin
        destination
        departure
        arrival
        type
        carrier_id
        class_info {
          record_id
          capacity
          rates { price }
          passengers
        }
      }
      classes { id short name }
      hash
      msg
    }
    error { code message }
  }
}`;

const STATIONS_QUERY = `query stations($locale: String, $token: String, $platform: String) {
  stations(locale: $locale, token: $token, platform: $platform) {
    id
    name
    name_master
    country
    gps_lat
    gps_lon
    type
  }
}`;

function buildHeaders() {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0',
    'Origin': 'https://www.leoexpress.com',
    'Referer': 'https://www.leoexpress.com/',
  };
}

async function searchLeogram(from, to, dateStr, currency = 'EUR') {
  // dateStr format: DD.MM.YYYY
  const date = dateStr.split('-').reverse().join('.');
  const timestamp = Math.floor(Date.now() / 1000);

  const body = {
    query: SEARCH_QUERY,
    variables: {
      from: from,
      to: to,
      date: date,
      persons: [
        { name: 'adult', cards: [] },
      ],
      services: [],
      currency: currency,
      timestamp: timestamp,
      locale: 'de',
      token: null,
      platform: 'website',
    },
  };

  try {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });

    if (!res.ok) return { error: `leo: HTTP ${res.status}` };
    const json = await res.json();
    const sr = json?.data?.searchResults;
    if (!sr) return { error: 'leo: no searchResults' };
    if (sr.error) return { error: `leo: ${sr.error.message || sr.error.code}` };

    const connections = sr.connections || [];
    return { connections };
  } catch (e) {
    return { error: `leo: ${e.message?.slice(0, 120)}` };
  }
}

function parseLeogramConnections(connections) {
  const offers = [];
  for (const c of connections.slice(0, 8)) {
    if (c.error) continue;

    const lines = c.lines || [];
    const product = lines.map(l => l.line_id).join(' → ') || 'Leo Express';
    const operator = 'Leo Express';

    // Get price from cheapest class
    let price = null;
    let currency = 'EUR';
    let className = null;
    for (const cls of (c.classes || [])) {
      const lineCls = lines[0]?.class_info?.find(ci => ci.record_id === cls.id);
      if (lineCls?.rates?.length) {
        const minRate = Math.min(...lineCls.rates.map(r => r.price || Infinity));
        if (minRate < Infinity) {
          price = minRate;
          className = cls.name || cls.short;
          break;
        }
      }
    }

    offers.push(offer({
      provider: 'leo',
      providerLabel: 'LEO',
      operator: operator,
      product: product,
      departure: c.departure,
      arrival: c.arrival,
      price: price,
      currency: currency,
      fareType: className,
      url: 'https://www.leoexpress.com/en',
    }));
  }
  return offers;
}

// EVA to LEO station ID mapping for common German stations
const EVA_TO_LEO = {
  '8011160': 'BERLIN',       // Berlin Hbf
  '8002549': 'HAMBURK',      // Hamburg Hbf
  '8000261': 'MNICHOV',      // München Hbf
  '8000105': 'FRANKFURT_NAD_M', // Frankfurt(Main)Hbf
  '8000207': 'KOLYN_NAD_R',  // Köln Hbf
  '8010205': 'LIPSK',        // Leipzig Hbf
  '8010085': 'DRÁŽĎANY',     // Dresden Hbf
  '5400001': 'PRAHA',        // Praha
  '8000284': 'NÜRNBERK',     // Nürnberg Hbf
  '8000096': 'STUTGART',     // Stuttgart Hbf
};

function leoStationId(evaOrName) {
  if (EVA_TO_LEO[evaOrName]) return EVA_TO_LEO[evaOrName];
  if (/^\d{5,8}$/.test(evaOrName)) return evaOrName; // EVA codes work directly
  return evaOrName; // Pass as-is (LEO accepts station names)
}

export async function search({ from, to, when }) {
  const whenDate = new Date(when);
  const pad = n => String(n).padStart(2, '0');
  const dateStr = `${whenDate.getFullYear()}-${pad(whenDate.getMonth()+1)}-${pad(whenDate.getDate())}`;

  // Try to get LEO station IDs from EVA map
  const db = await import('./db.js');
  const fromEva = await db.resolve(from);
  const toEva = await db.resolve(to);

  const fromLeo = leoStationId(fromEva || from);
  const toLeo = leoStationId(toEva || to);

  const result = await searchLeogram(fromLeo, toLeo, dateStr);
  if (result.error) {
    return { status: 'error', error: result.error, offers: [] };
  }
  const offers = parseLeogramConnections(result.connections || []);
  return { status: 'ok', offers, meta: { source: 'leo-graphql' } };
}
