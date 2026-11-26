from datetime import UTC, datetime, timedelta

from app.market import calendar
from app.market.types import Market


def dt(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=UTC)


def test_crypto_always_open():
    assert calendar.is_open(Market.CRYPTO_24_7, dt("2026-11-28T03:00"))  # Saturday
    assert calendar.status(Market.CRYPTO_24_7, dt("2026-11-28T03:00"))["next_change"] is None


def test_fx_weekly_session_in_new_york_time():
    # November: New York is UTC-5, so the week opens Sun 22:00 UTC and closes Fri 22:00 UTC.
    assert not calendar.is_open(Market.FX_24_5, dt("2026-11-28T12:00"))   # Saturday
    assert not calendar.is_open(Market.FX_24_5, dt("2026-11-29T21:59"))   # Sunday before open
    assert calendar.is_open(Market.FX_24_5, dt("2026-11-29T22:00"))
    assert calendar.is_open(Market.FX_24_5, dt("2026-12-04T21:59"))       # Friday
    assert not calendar.is_open(Market.FX_24_5, dt("2026-12-04T22:00"))
    # July (EDT, UTC-4): close moves to 21:00 UTC
    assert not calendar.is_open(Market.FX_24_5, dt("2026-07-10T21:30"))


def test_us_equity_hours_dst_and_holidays():
    assert calendar.is_open(Market.US_EQUITY, dt("2026-11-23T14:30"))     # Mon 09:30 EST
    assert not calendar.is_open(Market.US_EQUITY, dt("2026-11-23T14:29"))
    assert not calendar.is_open(Market.US_EQUITY, dt("2026-11-23T21:00"))
    assert not calendar.is_open(Market.US_EQUITY, dt("2026-11-26T16:00"))  # Thanksgiving
    assert calendar.is_open(Market.US_EQUITY, dt("2026-07-15T13:30"))      # EDT open
    st = calendar.status(Market.US_EQUITY, dt("2026-11-25T22:00"))         # Wed evening
    assert st["is_open"] is False and st["next_change"] == dt("2026-11-27T14:30")


def test_uk_equity_hours_and_bank_holidays():
    assert calendar.is_open(Market.UK_EQUITY, dt("2026-11-23T08:00"))      # GMT
    assert not calendar.is_open(Market.UK_EQUITY, dt("2026-11-23T16:30"))
    assert calendar.is_open(Market.UK_EQUITY, dt("2026-07-15T07:00"))      # BST: 08:00 local
    assert not calendar.is_open(Market.UK_EQUITY, dt("2026-12-28T10:00"))  # Boxing Day (sub)


def test_early_closes_are_dst_aware_and_clip_sessions():
    # Black Friday 2026: 13:00 New York (EST) = 18:00 UTC.
    assert calendar.is_open(Market.US_EQUITY, dt("2026-11-27T17:59"))
    assert not calendar.is_open(Market.US_EQUITY, dt("2026-11-27T18:00"))
    st = calendar.status(Market.US_EQUITY, dt("2026-11-27T17:59"))
    assert st["is_open"] is True and st["next_change"] == dt("2026-11-27T18:00")
    assert calendar.sessions(Market.US_EQUITY, dt("2026-11-27T14:00"), dt("2026-11-27T23:00")) == [
        (dt("2026-11-27T14:30"), dt("2026-11-27T18:00"))]
    assert calendar.last_close(Market.US_EQUITY, dt("2026-11-27T19:00")) == dt("2026-11-27T18:00")

    # 2027-11-26 is still 13:00 local; in EST that is 18:00 UTC (a summer 13:00
    # local close would be 17:00 UTC). Christmas Eve 2027 is an observed full holiday.
    friday = calendar.sessions(Market.US_EQUITY, dt("2027-11-26T14:00"), dt("2027-11-26T22:00"))
    assert friday[0][1] == dt("2027-11-26T18:00")
    summer = calendar.sessions(Market.US_EQUITY, dt("2027-07-15T13:00"), dt("2027-07-15T21:00"))
    assert summer[0][1] == dt("2027-07-15T20:00")
    assert not calendar.is_open(Market.US_EQUITY, dt("2027-12-24T15:00"))

    # LSE half days: 12:30 local in both GMT and BST.
    for day in ("2026-12-24", "2026-12-31", "2027-12-24", "2027-12-31"):
        s = calendar.sessions(Market.UK_EQUITY, dt(f"{day}T07:00"), dt(f"{day}T20:00"))
        assert s[0][1] == dt(f"{day}T12:30")
    assert not calendar.is_open(Market.UK_EQUITY, dt("2026-12-24T12:30"))


def test_day_order_expiry_uses_the_session_close_including_early_closes():
    assert calendar.day_expiry(Market.CRYPTO_24_7, dt("2026-11-28T03:00")) == dt("2026-11-29T00:00")
    # Black Friday closes at 13:00 New York = 18:00 UTC; the order dies at that close.
    assert calendar.day_expiry(Market.US_EQUITY, dt("2026-11-27T15:00")) == dt("2026-11-27T18:00")
    assert calendar.day_expiry(Market.US_EQUITY, dt("2026-11-27T18:00")) == dt("2026-11-30T21:00")
    # FX DAY orders expire at the Friday close of the New York week, not UTC midnight.
    assert calendar.day_expiry(Market.FX_24_5, dt("2026-11-28T12:00")) == dt("2026-12-04T22:00")
    assert calendar.day_expiry(Market.UK_EQUITY, dt("2026-12-24T08:30")) == dt("2026-12-24T12:30")


def test_sessions_are_clipped_and_last_close():
    start, end = dt("2026-11-23T15:00"), dt("2026-11-24T15:00")
    s = calendar.sessions(Market.US_EQUITY, start, end)
    assert s == [(dt("2026-11-23T15:00"), dt("2026-11-23T21:00")),
                 (dt("2026-11-24T14:30"), dt("2026-11-24T15:00"))]
    assert calendar.last_close(Market.US_EQUITY, dt("2026-11-30T10:00")) == dt("2026-11-27T18:00")  # Black Friday early close
    assert calendar.last_close(Market.CRYPTO_24_7, dt("2026-11-30T10:00")) is None
    assert calendar.sessions(Market.FX_24_5, end, start) == []
    assert len(calendar.sessions(Market.FX_24_5, start, start + timedelta(days=21))) == 4
