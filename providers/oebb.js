import { offer } from '../lib/normalize.js';

const HAFAS_URL = 'https://fahrplan.oebb.at/bin/mgate.exe';
const BOOKING_BASE = 'https://shop.oebbtickets.at/';

const EVA = new Map([
  ['wien hbf', '8103000'], ['wien westbahnhof', '8100207'], ['wien', '8103000'],
  ['salzburg hbf', '8100002'], ['salzburg', '8100002'],
  ['graz hbf', '8100174'], ['graz', '8100174'],
  ['linz hbf', '8100207'], ['linz/donau hbf', '8100207'], ['linz', '8100207'],
  ['innsbruck hbf', '8100236'], ['innsbruck', '8100236'],
  ['klagenfurt hbf', '8100265'], ['klagenfurt', '8100265'],
  ['villach hbf', '8100359'], ['villach', '8100359'],
  ['bregenz hbf', '8100112'], ['bregenz', '8100112'],
  ['dornbirn hbf', '8100113'], ['feldkirch hbf', '8100126'],
  ['st. pölten hbf', '8100492'], ['st poelten hbf', '8100492'],
  ['leoben hbf', '8100281'], ['knittelfeld hbf', '8100266'],
  ['wörgl hbf', '8100603'], ['kufstein hbf', '8100274'],
  ['münchen hbf', '8000261'], ['muenchen hbf', '8000261'], ['munich', '8000261'],
  ['berlin hbf', '8011160'], ['hamburg hbf', '8002549'],
  ['frankfurt hbf', '8000105'], ['frankfurt(main)hbf', '8000105'],
  ['zürich hb', '8503000'], ['zurich hb', '8503000'],
  ['praha', '5400014'], ['prague', '5400014'],
  ['budapest keleti', '5501162'], ['budapest', '5501162'],
  ['venezia', '8300046'], ['venice', '8300046'],
  ['ljubljana', '7940105'], ['split', '7940110'],
  ['amsterdam', '8400058'], ['paris', '8727100'],
]);

function resolveLid(name) {
  const key = name.toLowerCase().trim();
  const eva = EVA.get(key);
  if (eva) return `A=1@O=${name}@L=${eva}@`;
  return `A=1@O=${name}@`;
}

function parseTime(t) {
  if (!t || t.length < 6) return null;
  return `${t.slice(0, 2)}:${t.slice(2, 4)}`;
}

function parseDuration(d) {
  if (!d || d.length < 6) return null;
  return parseInt(d.slice(0, 2), 10) * 60 + parseInt(d.slice(2, 4), 10);
}

function isoDate(cDate, time) {
  if (!cDate || !time) return null;
  return `${cDate.slice(0, 4)}-${cDate.slice(4, 6)}-${cDate.slice(6, 8)}T${time}:00`;
}

export async function search({ from, to, when }) {
  const depLid = resolveLid(from);
  const arrLid = resolveLid(to);
  const whenDate = when instanceof Date ? when : new Date(when);
  const dateStr = whenDate.toISOString().slice(0, 10).replace(/-/g, '');
  const timeStr = `${String(whenDate.getHours()).padStart(2, '0')}${String(whenDate.getMinutes()).padStart(2, '0')}00`;

  try {
    const r = await fetch(HAFAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ver: '1.54', lang: 'deu',
        auth: { type: 'AID', aid: 'OWDL4fE4ixNiPBBm' },
        client: { id: 'OEBB', type: 'IPH', name: 'oebbADHOC', v: '6020300' },
        formatted: false,
        svcReqL: [{
          req: {
            depLocL: [{ lid: depLid, type: 'S' }],
            arrLocL: [{ lid: arrLid, type: 'S' }],
            jnyFltrL: [{ type: 'PROD', mode: 'INC', value: '1023' }],
            outDate: dateStr, outTime: timeStr, outFrwd: true, numF: 6,
          },
          meth: 'TripSearch',
        }],
      }),
    });
    if (!r.ok) return { status: 'error', error: `oebb: HTTP ${r.status}` };
    const d = await r.json();
    const res = d?.svcResL?.[0]?.res;
    if (!res) return { status: 'error', error: 'oebb: empty response' };

    const cons = res.outConL || [];
    const prods = res.common?.prodL || [];

    const offers = cons.map(c => {
      const prodX = c.secL?.find(s => s.type === 'JNY')?.jny?.prodX ?? 0;
      const prod = prods[prodX];
      const prodName = prod?.name || prod?.prodCtx?.line || 'ÖBB';
      const cDate = c.date || dateStr;

      const depTime = parseTime(c.dep?.dTimeS);
      const arrTime = parseTime(c.arr?.aTimeS);

      let price = null;
      const trf = c.trfRes || {};
      if (trf.faresCA?.length) {
        price = trf.faresCA[0]?.tC?.[0]?.pF?.[0]?.p ?? trf.faresCA[0]?.tC?.[0]?.p ?? null;
      }

      const bookingUrl = `${BOOKING_BASE}?stationFrom=${encodeURIComponent(from)}&stationTo=${encodeURIComponent(to)}`;

      return offer({
        provider: 'oebb', providerLabel: 'ÖBB',
        operator: 'ÖBB',
        product: prodName,
        departure: isoDate(cDate, depTime),
        arrival: isoDate(cDate, arrTime),
        durationMin: parseDuration(c.dur),
        price, currency: price != null ? 'EUR' : undefined,
        url: bookingUrl,
      });
    }).filter(o => o);

    return { status: 'ok', offers, meta: { source: 'oebb-hafas' } };
  } catch (err) {
    return { status: 'error', error: `oebb: ${err.message?.slice(0, 120)}` };
  }
}
