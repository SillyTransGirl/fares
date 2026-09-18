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

| Provider | Data source | Auth | Prices | Notes |
|---|---|---|---|---|
| **DB** (`db.js`) | [DB API Marketplace](https://developers.deutschebahn.com) — Timetables 1.0.274 (Free), RIS::Stations, RIS::Journeys 1.0.273 (Paket XS, pending) | Client ID/Secret + mTLS client cert (`DB-Client-Id`, `DB-Api-Key`) | ❌ (timetable-only) | Timetables only covers today/tomorrow; RIS::Journeys will enable +14 days once approved |
| **ÖBB** (`oebb.js`) | [`hafas-client`](https://github.com/derhuerst/hafas-client) ÖBB profile | none | ❌ | `refreshJourney(…, { tickets: true })` returns no tickets via HAFAS; Cloudflare blocks the shop APIs |
| **Flix** (`flix.js`) | FlixBus/FlixTrain v4 search + cities API | none | ✅ | Bus + FlixTrain; blocked from plain datacenter IPs (403) — needs residential/WARP egress |
| **CD/IDOS** (`idos.js`) | `idos.cz` HTML scraping (connection form POST) | none | ❌ | Czech timetable incl. cross-border (RegioJet, ČD, ÖBB…); prices not extracted |
| **CH SBB** (`sbb.js`) | `graphql.www.sbb.ch` (the API the sbb.ch website itself uses) | none (Apollo client headers) | ✅ | Timetable + prices in CHF (SBB standard fare); no captcha |

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
| `GET /` | single-page comparison UI (`web/index.html`) |
| `GET /api/search?from=Praha&to=Berlin%20Hbf&date=2026-09-18` | run all providers for a route/date, return `{ offers, statuses }` |
| `GET /api/history?from=…&to=…` | last scraped snapshots for a route (JSONL) |
| `GET /api/scrape` | trigger periodic scrape of the default routes now |
| `GET /health` | liveness probe |

Responses are cached in-memory for 15 minutes (`lib/store.js`).

## Normalized offer schema

```json
{
  "provider": "flix",
  "providerLabel": "Flix",
  "operator": "FlixBus",
  "product": "FlixBus",
  "departure": "2026-09-18T08:30:00.000Z",
  "arrival": "2026-09-18T14:15:00.000Z",
  "durationMin": 345,
  "price": 19.99,
  "currency": "EUR",
  "bookedOut": false,
  "url": "https://shop.flixbus.com/search?…"
}
```

`price: null` means the provider returned a timetable entry but no fare — the
`url` points to its booking page.

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
  a few Apollo client headers — no login, no captcha. **Flix** also works
  (needs residential/WARP egress).

## Deployment

The production instance runs via systemd (see `fares.service` example inside)
behind a Cloudflare Tunnel:

- `fare.sillytransfem.online` → `:4055` (this app)
- `stats.sillytransfem.online` → `:9090` (metrics)

## Roadmap / known gaps

- [ ] RIS::Journeys approval → DB gets real from→to journeys (today + up to 14 days)
- [ ] DB prices via Akamai `_abck` cookie injection (see `grab-cookies.ps1`)
- [ ] ÖBB prices (Cloudflare bypass / different endpoint)
- [ ] CD/IDOS price extraction from connection HTML