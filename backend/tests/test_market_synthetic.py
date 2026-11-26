from datetime import UTC, datetime, timedelta
from decimal import Decimal

from app.market import calendar
from app.market.providers.synthetic import SyntheticProvider, fnv1a, rnd
from app.market.types import InstrumentRef

NOW = datetime(2026, 11, 23, 18, 7, tzinfo=UTC)  # Monday, US + crypto + FX open
BTC = InstrumentRef("BTC-USD", "CRYPTO", "CRYPTO_24_7", "BTC-USD", 2, Decimal("90000"))
AAPL = InstrumentRef("AAPL", "STOCK", "US_EQUITY", "AAPL", 2, Decimal("230"))
EUR = InstrumentRef("EUR/USD", "FX", "FX_24_5", "EUR/USD", 5, Decimal("1.08"))


def test_hash_is_stable_32_bit():
    # Pinned so the TypeScript mirror (frontend demo) can assert the same values.
    assert fnv1a("BTC-USD") == 1995245873
    assert rnd(123, 29_000_000) == 0.9192117233760655


def test_deterministic_and_consistent():
    p = SyntheticProvider(now=lambda: NOW)
    a = p.candles(BTC, "1h", NOW - timedelta(days=2), NOW)
    b = p.candles(BTC, "1h", NOW - timedelta(days=2), NOW)
    assert a == b and len(a) == 47  # 18:07 start → first full bucket 19:00
    for c in a:
        assert c.low <= min(c.open, c.close) <= max(c.open, c.close) <= c.high
    # contiguous: each close equals next open
    assert all(x.close == y.open for x, y in zip(a, a[1:], strict=False))
    # never emits an incomplete candle
    assert a[-1].open_time + timedelta(hours=1) <= NOW


def test_respects_trading_sessions():
    p = SyntheticProvider(now=lambda: NOW)
    start = NOW - timedelta(days=7)
    for c in p.candles(AAPL, "1h", start, NOW):
        assert calendar.sessions("US_EQUITY", c.open_time, c.open_time + timedelta(hours=1))
    days = p.candles(AAPL, "1d", start, NOW)
    assert len(days) == 5  # Mon 16th–Fri 20th; today's session is incomplete
    assert all(d.open_time.hour == 14 and d.open_time.minute == 30 for d in days)
    fx = p.candles(EUR, "1h", start, NOW)
    assert not any(c.open_time.weekday() == 5 for c in fx)  # no Saturday candles


def test_quote_shape():
    p = SyntheticProvider(now=lambda: NOW)
    q = p.quote(BTC)
    assert q.bid < q.last < q.ask and q.as_of == NOW and q.source == "synthetic"
    sat = datetime(2026, 11, 28, 12, tzinfo=UTC)
    q2 = SyntheticProvider(now=lambda: sat).quote(AAPL)
    assert q2.as_of == datetime(2026, 11, 27, 18, tzinfo=UTC)  # Friday early close (13:00 ET)
    assert q2.prev_close is not None
