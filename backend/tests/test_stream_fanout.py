"""Phase 5: WebSocket fan-out across API replicas via Redis Streams."""

import asyncio
import uuid
from datetime import UTC, datetime
from decimal import Decimal

import pytest
import redis as sync_redis
from fastapi.testclient import TestClient

from app.core.redis import close_redis
from app.core.security import decode_access_token
from app.main import app
from app.market import service as market_service
from app.market.types import RawQuote
from app.realtime.bus import EventBus
from tests.conftest import API, auth_headers
from tests.test_security import settings_env

REDIS_URL = "redis://localhost:6379/14"


def redis_available() -> bool:
    try:
        sync_redis.Redis.from_url(REDIS_URL, socket_connect_timeout=0.3).ping()
        return True
    except Exception:  # noqa: BLE001
        return False


needs_redis = pytest.mark.skipif(not redis_available(), reason="Redis not running")


class LocalQuote:
    """Avoid real provider calls in stream tests."""

    name = "coinbase"

    async def get_quote(self, inst):
        return RawQuote(Decimal("90000"), Decimal("89999"), Decimal("90001"), Decimal("89000"),
                        datetime.now(UTC), self.name)

    async def get_candles(self, inst, timeframe, start, end):
        return []


def _until(ws, pred, limit=60):
    for _ in range(limit):
        msg = ws.receive_json()
        if pred(msg):
            return msg
    raise AssertionError("expected message not received")


@needs_redis
async def test_stream_bus_reaches_two_nodes_and_respects_channels(monkeypatch):
    sync_redis.Redis.from_url(REDIS_URL).flushdb()
    settings_env(monkeypatch, redis_url=REDIS_URL, stream_fanout_enabled=True,
                 stream_node_id="unit")
    try:
        node_a, node_b = EventBus(True, "node-a"), EventBus(True, "node-b")
        await node_a.start()
        await node_b.start()
        try:
            async with node_a.subscribe("quote:*") as a, node_b.subscribe("quote:BTC-USD") as b:
                event_id = await node_a.publish("quote:BTC-USD", {"symbol": "BTC-USD"})
                from_a = await asyncio.wait_for(a.queue.get(), 2)
                from_b = await asyncio.wait_for(b.queue.get(), 2)
                assert from_a["id"] == from_b["id"] == event_id
                assert from_a["data"]["symbol"] == "BTC-USD"
                # The publisher does not receive its own event twice from the stream.
                with pytest.raises(TimeoutError):
                    await asyncio.wait_for(a.queue.get(), 0.8)

            async with node_b.subscribe("quote:ETH-USD") as wrong:
                await node_a.publish("quote:BTC-USD", {"symbol": "BTC-USD"})
                with pytest.raises(TimeoutError):
                    await asyncio.wait_for(wrong.queue.get(), 0.8)
        finally:
            await node_a.stop()
            await node_b.stop()
    finally:
        sync_redis.Redis.from_url(REDIS_URL).delete("aurex:stream:events")
        await close_redis()


@needs_redis
async def test_quote_stream_delivers_events_from_another_node(monkeypatch, client):
    token = (await auth_headers(client))["Authorization"].split()[1]
    sync_redis.Redis.from_url(REDIS_URL).flushdb()
    settings_env(monkeypatch, redis_url=REDIS_URL, stream_fanout_enabled=True,
                 stream_node_id="node-a", stream_interval_seconds="0.15")
    market_service.set_provider("coinbase", LocalQuote())
    remote = EventBus(True, "node-b")
    await remote.start()
    try:
        with TestClient(app) as tc:
            with tc.websocket_connect(f"{API}/markets/stream") as ws:
                ws.send_json({"type": "auth", "token": token})
                assert ws.receive_json()["type"] == "ready"
                ws.send_json({"type": "subscribe", "symbols": ["BTC-USD"]})
                first = ws.receive_json()
                assert first["type"] == "quotes" and first["data"][0]["symbol"] == "BTC-USD"

                await remote.publish("quote:BTC-USD", {
                    "symbol": "BTC-USD", "last": "1", "bid": "1", "ask": "1",
                    "prev_close": "1", "change": "0", "change_pct": "0",
                    "as_of": datetime.now(UTC).isoformat(), "source": "remote-feed",
                    "market_open": True, "stale": False, "tradable": True,
                    "age_seconds": 0, "pricing": "actual",
                })
                cross_node = _until(ws, lambda m: any(
                    q["source"] == "remote-feed" for q in m.get("data", [])))
                assert cross_node["type"] == "quotes"
                # An unsubscribed symbol from another node must not reach this client.
                await remote.publish("quote:ETH-USD", {
                    "symbol": "ETH-USD", "source": "remote-feed", "last": "1"})
                for _ in range(4):
                    msg = ws.receive_json()
                    assert all(q["symbol"] == "BTC-USD" for q in msg.get("data", []))
    finally:
        await remote.stop()
        sync_redis.Redis.from_url(REDIS_URL).delete("aurex:stream:events")
        await close_redis()


@needs_redis
async def test_account_stream_delivers_changes_from_another_node(monkeypatch, client):
    h = await auth_headers(client)
    token = h["Authorization"].split()[1]
    user_id = str(uuid.UUID(decode_access_token(token)["sub"]))
    aid = (await client.post(f"{API}/accounts", headers=h, json={
        "name": "Fan-out", "base_currency": "GBP", "starting_balance": "100"})).json()["id"]
    sync_redis.Redis.from_url(REDIS_URL).flushdb()
    settings_env(monkeypatch, redis_url=REDIS_URL, stream_fanout_enabled=True,
                 stream_node_id="node-a", account_stream_interval_seconds="0.15",
                 account_valuation_interval_seconds="0.15")
    remote = EventBus(True, "node-b")
    await remote.start()
    try:
        with TestClient(app) as tc:
            with tc.websocket_connect(f"{API}/stream/account") as ws:
                ws.send_json({"type": "auth", "token": token})
                ready = ws.receive_json()
                assert ready["type"] == "ready" and ready["accounts"] == [aid]
                await remote.publish(f"account:{user_id}", {
                    "type": "changed", "account_id": aid, "topics": ["cross-node"]})
                event = _until(ws, lambda m: "cross-node" in m.get("topics", []))
                assert event["account_id"] == aid
    finally:
        await remote.stop()
        sync_redis.Redis.from_url(REDIS_URL).delete("aurex:stream:events")
        await close_redis()
