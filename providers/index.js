import * as db from './db.js';
import * as flix from './flix.js';
import * as idos from './idos.js';
import * as sbb from './sbb.js';
import { chfToEur } from '../lib/currency.js';

export const PROVIDERS = [
  // SBB first: works reliably, resolves stations via its own GraphQL places API.
  { key: 'sbb', label: 'CH SBB', run: sbb.search },
  { key: 'db', label: 'DB', run: db.search },
  { key: 'flix', label: 'Flix', run: flix.search },
  { key: 'idos', label: 'CD/IDOS', run: idos.search },
];

export async function runAll(params, timeoutMs = 30000) {
  const results = await Promise.allSettled(
    PROVIDERS.map((p) =>
      Promise.race([
        p.run(params).catch((err) => ({ status: 'error', error: err && err.message ? err.message : String(err) })),
        new Promise((res) => setTimeout(() => res({ status: 'timeout', error: 'provider timed out' }), timeoutMs)),
      ]).then((r) => ({ key: p.key, label: p.label, result: r })),
    ),
  );
  const byProvider = new Map(results.map((r) => (r.status === 'fulfilled' ? [r.value.key, r.value.result] : [null, { status: 'error' }])));
  const offers = [];
  for (const p of PROVIDERS) {
    const r = byProvider.get(p.key) || { status: 'error', error: 'provider failed' };
    if (r.status === 'ok' && Array.isArray(r.offers)) offers.push(...r.offers);
  }
  offers.sort((a, b) => toEur(a.price, a.currency) - toEur(b.price, b.currency));
  const statuses = results.map((r) => {
    const v = r.status === 'fulfilled' ? r.value : { key: '?', label: '?', result: { status: 'error' } };
    return { key: v.key, label: v.label, status: v.result.status, error: v.result.error || null, offerCount: (v.result.offers || []).length };
  });
  return { offers, statuses };
}

// Mixed providers use different currencies (SBB=CHF, Flix=EUR). Normalize to EUR for a fair sort.
function toEur(price, currency) {
  if (typeof price !== 'number') return Infinity;
  return currency === 'EUR' ? price : chfToEur(price);
}