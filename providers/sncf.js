import { offer } from '../lib/normalize.js';

const BOOKING_BASE = 'https://www.sncf-connect.com/train/schedule';

export async function search({ from, to, when }) {
  const whenDate = when instanceof Date ? when : new Date(when);
  const dateStr = whenDate.toISOString().slice(0, 10);
  const timeStr = `${String(whenDate.getHours()).padStart(2, '0')}:${String(whenDate.getMinutes()).padStart(2, '0')}`;

  const url = `${BOOKING_BASE}?origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}&date=${dateStr}T${timeStr}`;

  try {
    const navitiaUrl = `https://api.navitia.io/v1/coverage/fr-idf/journeys?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&datetime=${dateStr}T${timeStr}`;
    const r = await fetch(navitiaUrl, {
      headers: { 'Accept': 'application/json' },
    });

    if (!r.ok) {
      return {
        status: 'ok',
        offers: [offer({
          provider: 'sncf', providerLabel: 'SNCF',
          operator: 'SNCF',
          product: 'TGV/TER',
          departure: `${dateStr}T${timeStr}:00`,
          price: null,
          url,
        })],
        meta: { source: 'sncf-link', note: 'SNCF requires API key for prices' },
      };
    }

    const d = await r.json();
    const journeys = d.journeys || [];

    const offers = journeys.slice(0, 6).map(j => {
      const sections = j.sections || [];
      const first = sections[0] || {};
      const last = sections[sections.length - 1] || {};
      const displayDeparture = first.departure_date || first.end_datetime || `${dateStr}T${timeStr}`;
      const displayArrival = last.arrival_date || last.end_datetime || null;

      let price = null;
      if (j.price?.amount) price = parseFloat(j.price.amount);

      const durationMs = j.duration ? j.duration * 1000 : null;
      const durationMin = durationMs ? Math.round(durationMs / 60000) : null;

      let productName = 'TGV';
      if (sections.length > 0) {
        const sec = sections.find(s => s.display_informations?.commercial_mode) || sections[0];
        productName = sec?.display_informations?.commercial_mode || sec?.display_informations?.label || 'TGV';
      }

      return offer({
        provider: 'sncf', providerLabel: 'SNCF',
        operator: productName,
        product: productName,
        departure: displayDeparture,
        arrival: displayArrival,
        durationMin,
        price, currency: price != null ? 'EUR' : undefined,
        url,
      });
    }).filter(o => o);

    if (offers.length === 0) {
      offers.push(offer({
        provider: 'sncf', providerLabel: 'SNCF',
        operator: 'SNCF', product: 'TGV/TER',
        departure: `${dateStr}T${timeStr}:00`,
        price: null, url,
      }));
    }

    return { status: 'ok', offers, meta: { source: 'sncf-navitia' } };
  } catch (err) {
    return {
      status: 'ok',
      offers: [offer({
        provider: 'sncf', providerLabel: 'SNCF',
        operator: 'SNCF', product: 'TGV/TER',
        departure: `${dateStr}T${timeStr}:00`,
        price: null, url,
      })],
      meta: { source: 'sncf-link', note: err.message?.slice(0, 80) },
    };
  }
}
