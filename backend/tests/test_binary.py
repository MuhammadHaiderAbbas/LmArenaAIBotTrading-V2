"""Paper binary options: risk gate, ledger, settlement (won/lost/tie/void), stats, idempotency, privacy."""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy import text

from app.binary.service import BinaryService, expected_return
from app.database.session import SessionLocal
from app.ops import worker
from app.risk import engine
from tests.conftest import API, auth_headers, new_client
from tests.test_trading import PRICES, fake_quotes, ledger, set_price  # noqa: F401  (autouse fixture)

D = Decimal


async def small_account(client, email="binary@example.com", balance="100"):
    h = await auth_headers(client, email=email)
    acct = (await client.post(f"{API}/accounts", headers=h,
                              json={"name": "£100", "base_currency": "GBP", "starting_balance": balance})).json()
    return h, acct["id"]


async def open_(client, h, aid, direction="HIGHER", stake="2.00", expiry=60, symbol="BTC-USD", **kw):
    return await client.post(f"{API}/binary/contracts", headers=h, json={
        "account_id": aid, "symbol": symbol, "direction": direction, "stake": stake, "expiry_seconds": expiry, **kw})


async def expire_all(seconds_ago: int = 1):
    """Move every open contract's clock back so it has expired `seconds_ago` seconds ago."""
    async with SessionLocal() as db:
        await db.execute(text("""UPDATE binary_contracts SET
            opened_at = now() - make_interval(secs => expiry_seconds + :s),
            expires_at = now() - make_interval(secs => :s) WHERE status = 'OPEN'"""), {"s": seconds_ago})
        await db.commit()


def test_break_even_maths():
    assert abs(1 / 1.8 - 0.5556) < 1e-4
    assert abs(expected_return(0.5, 0.8) + 0.1) < 1e-12        # a coin flip loses 10% of every stake
    assert abs(expected_return(1 / 1.8, 0.8)) < 1e-12


async def test_config_and_disclosure(client):
    h, _ = await small_account(client)
    cfg = (await client.get(f"{API}/binary/config", headers=h)).json()
    assert cfg["paper_only"] is True and cfg["payout_rate"] == 0.8 and 60 in cfg["expiries"]
    assert abs(cfg["break_even_win_rate"] - 1 / 1.8) < 1e-9
    assert abs(cfg["coin_flip_expected_return"] + 0.1) < 1e-9
    assert "banned for retail customers in the UK" in cfg["notice"]


async def test_win_loss_tie_and_ledger(client):
    h, aid = await small_account(client)
    set_price("BTC-USD", "50000", spread="0")
    up = (await open_(client, h, aid, "HIGHER", "2.00")).json()
    down = (await open_(client, h, aid, "LOWER", "2.00")).json()
    flat = (await open_(client, h, aid, "HIGHER", "1.50")).json()
    assert up["status"] == "OPEN" and D(up["strike"]) == D("50000") and D(up["potential_return"]) == D("3.60")

    s = (await client.get(f"{API}/portfolio/summary?account_id={aid}", headers=h)).json()
    assert D(s["binary_at_risk"]) == D("5.50") and D(s["cash"]) == D("94.50")
    assert D(s["equity"]) == D("100")                 # stakes are carried at cost while open
    assert s["allocation"]["BINARY"] > 0

    # the flat one ties: expire everything, but push the other two back out so only it settles at the strike
    await expire_all()
    async with SessionLocal() as db:
        await db.execute(text("UPDATE binary_contracts SET expires_at = now() + interval '1 hour' WHERE id <> :i"),
                         {"i": flat["id"]})
        await db.commit()
    got = (await client.get(f"{API}/binary/contracts/{flat['id']}", headers=h)).json()
    assert got["status"] == "TIE" and D(got["pnl"]) == 0 and D(got["returned"]) == D("1.50")

    await expire_all()
    set_price("BTC-USD", "50100", spread="0")       # price went up
    assert (await worker.one_pass())["binary"]["settled"] == 2
    items = {c["id"]: c for c in (await client.get(f"{API}/binary/contracts?account_id={aid}", headers=h)).json()["items"]}
    assert items[up["id"]]["status"] == "WON" and D(items[up["id"]]["pnl"]) == D("1.6")
    assert D(items[up["id"]]["returned"]) == D("3.6") and D(items[up["id"]]["settle_price"]) == D("50100")
    assert items[down["id"]]["status"] == "LOST" and D(items[down["id"]]["pnl"]) == D("-2")

    led = await ledger(client, h, aid)
    assert led["CASH"] == D("100") - D("2") - D("2") - D("1.5") + D("1.5") + D("3.6")
    assert led.get("INVESTMENTS", D(0)) == 0
    s = (await client.get(f"{API}/portfolio/summary?account_id={aid}", headers=h)).json()
    assert D(s["equity"]) == D("99.6") and D(s["binary_at_risk"]) == 0

    st = (await client.get(f"{API}/binary/stats?account_id={aid}", headers=h)).json()
    assert st["paper_only"] is True
    assert (st["won"], st["lost"], st["ties"], st["open"]) == (1, 1, 1, 0)
    assert st["win_rate"] == 0.5 and abs(st["expected_return_at_win_rate"] + 0.1) < 1e-9
    assert st["edge_vs_break_even"] < 0 and D(st["net_pnl"]) == D("-0.4")
    assert st["by_direction"]["HIGHER"]["won"] == 1 and st["by_expiry"]["60"]["contracts"] == 3


async def test_void_after_no_price(client):
    h, aid = await small_account(client)
    c = (await open_(client, h, aid)).json()
    PRICES["BTC-USD"]["down"] = True
    await expire_all(seconds_ago=5)
    assert (await client.get(f"{API}/binary/contracts/{c['id']}", headers=h)).json()["status"] == "OPEN"
    await expire_all(seconds_ago=700)                # beyond binary_void_after_seconds (600)
    got = (await client.get(f"{API}/binary/contracts/{c['id']}", headers=h)).json()
    assert got["status"] == "VOID" and D(got["returned"]) == D("2") and got["void_reason"]
    assert (await ledger(client, h, aid))["CASH"] == D("100")


async def test_risk_gate(client):
    h, aid = await small_account(client)
    r = await open_(client, h, aid, stake="2.01")      # 2.01% of £100 > 2% default
    assert r.status_code == 422 and r.json()["error"]["code"] == "risk_rejected"
    checks = {c["name"]: c for c in r.json()["error"]["details"]["checks"]}
    assert not checks["binary_stake"]["passed"] and "whole stake is lost" in checks["binary_stake"]["message"]
    r = await open_(client, h, aid, stake="0.50")
    assert r.status_code == 422 and "below the minimum" in r.json()["error"]["message"]
    for _ in range(3):
        assert (await open_(client, h, aid, stake="1.00")).status_code == 201
    r = await open_(client, h, aid, stake="1.00")
    assert r.status_code == 422 and "maximum of 3 open binary contracts" in r.json()["error"]["message"]

    assert (await open_(client, h, aid, expiry=61)).status_code == 422          # not an offered expiry
    assert (await open_(client, h, aid, stake="1.001")).status_code == 422      # 2 decimals
    assert (await open_(client, h, aid, direction="SIDEWAYS")).status_code == 422

    # switch binaries off in the Risk Centre; loosening the stake cap is bounded by the ceiling
    assert (await client.put(f"{API}/risk/accounts/{aid}/limits", headers=h, json={"binary_enabled": False})).status_code == 200
    r = await open_(client, h, aid, stake="1.00")
    assert r.status_code == 422 and "switched off" in r.json()["error"]["message"]
    assert (await client.put(f"{API}/risk/accounts/{aid}/limits", headers=h, json={"binary_max_stake_pct": 6})).status_code == 422
    ov = (await client.get(f"{API}/risk/accounts/{aid}", headers=h)).json()
    assert ov["limits"]["binary_enabled"] is False and ov["limits"]["binary_max_open"] == 3
    assert ov["ceilings"]["binary_max_stake_pct"] == engine.CEILINGS["binary_max_stake_pct"]

    # kill switch blocks binaries too
    await client.put(f"{API}/risk/accounts/{aid}/limits", headers=h, json={"binary_enabled": True})
    assert (await client.post(f"{API}/risk/accounts/{aid}/kill-switch", headers=h, json={"engaged": True, "reason": "stop"})).status_code == 200
    r = await open_(client, h, aid, stake="1.00")
    assert r.status_code == 422 and "kill switch" in r.json()["error"]["message"]

    async with SessionLocal() as db:
        n = await db.scalar(text("SELECT count(*) FROM risk_decisions WHERE source = 'binary'"))
        rejected = await db.scalar(text("SELECT count(*) FROM risk_decisions WHERE source = 'binary' AND NOT approved"))
    assert n == 8 and rejected == 5


async def test_market_must_stay_open_until_expiry(client):
    h, aid = await small_account(client)
    PRICES["AAPL"]["open"] = False
    r = await open_(client, h, aid, symbol="AAPL")
    assert r.status_code == 422 and r.json()["error"]["message"] == "market is closed"
    r = await open_(client, h, aid, symbol="AAPL", expiry=86400)   # a day is always past the US close
    assert r.status_code == 422


async def test_idempotency_audit_and_privacy(client):
    h, aid = await small_account(client)
    a = await open_(client, h, aid, client_id="binary-0001")
    b = await open_(client, h, aid, client_id="binary-0001")
    assert a.status_code == 201 and b.status_code == 200 and a.json()["id"] == b.json()["id"]
    assert b.headers["Idempotent-Replay"] == "true"
    async with new_client() as other:
        oh, oaid = await small_account(other, email="other-binary@example.com")
        assert (await other.get(f"{API}/binary/contracts/{a.json()['id']}", headers=oh)).status_code == 404
        assert (await other.get(f"{API}/binary/contracts?account_id={aid}", headers=oh)).status_code == 404
        assert (await open_(other, oh, aid)).status_code == 404
        assert (await other.get(f"{API}/binary/stats?account_id={aid}", headers=oh)).status_code == 404
    async with SessionLocal() as db:
        n = await db.scalar(text("SELECT count(*) FROM audit_logs WHERE action = 'binary.open'"))
        assert n == 1
        svc = BinaryService(db)
        assert (await svc.settle_due())["checked"] == 0          # nothing expired yet
    assert datetime.now(UTC) - timedelta(seconds=5) < datetime.fromisoformat(a.json()["opened_at"])
