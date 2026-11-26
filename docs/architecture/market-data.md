# Market data (Phases 3 and 5)

```
                       ┌──────────── MarketService ────────────┐
REST /markets/* ──────►│ registry · quotes (1s cache) · candles │──► market_candles (PostgreSQL)
WS   /markets/stream ─►│ staleness · tradability · gap-fill     │
                       └───────────────┬────────────────────────┘
                                       │ MarketDataProvider (one interface)
                 ┌─────────────────────┼──────────────────────┐
           SyntheticProvider     CoinbaseProvider      FrankfurterProvider
           (default, offline)    crypto, public API    ECB daily reference FX
                                       │
                       ┌────────────────┴────────────────┐
                 FinnhubProvider                   OandaProvider
                 licensed stocks/ETFs              tradable spot FX bid/ask
```

Finnhub supplies real last prices and candles; its quote endpoint has no exchange
order book, so bid/ask are derived from the last price with a configured spread
and labelled `pricing=estimated_spread`. OANDA supplies actual bid/ask and a
`tradeable` flag; ECB fixings have `pricing=reference` and are never tradable.

## Instruments
`assets` (economic asset) → `instruments` (a listing on a venue, in a quote currency).
`instrument_type` is constrained to cash instruments — `SPOT`, `SPOT_FX`, `SHARE`, `ETF` —
so CFDs and derivatives cannot be confused with them when added later. Seeded: BTC, ETH, SOL;
EUR/USD, GBP/USD, USD/JPY; AAPL, MSFT, NVDA, SHEL.L, AZN.L; SPY, QQQ, ISF.L.
URLs use the `slug` (symbol without `/`), e.g. `/markets/instruments/EURUSD/candles`.

## Sessions
`app/market/calendar.py`: crypto 24/7; FX Sun 17:00 → Fri 17:00 New York; NYSE/Nasdaq
09:30–16:00 ET; LSE 08:00–16:30 London — all DST-aware, with 2026–27 full-day holidays
and early closes: NYSE 13:00 ET on Black Friday/Christmas Eve, LSE 12:30 London on
Christmas Eve/New Year's Eve. Early closes clip `sessions()`, `is_open()`, `status()`
and `last_close()`; a 13:00 ET close is 18:00 UTC in winter and 17:00 UTC in summer.
The static demo uses the same holiday and early-close tables; `scripts/check-rule-parity.mjs`
fails the build if they drift. `day_expiry()` also ends DAY orders at these session closes
(24/7 crypto uses the next UTC midnight).

## Data modes (`AUREX_MARKET_DATA_MODE`)
| Mode | Crypto | FX | Stocks / ETFs |
|---|---|---|---|
| `synthetic` (default) | synthetic | synthetic | synthetic |
| `live` | Coinbase Exchange | OANDA v20 (real bid/ask); ECB reference only as a labelled fallback with no key | Finnhub (licensed feed; **no synthetic fallback**) |

Every quote and candle carries its `source` and a `pricing` label (`actual`,
`estimated_spread`, `reference`, `simulated`); the UI labels simulated data. If a live
provider fails, the API returns `503 market_data_unavailable`. It never substitutes
synthetic prices for the real ones it was asked for. With no Finnhub key, live equities
return 503; with no OANDA key, FX continues only as an explicitly non-tradable ECB
reference rate.

## Quotes: stale and tradable
`stale = market open AND age > threshold` (60s crypto/FX, 120s equities).
`tradable = market open AND not stale AND source is not a reference rate AND pricing is
not a reference/simulation (simulation is tradable only in the offline demo mode).`
The Phase 9 risk gate will reject orders on non-tradable quotes.

## Candles
A read-through store keyed by `(instrument, timeframe, open_time)`. Each request fills the gap
since the last stored candle (or the requested look-back), upserts it, and serves from
PostgreSQL. Only completed candles are stored, and a DB check enforces OHLC consistency.
Admins can backfill with `POST /markets/backfill` (audited). 4h crypto candles are aggregated
from 1h, because Coinbase does not offer 4h.

## Synthetic generator
A pure function of `(symbol, timestamp)`: deterministic, consistent across timeframes, with
realised volatility calibrated to per-class targets. It respects sessions, so there are no
weekend equity candles. It is mirrored bit-for-bit in TypeScript for the static demo, and
pinned hash values are asserted in both codebases.

## Streaming
`WS /api/v1/markets/stream`. The first frame is `{"type":"auth","token":…}` (in-band, so
tokens never reach URL logs), then `{"type":"subscribe","symbols":[…]}` (max 50). The server
pushes `quotes` frames every `AUREX_STREAM_INTERVAL_SECONDS`. The SPA falls back to polling
if the socket fails.

With `AUREX_REDIS_URL` and `AUREX_STREAM_FANOUT_ENABLED=true`, quotes and account events
are published to the Redis Stream `aurex:stream:events`. Each replica joins its own
consumer group and delivers to its local sockets; short Redis leases elect one poller
per symbol/user, and event ids deduplicate at-least-once delivery. Without Redis the
same bus works in process. Account changes and valuations go through
`WS /api/v1/stream/account` on the same bus, so a fill seen by one replica reaches
sockets on all replicas. Redis is trusted infrastructure: the account channel is
keyed by an authenticated user id, and quote clients filter by subscribed symbol.
