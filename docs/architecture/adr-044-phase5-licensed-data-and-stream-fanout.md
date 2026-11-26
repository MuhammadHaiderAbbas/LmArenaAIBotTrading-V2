# ADR-044 — Phase 5: licensed market data, tradable FX, early closes and multi-node streams

**Status:** Accepted (implemented locally; production credentials are owner-supplied)
**Date:** 2026-11-25

## Context

Phase 3 delivered one provider interface with a synthetic demo feed, Coinbase for crypto and
ECB daily fixings for FX. That is honest for a demo but insufficient for live paper trading:

- Live equities were still synthetic, with no signal that the price was not a real quote.
- FX had only daily ECB reference rates, which are never executable.
- The calendar modelled full-day holidays but not early closes, so `is_open`, `status` and
  `last_close` could be wrong on Black Friday and around Christmas/New Year.
- Both WebSockets polled service-local state. With multiple API replicas, a client on another
  node could miss a change until it polled the database again; quote providers were fetched
  once per connected socket.
- Provider failures were handled, but the quote schema did not distinguish a real bid/ask
  from a derived spread, a fixing, or a simulation.

## Decision

1. **Licensed equity/ETF feed (Finnhub).** `FinnhubProvider` calls `/quote` and `/stock/candle`
   with the key in the `X-Finnhub-Token` header. Migration 0013 points all STOCK/ETF rows at
   `data_provider='finnhub'`. In live mode a missing key or upstream failure yields
   `503 market_data_unavailable`; there is no synthetic fallback. Finnhub's quote has no order
   book, so bid/ask are derived from the licensed last price using
   `AUREX_FINNHUB_SPREAD_BPS` and labelled `pricing=estimated_spread`.

2. **Tradable FX (OANDA v20).** `OandaProvider` reads `/accounts/{id}/pricing` for real
   bid/ask, checks the `tradeable` flag and non-empty sides, and reads `/candles` with
   `priceType=MIDPOINT` for OHLCV. Migration 0013 points FX rows at `data_provider='oanda'`
   using `EUR_USD`-style provider symbols. Without credentials, the provider registry falls
   back to Frankfurter/ECB, whose quote is explicitly `source=ecb_reference`,
   `pricing=reference`, `tradable=false`.

3. **Quote labels and tradability.** `RawQuote`/`Quote`/`QuoteRead` carry a `pricing` field:
   `actual`, `estimated_spread`, `reference` or `simulated`. Reference sources and
   simulations are never tradable in live mode; offline demo simulations remain tradable for
   paper trading and are labelled throughout the UI. Coinbase crypto is untouched.

4. **Early closes.** `calendar.EARLY_CLOSES` stores local close times for NYSE (13:00 ET on
   Black Friday and Christmas Eve) and LSE (12:30 London on Christmas Eve/New Year's Eve)
   for 2026–27. `sessions()` substitutes the earlier close per date, so `is_open`,
   `status().next_change`, `last_close()` and synthetic candles all respect it. Times are
   local, so DST remains correct.

5. **Cross-replica fan-out.** `app/realtime/bus.py` publishes quote and account events to the
   Redis Stream `aurex:stream:events`. Each replica joins its own consumer group and delivers
   to local WebSocket subscribers by channel (`quote:<symbol>`, `account:<user-id>`). Short
   Redis leases elect one poller per symbol/user; event ids deduplicate at-least-once
   delivery. With `AUREX_STREAM_FANOUT_ENABLED=false` (default) or no Redis URL, the same bus
   delivers in process, preserving single-node behaviour. Auth and symbol/user filtering stay
   in the WebSocket endpoints, before any event reaches a client.

## Alternatives rejected

- **Continue using ECB fixings as FX quotes** — they are daily reference rates, not executable.
- **Keep synthetic equities as a live fallback** — indistinguishable from a real quote without
  an explicit label and a hard failure path.
- **Per-socket polling only** — already worked on one node but duplicated provider calls and
  delayed cross-replica account changes.
- **Plain Redis pub/sub** — no replay or consumer-group isolation; a replica that briefly
  loses its read loop drops events permanently. Redis Streams with per-node groups plus id
  deduplication gives at-least-once delivery.

## Consequences

- Live deployments need Finnhub and OANDA credentials in secret files. Stocks/ETFs fail closed
  without them; FX degrades to a clearly labelled non-tradable reference rate.
- Finnhub bid/ask are derived, not an exchange NBBO; clients see `estimated_spread`. If a real
  NBBO feed is required later, it can replace `FinnhubProvider` behind the same interface.
- Early closes are a maintained list through 2027, not an exchange-calendar subscription.
- Redis Streams must be monitored for lag/consumer groups; the stream is capped at 5,000
  entries and events are at-least-once (consumers deduplicate).
- All 249 backend tests pass, including mocked provider tests, DST-aware early-close tests,
  and two-replica fan-out tests against a real local Redis. Frontend typecheck and the
  Pages-shaped demo build pass with the new pricing badge.
