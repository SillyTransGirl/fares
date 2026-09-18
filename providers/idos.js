import { offer } from '../lib/normalize.js';

const BASE = 'https://idos.cz/vlakyautobusymhdvse';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36';

const OP_RE = /RegioJet|STUDENT AGENCY|České dráhy|ČD|Arriva|Leo|FlixBus|FlixTrain|GW Train|Lear|RailJet|Nightjet|ÖBB|RJX|RJ /g;

function parseConnections(html) {
  const heads = html.split(/class="connection-head"/);
  const rows = [];
  for (const head of heads.slice(1)) {
    const clean = head
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .replace(/<[^>]+>/g, '|')
      .replace(/&[a-z#0-9]+;/gi, '')
      .replace(/\|+/g, '|');

    const raw = [...clean.matchAll(/\|(\d{1,2}:\d{2})\|([^|]{2,60})\|/g)]
      .map((m) => ({ time: m[1], at: m[2].trim() }));

    const dateRow = raw.find((s) => /^\d{1,2}\.\d{1,2}\./.test(s.at));
    let baseYear;
    let baseMonth;
    let baseDay;
    if (dateRow) {
      const dm = dateRow.at.match(/^(\d{1,2})\.(\d{1,2})\./);
      const day = Number(dm[1]);
      const month = Number(dm[2]) - 1;
      let d = new Date(Date.UTC(new Date().getUTCFullYear(), month, day));
      if (d.getTime() < Date.now() - 180 * 86400000) d = new Date(Date.UTC(new Date().getUTCFullYear() + 1, month, day));
      baseYear = d.getUTCFullYear();
      baseMonth = d.getUTCMonth();
      baseDay = d.getUTCDate();
    } else {
      baseYear = new Date().getUTCFullYear();
      baseMonth = new Date().getUTCMonth();
      baseDay = new Date().getUTCDate();
    }

    const stations = raw.filter((s) => !/^\d{1,2}\.\d{1,2}\./.test(s.at) && !/Celkov/.test(s.at));
    const first = stations[0] || null;
    const last = stations.length > 1 ? stations[stations.length - 1] : null;

    const durM = clean.match(/([0-9]{1,3})\s*hod\s*([0-9]{1,2})\s*min/);
    const opM = head.match(OP_RE);
    const vehM = clean.match(/\|([A-Za-z]{1,5}\s?[0-9]{1,5}[0-9A-Za-z ]{0,12})\|/);

    const depTime = first && first.time;
    const arrTime = last && last.time;
    const durationMin = durM ? Number(durM[1]) * 60 + Number(durM[2]) : null;
    const iso = (time, dayOffset = 0) => {
      if (!time) return null;
      const [hh, mm] = time.split(':').map(Number);
      const d = new Date(Date.UTC(baseYear, baseMonth, baseDay + dayOffset, hh, mm));
      return d.toISOString();
    };

    const depIso = iso(depTime);
    let arrIso = iso(arrTime);
    if (depIso && arrIso && new Date(arrIso) < new Date(depIso)) arrIso = iso(arrTime, 1);

    rows.push(offer({
      provider: 'idos', providerLabel: 'CD/IDOS',
      operator: opM ? opM[0].replace(/, a\.s\./g, '') : null,
      product: vehM ? vehM[1].trim() : null,
      departure: depIso, arrival: arrIso,
      departureShort: first && first.at, arrivalShort: last && last.at,
      price: null, currency: 'CZK',
      bookedOut: false,
      url: 'https://idos.cz/vlakyautobusymhdvse/spojeni/',
    }));
  }
  return rows;
}

export async function search({ from, to, when }) {
  try {
    const date = new Date(when);
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');

    const res = await fetch(`${BASE}/spojeni/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'user-agent': UA, accept: 'text/html,*/*' },
      body: `From=${encodeURIComponent(from)}&FromHidden=&To=${encodeURIComponent(to)}&ToHidden=&Date=${dd}.${mm}.${date.getFullYear()}&Time=${hh}:${mi}&IsArr=False&Direction=${encodeURIComponent(from)}%20%E2%9E%9C%20${encodeURIComponent(to)}`,
      redirect: 'follow',
    });
    if (!res.ok) return { status: 'error', error: `idos http ${res.status}` };

    const html = await res.text();
    const offers = parseConnections(html);
    if (offers.length === 0) return { status: 'empty', error: 'idos: no connections parsed (UI changed?)' };
    return { status: 'ok', offers };
  } catch (err) {
    return { status: 'error', error: err && err.message ? err.message : String(err) };
  }
}