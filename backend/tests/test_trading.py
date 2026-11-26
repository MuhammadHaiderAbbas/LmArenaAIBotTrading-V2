"""Phase 8 paper execution: OMS lifecycle, fills, ledger postings, positions and portfolio."""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from app.database.session import SessionLocal
from app.market.service import MarketService, ProviderUnavailable, Quote
from app.models import Execution, Order
from app.trading import execution as ex
from tests.conftest import API, admin_headers, auth_headers, new_client

D = Decimal
PRICES: dict[str, dict] = {}


def set_price(symbol: str, mid: str, spread: str = "0.0001", **flags):
    m, s = D(mid), D(spread)
    PRICES[symbol] = {"bid": m * (1 - s), "ask": m * (1 + s), "last": m, **flags}


@pytest.fixture(autouse=True)
def fake_quotes(monkeypatch):
    PRICES.clear()
    set_price("AAPL", "200")
    set_price("MSFT", "400")
    set_price("NVDA", "100")
    set_price("SPY", "500")
    set_price("QQQ", "450")
    set_price("BTC-USD", "50000")
    set_price("SHEL.L", "25")
    set_price("GBP/USD", "1.25", spread="0")

    async def quote(self, inst):
        p = PRICES.get(inst.symbol)
        if p is None or p.get("down"):
            raise ProviderUnavailable(f"no data for {inst.symbol}")
        open_ = p.get("open", True)
        stale = p.get("stale", False)
        return Quote(symbol=inst.symbol, last=p["last"], bid=p["bid"], ask=p["ask"], prev_close=None, change=None,
                     change_pct=None, as_of=datetime.now(UTC), source="test", market_open=open_, stale=stale,
                     tradable=open_ and not stale, age_seconds=0)

    monkeypatch.setattr(MarketService, "quote", quote)


async def setup(client, email="trader@example.com"):
    h = await auth_headers(client, email=email)
    acct = (await client.post(f"{API}/accounts", headers=h, json={"name": "Paper"})).json()
    return h, acct["id"]


async def order(client, h, aid, symbol="AAPL", side="BUY", qty="10", **kw):
    return await client.post(f"{API}/trading/orders", headers=h,
                             json={"account_id": aid, "symbol": symbol, "side": side, "quantity": qty, **kw})


async def ledger(client, h, aid):
    bal = (await client.get(f"{API}/accounts/{aid}/balances", headers=h)).json()
    assert bal["ledger_balanced"] is True
    return {ln["code"]: D(ln["balance"]) for ln in bal["lines"]}


def test_execution_model_prices():
    bid, ask, s = D("99.9"), D("100.1"), D("0.0002")
    assert ex.match("BUY", "MARKET", bid, ask, None, None, s).price == ask * (1 + s)
    assert ex.match("SELL", "MARKET", bid, ask, None, None, s).price == bid * (1 - s)
    assert ex.match("BUY", "LIMIT", bid, ask, D("100"), None, s) is None           # ask above limit
    f = ex.match("BUY", "LIMIT", bid, ask, D("100.11"), None, s)
    assert f.price == D("100.11")                                                     # never worse than limit
    assert ex.match("SELL", "LIMIT", bid, ask, D("99.8"), None, s).price == bid * (1 - s)
    assert ex.match("BUY", "STOP", bid, ask, None, D("101"), s) is None
    assert ex.match("BUY", "STOP", bid, ask, None, D("100"), s).price == ask * (1 + s)
    assert ex.match("SELL", "STOP", bid, ask, None, D("99.95"), s).price == bid * (1 - s)
    assert ex.match("SELL", "STOP", bid, ask, None, D("99.8"), s) is None


async def test_market_buy_posts_balanced_ledger_and_opens_position(client):
    h, aid = await setup(client)
    r = await order(client, h, aid, qty="10")
    assert r.status_code == 201, r.text
    o = r.json()
    assert o["status"] == "FILLED" and [e["type"] for e in o["events"]] == ["CREATED", "RISK_APPROVED", "FILLED"]
    exe = o["executions"][0]
    px = D("200") * D("1.0001") * (1 + ex.slippage("STOCK"))
    assert D(exe["price"]) == px and D(exe["reference_price"]) == D("200.0200")
    notional = (px * 10).quantize(D("0.00000001"))
    fee = (notional * ex.fee_rate("STOCK")).quantize(D("0.00000001"))
    assert D(exe["fee"]) == fee and D(exe["spread_cost"]) == D("0.2") and D(exe["slippage_cost"]) > 0

    lines = await ledger(client, h, aid)
    assert lines["CASH"] == D("100000") - notional - fee
    assert lines["INVESTMENTS"] == notional and lines["FEES"] == fee

    s = (await client.get(f"{API}/portfolio/summary?account_id={aid}", headers=h)).json()
    assert s["open_positions"] == 1 and D(s["cash"]) == lines["CASH"]
    p = s["positions"][0]
    assert p["symbol"] == "AAPL" and D(p["quantity"]) == 10 and D(p["avg_price"]) == px
    assert D(p["market_value"]) == D("1999.8")      # marked at the bid
    assert D(s["unrealised_pnl"]) == D(p["market_value"]) - notional
    assert D(s["equity"]) == lines["CASH"] + D(p["market_value"])
    assert 0 < s["exposure"] < 0.03 and set(s["allocation"]) == {"STOCK"}

    acct = (await client.get(f"{API}/accounts/{aid}", headers=h)).json()
    assert D(acct["cash_balance"]) == lines["CASH"]


async def test_round_trip_realises_pnl_and_closes_position(client):
    h, aid = await setup(client)
    buy = (await order(client, h, aid, qty="10")).json()
    set_price("AAPL", "220")
    sell = (await order(client, h, aid, side="SELL", qty="4")).json()
    assert sell["status"] == "FILLED"
    cost_per = D(buy["executions"][0]["price"])
    sx = sell["executions"][0]
    proceeds = (D(sx["price"]) * 4).quantize(D("0.00000001"))
    cost = ((cost_per * 10).quantize(D("0.00000001")) * 4 / 10).quantize(D("0.00000001"))
    assert D(sx["realised_pnl"]) == proceeds - cost > 0
    lines = await ledger(client, h, aid)
    assert lines["REALISED_PNL"] == proceeds - cost

    rest = (await order(client, h, aid, side="SELL", qty="6")).json()
    assert rest["status"] == "FILLED"
    s = (await client.get(f"{API}/portfolio/summary?account_id={aid}", headers=h)).json()
    assert s["open_positions"] == 0 and D(s["market_value"]) == 0
    lines = await ledger(client, h, aid)
    assert lines["INVESTMENTS"] == 0
    # equity identity: cash = opening + realised − fees
    assert lines["CASH"] == D("100000") + lines["REALISED_PNL"] - lines["FEES"]
    closed = (await client.get(f"{API}/trading/positions/closed?account_id={aid}", headers=h)).json()
    assert len(closed) == 1 and D(closed[0]["realised_pnl"]) == lines["REALISED_PNL"]

    exes = (await client.get(f"{API}/trading/executions?account_id={aid}", headers=h)).json()
    assert exes["total"] == 3
    led = (await client.get(f"{API}/accounts/{aid}/ledger", headers=h)).json()
    assert {t["type"] for t in led["items"]} == {"INITIAL_FUNDING", "TRADE_BUY", "TRADE_SELL"}


async def test_losing_trade_debits_realised_pnl(client):
    h, aid = await setup(client)
    await order(client, h, aid, symbol="BTC-USD", qty="0.1")
    set_price("BTC-USD", "45000")
    r = (await order(client, h, aid, symbol="BTC-USD", side="SELL", qty="0.1")).json()
    assert D(r["executions"][0]["realised_pnl"]) < 0
    lines = await ledger(client, h, aid)
    assert lines["REALISED_PNL"] < 0 and lines["INVESTMENTS"] == 0


async def test_foreign_currency_instrument_converts_to_account_currency(client):
    h, aid = await setup(client)
    o = (await order(client, h, aid, symbol="SHEL.L", qty="100")).json()
    assert o["status"] == "FILLED", o
    exe = o["executions"][0]
    assert D(exe["fx_rate"]) == D("1.25")
    notional = (D(exe["price"]) * 100 * D("1.25")).quantize(D("0.00000001"))
    lines = await ledger(client, h, aid)
    assert lines["INVESTMENTS"] == notional
    s = (await client.get(f"{API}/portfolio/summary?account_id={aid}", headers=h)).json()
    p = s["positions"][0]
    assert p["quote_currency"] == "GBP" and D(p["market_value"]) == (D("25") * D("0.9999") * 100 * D("1.25"))

    PRICES["GBP/USD"]["down"] = True
    r = (await order(client, h, aid, symbol="SHEL.L", qty="1")).json()
    assert r["status"] == "REJECTED" and "FX" in r["reject_reason"]


async def test_limit_and_stop_orders_fill_through_matcher(client):
    h, aid = await setup(client)
    lim = (await order(client, h, aid, type="LIMIT", limit_price="195.00", qty="5")).json()
    assert lim["status"] == "OPEN" and lim["expires_at"] and [e["type"] for e in lim["events"]] == ["CREATED", "RISK_APPROVED", "ACCEPTED"]
    ah = await admin_headers(client)
    assert (await client.post(f"{API}/trading/process", headers=h)).status_code == 403
    stats = (await client.post(f"{API}/trading/process", headers=ah)).json()
    assert stats["checked"] == 1 and stats["filled"] == 0

    # reserved cash reduces buying power while the order rests
    s = (await client.get(f"{API}/portfolio/summary?account_id={aid}", headers=h)).json()
    assert D(s["available_cash"]) < D(s["cash"]) - D("975")

    set_price("AAPL", "190")
    stats = (await client.post(f"{API}/trading/process", headers=ah)).json()
    assert stats["filled"] == 1
    filled = (await client.get(f"{API}/trading/orders/{lim['id']}", headers=h)).json()
    assert filled["status"] == "FILLED" and D(filled["avg_fill_price"]) <= D("195")

    stop = (await order(client, h, aid, side="SELL", type="STOP", stop_price="180.00", qty="5")).json()
    assert stop["status"] == "OPEN"
    await client.post(f"{API}/trading/process", headers=ah)
    assert (await client.get(f"{API}/trading/orders/{stop['id']}", headers=h)).json()["status"] == "OPEN"
    set_price("AAPL", "175")
    await client.post(f"{API}/trading/process", headers=ah)
    done = (await client.get(f"{API}/trading/orders/{stop['id']}", headers=h)).json()
    assert done["status"] == "FILLED" and D(done["avg_fill_price"]) < D("180")
    await ledger(client, h, aid)


async def test_day_order_expiry_uses_the_calendar_not_utc_midnight(client, monkeypatch):
    from app.trading import service as trading_service

    close = datetime(2026, 11, 27, 18, 0, tzinfo=UTC)   # Black Friday early close
    monkeypatch.setattr(trading_service, "day_expiry", lambda inst, at: close)
    h, aid = await setup(client)
    o = (await order(client, h, aid, type="LIMIT", limit_price="195.00", qty="1",
                     time_in_force="DAY")).json()
    assert o["status"] == "OPEN" and o["expires_at"].startswith("2026-11-27T18:00")


async def test_matcher_skips_closed_markets_and_expires_orders(client):
    h, aid = await setup(client)
    o = (await order(client, h, aid, type="LIMIT", limit_price="205.00", qty="1", time_in_force="DAY")).json()
    # limit above the ask fills immediately on the next pass... unless the market is closed
    PRICES["AAPL"]["open"] = False
    ah = await admin_headers(client)
    assert (await client.post(f"{API}/trading/process", headers=ah)).json()["filled"] == 0
    async with SessionLocal() as db:
        await db.execute(text("UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = :i"),
                         {"i": o["id"]})
        await db.commit()
    assert (await client.post(f"{API}/trading/process", headers=ah)).json()["expired"] == 1
    got = (await client.get(f"{API}/trading/orders/{o['id']}", headers=h)).json()
    assert got["status"] == "EXPIRED" and got["events"][-1]["type"] == "EXPIRED"


async def test_cancel_open_order(client):
    h, aid = await setup(client)
    o = (await order(client, h, aid, type="LIMIT", limit_price="150.00")).json()
    r = await client.post(f"{API}/trading/orders/{o['id']}/cancel", headers=h)
    assert r.status_code == 200 and r.json()["status"] == "CANCELLED"
    assert (await client.post(f"{API}/trading/orders/{o['id']}/cancel", headers=h)).status_code == 422
    async with new_client() as other:
        oh = await auth_headers(other, email="other@example.com")
        assert (await other.post(f"{API}/trading/orders/{o['id']}/cancel", headers=oh)).status_code == 404
    ah = await admin_headers(client)
    audit = (await client.get(f"{API}/admin/audit?action=order.cancel", headers=ah)).json()
    assert audit["total"] == 1


async def test_idempotent_client_order_id(client):
    h, aid = await setup(client)
    r1 = await order(client, h, aid, client_order_id="ticket-0001")
    r2 = await order(client, h, aid, client_order_id="ticket-0001")
    assert r1.status_code == 201 and r2.status_code == 200 and r2.headers["Idempotent-Replay"] == "true"
    assert r1.json()["id"] == r2.json()["id"]
    exes = (await client.get(f"{API}/trading/executions?account_id={aid}", headers=h)).json()
    assert exes["total"] == 1


async def test_business_rejections_are_persisted_with_reasons(client):
    h, aid = await setup(client)
    r = await order(client, h, aid, side="SELL", qty="1")
    assert r.status_code == 201 and r.json()["status"] == "REJECTED"
    assert "short selling is disabled" in r.json()["reject_reason"]

    r = (await order(client, h, aid, qty="1000")).json()         # 200k > 100k cash, no leverage
    assert r["status"] == "REJECTED" and "insufficient cash" in r["reject_reason"]

    PRICES["AAPL"]["open"] = False
    r = (await order(client, h, aid, qty="1")).json()
    assert r["status"] == "REJECTED" and r["reject_reason"] == "market is closed"
    PRICES["AAPL"].update(open=True, stale=True)
    assert (await order(client, h, aid, qty="1")).json()["reject_reason"] == "quote is stale"
    PRICES["AAPL"]["down"] = True
    assert (await order(client, h, aid, qty="1")).json()["reject_reason"] == "no market data available"
    PRICES["AAPL"].update(down=False, stale=False)

    for sym in ("AAPL", "MSFT", "NVDA", "SPY", "QQQ"):
        assert (await order(client, h, aid, symbol=sym, qty="1")).json()["status"] == "FILLED"
    r = (await order(client, h, aid, symbol="BTC-USD", qty="0.001")).json()
    assert r["status"] == "REJECTED" and "maximum of 5" in r["reject_reason"]
    assert (await order(client, h, aid, symbol="AAPL", qty="1")).json()["status"] == "FILLED"   # adding is fine

    # sells cannot oversubscribe a position through resting orders
    assert (await order(client, h, aid, side="SELL", type="LIMIT", limit_price="900.00", qty="2")).json()["status"] == "OPEN"
    r = (await order(client, h, aid, side="SELL", qty="1")).json()
    assert r["status"] == "REJECTED" and "already in open sell orders" in r["reject_reason"]

    listing = (await client.get(f"{API}/trading/orders?account_id={aid}&status=REJECTED", headers=h)).json()
    assert listing["total"] == 7
    await ledger(client, h, aid)
    ah = await admin_headers(client)
    audit = (await client.get(f"{API}/admin/audit?action=order.submit", headers=ah)).json()
    assert audit["total"] == 14


async def test_small_gbp_account_can_trade_fractional_shares_and_fx(client):
    """A £100 account: fractional US shares (converted to GBP), 1-unit FX lots, and a £1 minimum order."""
    h = await auth_headers(client, email="small@example.com")
    acct = (await client.post(f"{API}/accounts", headers=h,
                              json={"name": "£100", "base_currency": "GBP", "starting_balance": "100"})).json()
    aid = acct["id"]
    r = (await order(client, h, aid, qty="0.05")).json()                   # 0.05 AAPL ≈ $10 ≈ £8
    assert r["status"] == "FILLED", r.get("reject_reason")
    r = (await order(client, h, aid, symbol="GBP/USD", qty="10")).json()   # £10 of cable
    assert r["status"] == "FILLED", r.get("reject_reason")
    r = (await order(client, h, aid, qty="0.0001")).json()                 # ≈ 2p: below the £1 minimum
    assert r["status"] == "REJECTED" and "below the minimum order of 1.00 GBP" in r["reject_reason"]
    r = (await order(client, h, aid, qty="2")).json()                      # ≈ £315: no leverage
    assert r["status"] == "REJECTED" and "insufficient cash" in r["reject_reason"]
    sell = (await order(client, h, aid, side="SELL", qty="0.0001")).json()  # tiny exits are always allowed
    assert sell["status"] == "FILLED", sell.get("reject_reason")
    await ledger(client, h, aid)


async def test_order_shape_validation(client):
    h, aid = await setup(client)
    assert (await order(client, h, aid, qty="1.00005")).status_code == 422                   # lot size 0.0001
    assert (await order(client, h, aid, type="LIMIT")).status_code == 422                    # no limit price
    assert (await order(client, h, aid, type="LIMIT", limit_price="1.234")).status_code == 422  # tick
    assert (await order(client, h, aid, limit_price="200.00")).status_code == 422            # market + limit
    assert (await order(client, h, aid, type="STOP")).status_code == 422
    assert (await order(client, h, aid, qty="0")).status_code == 422
    assert (await order(client, h, aid, symbol="NOPE")).status_code == 404
    assert (await order(client, h, aid, client_order_id="bad id!")).status_code == 422
    assert (await order(client, h, aid, symbol="BTC-USD", qty="0.00012345")).json()["status"] == "FILLED"   # 8-dp lot, ≈ $6
    assert "below the minimum" in (await order(client, h, aid, symbol="BTC-USD", qty="0.00000001")).json()["reject_reason"]


async def test_privacy_between_users(client):
    h, aid = await setup(client)
    o = (await order(client, h, aid)).json()
    async with new_client() as other:
        oh, oaid = await setup(other, email="other@example.com")
        assert (await order(other, oh, aid)).status_code == 404
        assert (await other.get(f"{API}/trading/orders/{o['id']}", headers=oh)).status_code == 404
        assert (await other.get(f"{API}/trading/orders?account_id={aid}", headers=oh)).status_code == 404
        assert (await other.get(f"{API}/trading/orders", headers=oh)).json()["total"] == 0
        assert (await other.get(f"{API}/portfolio/summary?account_id={aid}", headers=oh)).status_code == 404
        assert (await other.get(f"{API}/portfolio/history?account_id={aid}", headers=oh)).status_code == 404
        assert (await other.get(f"{API}/trading/executions", headers=oh)).json()["total"] == 0


async def test_portfolio_history_and_append_only_executions(client):
    h, aid = await setup(client)
    await order(client, h, aid)
    await order(client, h, aid, side="SELL", qty="10")
    hist = (await client.get(f"{API}/portfolio/history?account_id={aid}", headers=h)).json()
    assert [s["reason"] for s in hist] == ["fill", "fill"]
    assert all(D(s["equity"]) == D(s["cash"]) + D(s["market_value"]) for s in hist)
    async with SessionLocal() as db:
        exe = await db.scalar(select(Execution))
        with pytest.raises(DBAPIError):
            await db.execute(text("UPDATE executions SET price = 1 WHERE id = :i"), {"i": exe.id})
            await db.commit()
        await db.rollback()
        with pytest.raises(DBAPIError):
            await db.execute(text("DELETE FROM order_events"))
            await db.commit()


async def test_order_and_position_constraints_in_db(client):
    h, aid = await setup(client)
    await order(client, h, aid)
    async with SessionLocal() as db:
        o = await db.scalar(select(Order))
        with pytest.raises(DBAPIError):
            await db.execute(text("UPDATE orders SET type = 'LIMIT', limit_price = NULL WHERE id = :i"), {"i": o.id})
            await db.commit()
        await db.rollback()
        with pytest.raises(DBAPIError):  # a second OPEN position for the same symbol
            await db.execute(text(
                "INSERT INTO positions (id, account_id, instrument_id, symbol, quantity, avg_price, cost_basis, "
                "realised_pnl, fees, status, opened_at, created_at, updated_at) SELECT gen_random_uuid(), account_id, "
                "instrument_id, symbol, 1, 1, 1, 0, 0, 'OPEN', now(), now(), now() FROM positions"))
            await db.commit()
    assert datetime.now(UTC) - timedelta(minutes=5) < datetime.now(UTC)
