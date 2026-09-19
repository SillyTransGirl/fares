# fares — Multi-Operator European Rail/Bus Fare Comparator

A small Node.js service that queries several European transport providers for
a given route and date, normalizes the results into one unified offer schema,
and serves them on a tiny JSON API with a single-page comparison view.

**Repo:** https://github.com/SillyTransGirl/fares
**Live:** https://fare.sillytransfem.online

---

## How it works

```
                              ┌─────────────────────────────────────────────┐
  GET /api/search             │  providers/index.js  runAll()              │
   ──────────►  server.js  ──►│  runs every provider in parallel           │
                              │  with a per-provider timeout (25s)         │
│  ┌──────────┬──────────┬───────────┬─────┐  │
                               │  │ DB       │ Flix     │ SBB       │ ... │  │
                               │  └────┬─────┴────┬─────┴────┬──────┴─────┘  │
                               │       │          │          │               │
                               └───────┼──────────┼──────────┼───────────────┘
                                       │          │          │
                                 Vendo Backend  FlixBus/     graphql.www.sbb.ch
                                 (DB Navigator  FlixTrain    (timetable + prices)
                                  mobile API)   mobile API
                                       │
                                 ├── prices included!
                                 └── split ticketing via vendo_split.py

  Every offer is normalized via lib/normalize.js → one schema:
  { provider, operator, product, departure, arrival, durationMin,
    price, currency, bookedOut, url }
  Offers are sorted cheapest-first.
```

## Providers

Providers are queried in order **SBB → DB → Flix → idos**.

| Provider | Data source | Auth | Prices | Notes |
|---|---|---|---|---|
| **DB** (`db.js`) | [Vendo Backend](https://app.services-bahn.de/mob) — DB Navigator mobile API | none | ✅ (EUR) | Real Flexpreis prices via Python bridge (`vendo_fares.py` with `curl_cffi`); dynamic station lookup — every station works automatically |
| **CH SBB** (`sbb.js`) | `graphql.www.sbb.ch` — Trips + TripPrices queries | none | ✅ (CHF) | Full train chains (RE/ICE/FLX mix); D-Ticket note on all-local chains |
| **Flix** (`flix.js`) | FlixBus/FlixTrain mobile API | mobile auth token (public) | ✅ (EUR) | Bus + FlixTrain; works directly from server |
| **CD/IDOS** (`idos.js`) | `idos.cz` HTML scraping | none | ❌ | Czech timetable incl. cross-border; prices not extracted |

### DB Provider — Vendo Backend

The DB provider uses the **Vendo Backend** (`app.services-bahn.de/mob`), which is the same API the DB Navigator mobile app uses. Key advantages:

- **No Akamai protection** — works directly from any VPS
- **Real prices** — returns Flexpreis for all connections
- **Dynamic station lookup** — accepts station names directly via `A=1@O=StationName@` format
- **Python bridge** — `vendo_fares.py` uses `curl_cffi` with Chrome TLS impersonation

The EVA_MAP in `db.js` is kept for fast lookup, but Vendo resolves unknown names automatically. Small stations like Obernburg-Elsenfeld work out of the box.

## Split Ticketing

The `/api/split` endpoint finds cheaper intermediate stops for a route:

```
GET /api/split?from=Frankfurt+Hbf&to=Hamburg+Hbf&date=2026-09-20
```

Response:
```json
{
  "direct_price": 147.99,
  "best_split": "Hannover Hbf",
  "best_saving": 16.01,
  "splits": [
    {"split_point": "Hannover Hbf", "seg1_price": 99.99, "seg2_price": 31.99, "total_price": 131.98, "saving": 16.01},
    {"split_point": "Fulda", "seg1_price": 35.99, "seg2_price": 103.99, "total_price": 139.98, "saving": 8.01}
  ]
}
```

The split logic:
1. Get direct connections to find intermediate stops
2. Query fares for each segment (origin→split, split→destination)
3. Compare sum of segments vs direct price
4. Return all splits ranked by saving

Not all routes have cheaper splits — this depends on DB's pricing.

## Setup

```bash
npm install

# Python dependencies (for DB Vendo backend)
cd scrapy_fares && uv sync && cd ..

# secrets (see providers/db.js, loaded by lib/env.js if .env exists)
cat > .env <<'EOF'
DB_CLIENT_ID=your-db-portal-client-id
DB_CLIENT_SECRET=your-db-portal-secret
EOF

npm start
```

Port defaults to `4055` (override with `FARES_PORT`).

### Python Bridge

The DB provider uses a Python script (`scrapy_fares/vendo_fares.py`) to call the Vendo backend. This requires:

- Python 3.11+
- `curl_cffi` (Chrome TLS impersonation)
- Virtual environment at `scrapy_fares/.venv/`

The venv is created with `uv sync` in the `scrapy_fares/` directory.

## API

| Endpoint | Description |
|---|---|
| `GET /` | single-page comparison UI (`web/index.html`) — currency toggle (EUR/CHF/original) |
| `GET /api/suggest?q=München` | station autocomplete (SBB places API) |
| `GET /api/search?from=Praha&to=Berlin%20Hbf&when=2026-09-20T10:00` | run all providers for a route/date, return `{ offers, statuses }` |
| `GET /api/split?from=Frankfurt+Hbf&to=Hamburg+Hbf&date=2026-09-20` | find cheaper split ticket options |
| `GET /api/history?from=…&to=…` | last scraped snapshots for a route (JSONL) |
| `GET /api/scrape` | trigger periodic scrape of the default routes now |
| `GET /health` | liveness probe |

Responses are cached in-memory for 15 minutes (`lib/store.js`).

## Normalized offer schema

```json
{
  "provider": "db",
  "providerLabel": "DB",
  "operator": "Deutsche Bahn",
  "product": "ICE 623",
  "departure": "2026-09-20T08:25:00.000Z",
  "arrival": "2026-09-20T13:03:00.000Z",
  "durationMin": 278,
  "price": 111.0,
  "currency": "EUR",
  "bookedOut": false,
  "note": null,
  "url": "https://www.bahn.de/buchung/fahrplan/suche"
}
```

`price: null` means the provider returned a timetable entry but no fare.

### Currency display

The frontend offers a currency toggle (EUR / CHF / original).
EUR prices are displayed as-is; CHF prices are converted using
`CHF_EUR_RATE` (env var, default `1.05`). The server sorts offers by
EUR-normalized price regardless of the toggle.

### Deduplication

The frontend deduplicates offers by `(provider, departure, arrival, price)` so
the same connection does not appear twice across provider-specific station
matches.

## Background scrape

`server.js` scrapes a set of default routes on start and every 30 minutes,
appending each result to `history/<from>→<to>.jsonl` (one JSON object per line).

## Deployment

The production instance runs via systemd behind a Cloudflare Tunnel:

- `fare.sillytransfem.online` → `:4055` (this app)

Services:
- `fares.service` — Node.js server
- `fares-tunnel.service` — SOCKS5 proxy tunnel (optional, for fallback)

## Roadmap / known gaps

- [ ] RIS::Journeys approval → DB gets real from→to journeys (today + up to 14 days)
- [ ] CD/IDOS price extraction from connection HTML
- [ ] ÖBB provider (currently timetable only via HAFAS)
- [ ] Sparpreis support (Vendo backend returns Flexpreis; Sparpreis requires recon endpoint)
