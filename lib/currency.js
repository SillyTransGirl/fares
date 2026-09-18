// Currency conversion helpers. Only SBB returns CHF today; EUR is the app default.
// The rate is configurable via ENV (CHF_EUR_RATE, e.g. 1.05 == 1 CHF = 1.05 EUR).
// Note: this module reads process.env lazily at call time so .env (lib/env.js) is honored.
export function chfToEur(amountCHF) {
  if (typeof amountCHF !== 'number') return amountCHF;
  const rate = Number(process.env.CHF_EUR_RATE || 1.05);
  return round2(amountCHF * rate);
}

export function toDisplayPrice(price, currency, target) {
  // target: 'EUR' | 'CHF'
  if (typeof price !== 'number' || !currency) return null;
  if (currency === target) return round2(price);
  if (currency === 'CHF' && target === 'EUR') return chfToEur(price);
  if (currency === 'EUR' && target === 'CHF') {
    const rate = Number(process.env.CHF_EUR_RATE || 1.05);
    return round2(price / rate);
  }
  return round2(price);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}