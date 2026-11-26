"""Optional shared Redis connection (AUREX_REDIS_URL). Without it the API runs single-node:
rate limits are kept in process.

Clients are keyed by event loop: a global client created in one loop cannot be closed from
another (TestClient starts its own lifespan loop), which otherwise raises
"Future attached to a different loop" during shutdown.
"""

import asyncio
import logging

import redis.asyncio as aioredis
from redis.exceptions import RedisError

from app.core.config import get_settings

log = logging.getLogger("aurex.redis")
_clients: dict[tuple[str, int | None], aioredis.Redis] = {}
_loops: dict[int, asyncio.AbstractEventLoop] = {}


def _loop() -> asyncio.AbstractEventLoop | None:
    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        return None


def get_redis() -> aioredis.Redis | None:
    url = get_settings().redis_url
    if not url:
        return None
    loop = _loop()
    key = (url, id(loop) if loop else None)
    if loop is not None:
        _loops[id(loop)] = loop
        # Drop clients belonging to loops that have already been torn down.
        for old_key in list(_clients):
            old_loop = _loops.get(old_key[1]) if old_key[1] is not None else None
            if old_loop is not None and old_loop.is_closed():
                _clients.pop(old_key, None)
                _loops.pop(old_key[1], None)
    if key not in _clients:
        _clients[key] = aioredis.from_url(url, socket_timeout=0.5, socket_connect_timeout=0.5, health_check_interval=30)
    return _clients[key]


async def close_redis() -> None:
    loop = _loop()
    current = id(loop) if loop else None
    for key, client in list(_clients.items()):
        if key[1] not in (None, current):
            continue                       # another loop owns this client
        try:
            await client.aclose()
        except (RedisError, OSError, RuntimeError) as e:  # noqa: BLE001 - shutdown must not fail the app
            log.debug("redis close: %s", e.__class__.__name__)
        _clients.pop(key, None)
    if current is not None:
        _loops.pop(current, None)
