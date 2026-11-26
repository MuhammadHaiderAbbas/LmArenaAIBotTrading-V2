# Paper execution (Phase 8)

`backend/app/trading/` is the order management system (OMS) for **simulated** trading.
No order ever leaves the platform: fills are computed from the live paper market feed
(the Phase 3 quote service), and every cent is accounted for in the double-entry ledger.

## Order lifecycle

```
submit ─► shape validation ──(422, nothing stored)
       └► business checks ─┬─► REJECTED (stored, with reason, audited)
                           ├─► MARKET ─► fill on the live quote ─► FILLED
                           └─► LIMIT / STOP ─► OPEN ─► matcher ─► FILLED | CANCELLED | EXPIRED
```

| Concern | Rule |
|---|---|
| Order types | MARKET, LIMIT, STOP (stop becomes a market order once triggered) |
| Time in force | GTC (expires after 30 days) or DAY (expires at the current trading session's close; 24/7 crypto uses the next 00:00 UTC) |
| Idempotency | optional `client_order_id`, unique per account; a replay returns the original order (`200`, `Idempotent-Replay: true`) |
| Shape | quantity is a multiple of the lot size; prices respect the instrument's tick decimals; MARKET takes no prices |
| Spot only | sells cannot exceed the open position minus quantity already in open sell orders: no shorting |
| No leverage | estimated cost plus fee must fit in *available cash* = cash − amounts reserved by open buy orders |
| Concentration | at most 5 open positions per account (the blueprint's dev default) |
| Market state | market orders are rejected on closed markets, stale quotes or when market data is down; resting orders simply wait |
| FX | instruments quoted in another currency are converted at the live FX rate (direct, inverse or via USD); no rate → rejected |
| Fills | whole-order fills only |

Business rejections are **persisted** with their reason so the trade history and audit
trail show what was attempted and why it was refused. Malformed requests are not persisted.

## Execution model (`app/trading/execution.py`)

The same cost model as the Phase 7 backtester (`DEFAULT_COSTS`), applied to the live quote:

- Buys pay the **ask**, sells receive the **bid**, so the spread is always paid.
- Base slippage per asset class on top (crypto 2 bp, FX 0.5 bp, stocks 2 bp, ETFs 1 bp).
- Commission per asset class (crypto 10 bp, FX 0, stocks and ETFs 1 bp), on notional in the
  account currency.
- Limit orders never fill worse than their limit. Stops can fill worse than the stop price,
  as they do in real markets.

Every execution row records the fill price, the bid/ask reference, the mid, the FX rate,
the fee and the spread and slippage costs separately, so execution quality is measurable.

## Ledger postings

All amounts are in the account currency (quote-currency amount × FX rate) and quantised
to 8 decimals. Each fill is one balanced transaction.

| Event | Debit | Credit |
|---|---|---|
| Buy | INVESTMENTS (notional) | CASH |
| Fee | FEES | CASH |
| Sell | CASH (proceeds) | INVESTMENTS (cost of the quantity sold, at average cost) |
| Sell gain / loss | — / REALISED_PNL | REALISED_PNL / — |

Positions use **average cost**. The ledger therefore always satisfies
`cash = funding + contributions − withdrawals + realised P&L − fees − investments at cost`,
and the tests assert it after round trips.

## Atomicity and concurrency

A fill writes the execution (append-only), the ledger transaction (append-only, deferred
balance trigger), the position, the order status and its event (append-only) and a
portfolio snapshot inside **one database transaction** under a `SELECT … FOR UPDATE` lock on
the trading account. The matcher takes open orders with `FOR UPDATE SKIP LOCKED`, so
several API workers can run it without double fills. A partial unique index allows only one
OPEN position per account and instrument.

## Matcher

`TradingService.process_open()` expires old orders and fills LIMIT and STOP orders whose
trigger is met on the current quote. It runs in a background task started by the FastAPI
lifespan every `AUREX_ORDER_MATCHER_INTERVAL_SECONDS` (default 5; 0 disables it, as in the
tests). Admins can also trigger a pass with `POST /trading/process`. The static demo runs
the matcher on every trading request instead.

## Portfolio

`GET /portfolio/summary` marks open positions at the **bid** (what you could sell for),
converted at the live FX rate, and reports cash, available cash, market value, equity,
unrealised and realised P&L, fees, exposure and allocation by asset class. Snapshots are
taken on every fill and at most hourly when the summary is viewed, and feed the equity
history chart.

## What is deliberately not here yet

- AI proposals do **not** become orders. In Phase 9 they will go through the independent
  risk engine (per-trade risk, daily loss, drawdown, exposure, kill switch), which then has
  final authority over every order, manual or automatic.
- No partial fills, short selling, margin or order amendment.
