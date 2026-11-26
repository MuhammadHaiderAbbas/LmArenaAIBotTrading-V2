"""Trading-session calendars.

Simplifications (documented, to be replaced by an exchange-calendar feed later):
  * Full-day exchange holidays and early closes are listed for 2026-2027.
  * FX trades Sunday 17:00 to Friday 17:00 New York time; holiday thin-liquidity days
    are treated as normal.
"""

from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.market.types import Market

NY = ZoneInfo("America/New_York")
LONDON = ZoneInfo("Europe/London")

NYSE_HOLIDAYS = {date.fromisoformat(d) for d in [
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
    "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
    "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18",
    "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]}
LSE_HOLIDAYS = {date.fromisoformat(d) for d in [
    "2026-01-01", "2026-04-03", "2026-04-06", "2026-05-04", "2026-05-25", "2026-08-31",
    "2026-12-25", "2026-12-28",
    "2027-01-01", "2027-03-26", "2027-03-29", "2027-05-03", "2027-05-31", "2027-08-30",
    "2027-12-27", "2027-12-28",
]}

# Early sessions: local-time close overrides for dates that are otherwise trading days.
# Sources: NYSE/Nasdaq 1pm ET on Black Friday and Christmas Eve (except when Christmas
# Eve itself is the observed holiday, e.g. 2027-12-24); LSE 12:30 London on Christmas
# Eve and New Year's Eve. Stored in local time so DST stays correct.
EARLY_CLOSES: dict[str, dict[date, time]] = {
    Market.US_EQUITY: {
        date(2026, 11, 27): time(13), date(2026, 12, 24): time(13),
        date(2027, 11, 26): time(13),
    },
    Market.UK_EQUITY: {
        date(2026, 12, 24): time(12, 30), date(2026, 12, 31): time(12, 30),
        date(2027, 12, 24): time(12, 30), date(2027, 12, 31): time(12, 30),
    },
}

_EQUITY = {
    Market.US_EQUITY: (NY, time(9, 30), time(16, 0), NYSE_HOLIDAYS),
    Market.UK_EQUITY: (LONDON, time(8, 0), time(16, 30), LSE_HOLIDAYS),
}


def close_time(market: str, day: date, default: time) -> time:
    return EARLY_CLOSES.get(market, {}).get(day, default)

Session = tuple[datetime, datetime]


def _utc(d: date, t: time, tz: ZoneInfo) -> datetime:
    return datetime.combine(d, t, tzinfo=tz).astimezone(UTC)


def sessions(market: str, start: datetime, end: datetime) -> list[Session]:
    """Trading sessions (UTC, half-open) intersecting [start, end), clipped to it."""
    if start >= end:
        return []
    if market == Market.CRYPTO_24_7:
        return [(start, end)]

    raw: list[Session] = []
    if market == Market.FX_24_5:
        d = start.astimezone(NY).date() - timedelta(days=7)
        d -= timedelta(days=(d.weekday() + 1) % 7)  # back to Sunday
        while _utc(d, time(17), NY) < end:
            raw.append((_utc(d, time(17), NY), _utc(d + timedelta(days=5), time(17), NY)))
            d += timedelta(days=7)
    elif market in _EQUITY:
        tz, open_t, close_t, holidays = _EQUITY[market]
        d = start.astimezone(tz).date() - timedelta(days=1)
        last = end.astimezone(tz).date()
        while d <= last:
            if d.weekday() < 5 and d not in holidays:
                raw.append((_utc(d, open_t, tz), _utc(d, close_time(market, d, close_t), tz)))
            d += timedelta(days=1)
    else:
        raise ValueError(f"unknown market {market}")
    return [(max(s, start), min(e, end)) for s, e in raw if e > start and s < end]


def day_expiry(market: str, at: datetime) -> datetime:
    """Expiry for DAY orders: the end of the current (or next) trading session.

    Crypto never closes, so its trading day ends at the next UTC midnight. Equity DAY
    orders expire at the session close, including early closes; FX at Friday 17:00 NY.
    """
    tomorrow = datetime.combine(at.date() + timedelta(days=1), time.min, tzinfo=UTC)
    if market == Market.CRYPTO_24_7:
        return tomorrow
    upcoming = sessions(market, at, at + timedelta(days=10))
    return upcoming[0][1] if upcoming else tomorrow


def is_open(market: str, at: datetime) -> bool:
    return bool(sessions(market, at, at + timedelta(seconds=1)))


def last_close(market: str, at: datetime) -> datetime | None:
    """End of the most recent session that finished at or before `at`."""
    if market == Market.CRYPTO_24_7:
        return None
    past = sessions(market, at - timedelta(days=10), at)
    complete = [e for _, e in past if e < at]
    return complete[-1] if complete else None


def status(market: str, at: datetime) -> dict:
    """Open/closed now plus the next transition time (None = never closes)."""
    if market == Market.CRYPTO_24_7:
        return {"market": market, "is_open": True, "next_change": None}
    upcoming = sessions(market, at, at + timedelta(days=10))
    open_now = bool(upcoming) and upcoming[0][0] <= at
    if open_now:
        nxt = upcoming[0][1]
    else:
        nxt = upcoming[0][0] if upcoming else None
    return {"market": market, "is_open": open_now, "next_change": nxt}
