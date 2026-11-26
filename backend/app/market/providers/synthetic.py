"""Deterministic synthetic market data.

Used offline, in tests and in the public demo. The same instrument and time always
produce the same price (a pure function of symbol + timestamp), so candles are stable
across requests and timeframes are mutually consistent. The algorithm is mirrored
in the frontend demo (frontend/src/services/demo/synthetic.ts).

This is NOT real market data and must always be labelled `source="synthetic"`.
"""

import math
from datetime import UTC, datetime, timedelta
from decimal import ROUND_HALF_EVEN, Decimal

from app.market import calendar
from app.market.types import TIMEFRAMES, AssetClass, Candle, InstrumentRef, RawQuote

M32 = 0xFFFFFFFF
YEAR = 365 * 86400
AMP = 0.45  # calibrated so realised daily vol ≈ the VOL target below
VOL = {AssetClass.CRYPTO: 0.65, AssetClass.FX: 0.08, AssetClass.STOCK: 0.28, AssetClass.ETF: 0.16}
SPREAD = {AssetClass.CRYPTO: 0.0002, AssetClass.FX: 0.00004, AssetClass.STOCK: 0.0002,
          AssetClass.ETF: 0.0001}
# (period seconds, weight) — long cycles give trends, short ones intraday movement
CYCLES = [(2 * 3600, 0.5), (9 * 3600, 0.7), (3 * 86400, 1.0), (11 * 86400, 1.0),
          (37 * 86400, 1.0), (97 * 86400, 1.0), (YEAR, 1.0)]


def _imul(a: int, b: int) -> int:
    return (a * b) & M32


def fnv1a(s: str) -> int:
    h = 0x811C9DC5
    for ch in s.encode():
        h = _imul(h ^ ch, 0x01000193)
    return h


def rnd(seed: int, k: int) -> float:
    """Deterministic uniform [0, 1) from (seed, k). 32-bit integer mixing."""
    h = (seed ^ _imul(k & M32, 0x9E3779B1)) & M32
    h = _imul(h ^ (h >> 16), 0x85EBCA6B)
    h = _imul(h ^ (h >> 13), 0xC2B2AE35)
    h ^= h >> 16
    return (h & M32) / 4294967296


def price_at(symbol: str, asset_class: str, base: float, t: float) -> float:
    seed = fnv1a(symbol)
    vol = VOL[asset_class]
    x = 0.0
    for j, (period, weight) in enumerate(CYCLES):
        amp = vol * math.sqrt(period / YEAR) * AMP * weight
        phase = rnd(seed, 1000 + j) * 2 * math.pi
        x += amp * math.sin(2 * math.pi * t / period + phase)
    minute = math.floor(t / 60)
    x += vol * math.sqrt(60 / YEAR) * 2.5 * (rnd(seed, minute) - 0.5)
    return base * math.exp(x)


def _q(v: float, decimals: int) -> Decimal:
    return Decimal(repr(v)).quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_EVEN)


def _ohlc(inst: InstrumentRef, s: float, e: float) -> tuple[float, float, float, float]:
    base = float(inst.base_price)
    step = max(60.0, (e - s) / 16)
    samples = [price_at(inst.symbol, inst.asset_class, base, s)]
    t = s + step
    while t < e:
        samples.append(price_at(inst.symbol, inst.asset_class, base, t))
        t += step
    samples.append(price_at(inst.symbol, inst.asset_class, base, e))
    return samples[0], max(samples), min(samples), samples[-1]


class SyntheticProvider:
    name = "synthetic"

    def __init__(self, now: "callable | None" = None):  # type: ignore[valid-type]
        self._now = now or (lambda: datetime.now(UTC))

    async def get_candles(self, inst, timeframe, start, end) -> list[Candle]:
        return self.candles(inst, timeframe, start, end)

    def candles(self, inst: InstrumentRef, timeframe: str, start: datetime,
                end: datetime) -> list[Candle]:
        tf = TIMEFRAMES[timeframe]
        end = min(end, self._now())
        seed2 = fnv1a(inst.symbol + ":vol")
        out: list[Candle] = []
        if timeframe == "1d" and inst.market in ("US_EQUITY", "UK_EQUITY"):
            # One candle per trading session, stamped at the session open.
            for so, sc in calendar.sessions(inst.market, start - timedelta(days=1),
                                            end):
                if so < start or sc > end:
                    continue
                out.append(self._candle(inst, so, so.timestamp(), sc.timestamp(), tf, seed2))
            return out

        t0 = math.ceil(start.timestamp() / tf) * tf
        t = t0
        while t + tf <= end.timestamp():
            bs = datetime.fromtimestamp(t, UTC)
            be = datetime.fromtimestamp(t + tf, UTC)
            inter = calendar.sessions(inst.market, bs, be)
            if inter:
                s = min(i[0] for i in inter).timestamp()
                e = max(i[1] for i in inter).timestamp()
                out.append(self._candle(inst, bs, s, e, tf, seed2))
            t += tf
        return out

    def _candle(self, inst, open_time, s, e, tf, seed2) -> Candle:
        o, h, lo, c = _ohlc(inst, s, e)
        d = inst.price_decimals
        base_volume = {"CRYPTO": 40.0, "FX": 2.0e6, "STOCK": 1.5e5, "ETF": 3.0e5}[inst.asset_class]
        vol = base_volume * (0.4 + 1.2 * rnd(seed2, int(s // tf))) * (e - s) / 3600
        return Candle(open_time, _q(o, d), _q(h, d), _q(lo, d), _q(c, d),
                      Decimal(repr(round(vol, 4))))

    async def get_quote(self, inst: InstrumentRef) -> RawQuote:
        return self.quote(inst)

    def quote(self, inst: InstrumentRef) -> RawQuote:
        now = self._now()
        base = float(inst.base_price)
        if calendar.is_open(inst.market, now):
            as_of = now
        else:
            as_of = calendar.last_close(inst.market, now) or now
        last = price_at(inst.symbol, inst.asset_class, base, as_of.timestamp())

        if inst.market in ("US_EQUITY", "UK_EQUITY"):
            # Reference = close of the session before the current / most recent one.
            recent = calendar.sessions(inst.market, as_of - timedelta(days=10), as_of)
            session_open = recent[-1][0] if recent else as_of
            prev_t = calendar.last_close(inst.market, session_open) or as_of - timedelta(days=1)
        else:
            prev_t = as_of - timedelta(days=1)  # 24h change convention
        prev = price_at(inst.symbol, inst.asset_class, base, prev_t.timestamp())

        half = SPREAD[inst.asset_class] / 2
        d = inst.price_decimals
        return RawQuote(
            last=_q(last, d), bid=_q(last * (1 - half), d), ask=_q(last * (1 + half), d),
            prev_close=_q(prev, d), as_of=as_of, source=self.name, pricing="simulated",
        )
