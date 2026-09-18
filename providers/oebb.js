import { createClient } from 'hafas-client';
import { profile as oebb } from 'hafas-client/p/oebb/index.js';
import { offer, cheapestOrNull } from '../lib/normalize.js';

const client = createClient(oebb, 'fare-comparator@https://sillytransfem.online (personal fare monitoring)');
const STATION_CACHE = new Map();

async function resolve(name) {
  if (STATION_CACHE.has(name)) return STATION_CACHE.get(name);
  const res = await client.locations(name, { results: 1 });
  const st = Array.isArray(res) ? res[0] : null;
  const id = st && st.id ? st.id : null;
  STATION_CACHE.set(name, id);
  return id;
}

export async function search({ from, to, when }) {
  const [fromId, toId] = await Promise.all([resolve(from), resolve(to)]);
  if (!fromId || !toId) return { status: 'error', error: `station(s) not resolved: ${from} / ${to}` };

  const journeys = await client.journeys(fromId, toId, { departure: when, results: 4, tickets: false });
  const list = (journeys && journeys.journeys) || journeys || [];

  const offers = [];
  for (const j of list.slice(0, 3)) {
    let price = null, currency = 'EUR';
    try {
      const detailed = await client.refreshJourney(j.refreshToken, { tickets: true, stopovers: false });
      const jr = detailed && detailed.journey ? detailed.journey : detailed;
      const best = cheapestOrNull(jr.tickets);
      price = best ? best.amount : null;
      currency = best ? best.currency : 'EUR';
    } catch { /* fare quote failed, timetable only */ }
    const leg0 = j.legs && j.legs.find((l) => l && l.mode === 'train') || (j.legs && j.legs[0]);
    const firstLeg = j.legs && j.legs[0];
    const lastLeg = j.legs && j.legs[j.legs.length - 1];
    offers.push(offer({
      provider: 'oebb', providerLabel: 'ÖBB',
      operator: leg0 && leg0.line && leg0.line.operator && leg0.line.operator.name ? leg0.line.operator.name : 'ÖBB',
      product: leg0 && leg0.line ? leg0.line.name : null,
      departure: firstLeg ? firstLeg.departure : null, arrival: lastLeg ? lastLeg.arrival : null,
      price, currency,
      url: 'https://www.oebb.at',
    }));
  }
  return { status: 'ok', offers };
}