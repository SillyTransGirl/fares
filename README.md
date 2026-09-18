# fares — Multi-Operator European Rail/Bus Fare Comparator

A small Node.js service that queries several European transport providers for
a given route and date, normalizes the results into one unified offer schema,
and serves them on a tiny JSON API with a single-page comparison view.

**Repo:** https://github.com/SillyTransGirl/fares

---

## How it works

```
                              ┌─────────────────────────────────────────────┐
  GET /api/search             │  providers/index.js  runAll()              │
   ──────────►  server.js  ──►│  runs every provider in parallel           │
                              │  with a per-provider timeout (25s)         │
                              │  ┌──────────┬──────────┬───────────┬─────┐  │
                              │  │ DB       │ ÖBB      │ Flix      │ ... │  │
                              │  └────┬─────┴────┬─────┴────┬──────┴─────┘  │
                              │       │          │          │               │
                              └───────┼──────────┼──────────┼───────────────┘
                                      │          │          │
                                official DB    hafas-client  FlixBus/FlixTrain
                                Marketplace    (ÖBB)         search API
                                APIs (no key)  └── fare quotes unreliable / absent
                                      │
                                ├── price: null ──► booking-link fallback
                                └── (RIS::Journeys pending approval)

  Every offer is normalized via lib/normalize.js → one schema:
  { provider, operator, product, departure, arrival, durationMin,
    price, currency, bookedOut, url }
  Offers are sorted cheapest-first. Providers with no price data are kept
  as timetable entries with a booking URL.
```

## Providers

Providers are queried in order **SBB → DB → ÖBB → Flix → idos**. SBB is run first
because it reliably returns both timetable and prices for German and international routes.

| Provider | Data source | Auth | Prices | Notes |
|---|---|---|---|---|
| **CH SBB** (`sbb.js`) | `graphql.www.sbb.ch` — Trips + TripPrices queries | none (Apollo client headers) | ✅ (CHF) | Full train chains (RE/ICE/FLX mix); D-Ticket note on all-local chains; FLX legs priced via `price_total_sum` — booking via flixtrain.de |
| **DB** (`db.js`) | [DB API Marketplace](https://developers.deutschebahn.com) — Timetables 1.0.274 (Free), RIS::Stations | Client ID/Secret (`DB-Client-Id`, `DB-Api-Key`) | ❌ | Returns `status: empty` when no SBB mapping exists ("SBB übernimmt"); RIS::Journeys pending approval |
| **ÖBB** (`oebb.js`) | [`hafas-client`](https://github.com/derhuerst/hafas-client) ÖBB profile | none | ❌ | Cloudflare blocks shop; HAFAS tickets endpoint returns nothing — timetable only |
| **Flix** (`flix.js`) | FlixBus/FlixTrain mobile API (`/search/autocomplete/cities` + `/mobile/v1/trip/search.json`) | mobile auth token (public, reverse-engineered) | ✅ (EUR) | Bus + FlixTrain; works directly from server (no proxy required); fallback SOCKS5 via `fare-tunnel.service` |
| **CD/IDOS** (`idos.js`) | `idos.cz` HTML scraping (connection form POST) | none | ❌ | Czech timetable incl. cross-border (RegioJet, ČD, ÖBB…); prices not extracted |

## Setup

```bash
npm install

# secrets (see providers/db.js, loaded by lib/env.js if .env exists)
cat > .env <<'EOF'
DB_CLIENT_ID=your-db-portal-client-id
DB_CLIENT_SECRET=your-db-portal-secret
MASKLABS_USER=unused-optional
MASKLABS_PASS=unused-optional
EOF

# optional: mTLS cert for DB Marketplace (mutual TLS)
# DB_CERT_PATH=/path/to/cert.pem  DB_KEY_PATH=/path/to/key.pem

npm start
```

Port defaults to `4055` (override with `FARES_PORT`).

## API

| Endpoint | Description |
|---|---|
| `GET /` | single-page comparison UI (`web/index.html`) — currency toggle (EUR/CHF/original, EUR default), keyboard-navigable station autocomplete |
| `GET /api/suggest?q=München` | station autocomplete (SBB places API) |
| `GET /api/search?from=Praha&to=Berlin%20Hbf&date=2026-09-18` | run all providers for a route/date, return `{ offers, statuses }` |
| `GET /api/history?from=…&to=…` | last scraped snapshots for a route (JSONL) |
| `GET /api/scrape` | trigger periodic scrape of the default routes now |
| `GET /health` | liveness probe |

Responses are cached in-memory for 15 minutes (`lib/store.js`).

## Normalized offer schema

```json
{
  "provider": "sbb",
  "providerLabel": "SBB",
  "operator": "DB Fernverkehr",
  "product": "ICE 623 → ICE 506",
  "departure": "2026-09-18T08:25:00.000Z",
  "arrival": "2026-09-18T13:03:00.000Z",
  "durationMin": 278,
  "price": 111.0,
  "currency": "CHF",
  "bookedOut": false,
  "note": "im Deutschlandticket",
  "url": "https://www.sbb.ch/…"
}
```

`price: null` means the provider returned a timetable entry but no fare — the
`url` points to its booking page. `note` may contain supplementary text such as
"im Deutschlandticket" (all-local chain, D-Ticket eligible) or "Preis via
flixtrain.de" (SBB shows a FLX leg that must be booked elsewhere).

### Currency display

The frontend offers a currency toggle (EUR / CHF / original).
EUR prices are displayed as-is; CHF prices are converted using
`CHF_EUR_RATE` (env var, default `1.05`). The server sorts offers by
EUR-normalized price regardless of the toggle.

### Deduplication

The frontend deduplicates offers by `(provider, departure, arrival, price)` so
the same connection does not appear twice across provider-specific station
matches (e.g. multiple SBB results departing from different Hbf sub-platforms).

## Background scrape

`server.js` scrapes a set of default routes on start and every 30 minutes,
appending each result to `history/<from>→<to>.jsonl` (one JSON object per line).

## Anti-bot reality (why DB/ÖBB prices are hard)

- **DB** (`bahn.de`) is protected by **Akamai Bot Manager**: a heavyweight
  obfuscated sensor script fingerprints canvas/WebGL, `navigator.platform`,
  `maxTouchPoints`, timing and cookie flow, then issues a solved `_abck`
  cookie. Public REST endpoints return `403` until that cookie is present.
  Docker `/tmp/curl-impersonate` (Chrome TLS fingerprint) only bypasses
  fingerprint checks, not the cookie challenge. See `grab-cookies.ps1` (a
  CDP-based helper for extracting the real cookies from a user's session).
- **ÖBB shop** is behind **Cloudflare**, which rejects all scripted clients.
- **SBB** is the least protected: a public GraphQL API (`graphql.www.sbb.ch`,
  used by the sbb.ch site itself) returns both timetable and prices with just
  a few Apollo client headers — no login, no captcha. **Flix** mobile API
  (`/mobile/v1/trip/search.json`) works from a plain server IP; a SOCKS5
  fallback via `fare-tunnel.service` is compiled in (`PROXY_URL` env) for use
  if Flix starts blocking datacenter IPs again.

## Deployment

The production instance runs via systemd (see `fares.service` example inside)
behind a Cloudflare Tunnel:

- `fare.sillytransfem.online` → `:4055` (this app)
- `stats.sillytransfem.online` → `:9090` (metrics)

A second unit, `fare-tunnel.service`, runs `tunnel.mjs` — a SOCKS5 proxy
(`127.0.0.1:1081`) to the MaskLabs residential proxy (secrets in `.env`).

## Roadmap / known gaps

- [ ] RIS::Journeys approval → DB gets real from→to journeys (today + up to 14 days)
- [ ] DB prices via Akamai `_abck` cookie injection (see `grab-cookies.ps1`)
- [ ] ÖBB prices (Cloudflare bypass / different endpoint)
- [ ] CD/IDOS price extraction from connection HTML