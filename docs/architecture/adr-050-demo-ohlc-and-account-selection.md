# ADR 050 — Demo OHLC candles and validated account selection

Status: proposed for soft launch; legal re-review of public data-source disclosures is still pending.

## Context

The static demo rendered price history from a deterministic simulator. Binary Options used a
close-only line, which does not show open/high/low/close and can misrepresent volatility. Deep links
containing an old `?account=` id, and legacy browser storage, could silently select an account
from an earlier demo corpus.

## Decision

- All price charts use candlesticks ( Markets, Binary Options and the separate live build ).
- In the public demo, BTC-USD, ETH-USD and SOL-USD candles and reference quotes are fetched directly
  from Coinbase Exchange's public, credential-free endpoints when reachable. Failures fall back to
  the deterministic corpus, and every surface labels the actual source (`Coinbase` / `Synthetic`).
- Other instruments remain simulated. Paper fills, balances, ledger and binary settlement in the
  demo remain simulated; public crypto prices are reference prices, not executable quotes.
- The demo corpus moved to a new storage key so legacy accounts cannot reappear. The selected paper
  account is validated against the current account list before use and is shared across all routes;
  unknown deep-linked ids are replaced with a current account.

## Consequences

- No credentials, API keys, payment, custody or broker path is introduced.
- Public data requests are cached briefly and degrade gracefully; rate-limit exposure is bounded.
- Compliance review of the revised data-source disclosures is required before marketing use. The
  fail-closed legal gate remains unsigned and is not modified or bypassed.
