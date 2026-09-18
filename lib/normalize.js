export function offer({provider, providerLabel, operator, product, departure, arrival, price, currency = 'EUR', url = null, bookedOut = false}) {
  const dep = departure ? new Date(departure) : null;
  const arr = arrival ? new Date(arrival) : null;
  const durationMin = dep && arr ? Math.max(0, Math.round((arr - dep) / 60000)) : null;
  return {
    provider,
    providerLabel,
    operator: operator || providerLabel,
    product: product || null,
    departure: dep ? dep.toISOString() : null,
    arrival: arr ? arr.toISOString() : null,
    durationMin,
    price: typeof price === 'number' ? price : null,
    currency,
    bookedOut: !!bookedOut,
    url,
  };
}

export function cheapestOrNull(tickets, currency = 'EUR') {
  if (!Array.isArray(tickets) || tickets.length === 0) return null;
  let best = null;
  for (const t of tickets) {
    const meta = t && t.tariff && t.tariff.amount !== undefined
      ? { amount: t.tariff.amount, currency: t.tariff.currency || currency, name: t.name }
      : null;
    if (meta && meta.amount != null) {
      if (!best || meta.amount < best.amount) best = meta;
    }
  }
  return best;
}