import { offer } from '../lib/normalize.js';

// SBB (CH) via transport.opendata.ch - community API, no auth, real timetable
// No fare data in this API -> price: null + link to sbb.ch booking
const BASE = 'https://transport.opendata.ch/v1/connections';
const UA = 'fare-comparator@https://sillytransfem.online (personal fare monitoring)';

function toIso(t) {
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function search({ from, to, when }) {
  try {
    const whenDate = new Date(when);
    const params = new URLSearchParams({
      from, to,
      time: `${String(whenDate.getHours()).padStart(2, '0')}:${String(whenDate.getMinutes()).padStart(2, '0')}`,
      date: whenDate.toISOString().slice(0, 10),
      limit: '4',
    });
    const res = await fetch(`${BASE}?${params}`, { headers: { 'user-agent': UA } });
    if (res.status === 403) return { status: 'blocked', error: 'sbb blocked datacenter IP' };
    if (!res.ok) return { status: 'error', error: `sbb http ${res.status}` };
    const json = await res.json();
    const conns = Array.isArray(json.connections) ? json.connections : [];

    const offers = [];
    for (const c of conns) {
      const sec0 = c.sections && c.sections.find((s) => s.journey && s.journey.category) || (c.sections && c.sections[0]);
      const journey = sec0 && sec0.journey;
      const operator = journey && journey.operator && journey.operator.name ? journey.operator.name : null;
      const product = journey && journey.category ? (journey.number ? `${journey.category} ${journey.number}` : journey.category) : null;
      offers.push(offer({
        provider: 'sbb', providerLabel: 'CH SBB',
        operator: operator || 'SBB CFF FFS',
        product,
        departure: c.from && c.from.departure, arrival: c.to && c.to.arrival,
        price: null, currency: 'CHF',
        bookedOut: false,
        url: `https://www.sbb.ch/fahrplan?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      }));
    }
    offers.sort((a, b) => (a.departure || '').localeCompare(b.departure || ''));
    return { status: 'ok', offers, meta: { source: 'transport.opendata.ch', note: 'timetable-only, price via sbb.ch booking' } };
  } catch (err) {
    return { status: 'error', error: err && err.message ? err.message : String(err) };
  }
}