"""Cross-replica fan-out for WebSocket events.

When AUREX_STREAM_FANOUT_ENABLED and AUREX_REDIS_URL are set, events are written to
one Redis Stream. Every API replica joins its own consumer group, so each replica
sees every event once and delivers it to its local WebSocket subscribers. A
replica that is not hosting a subscriber for a topic still reads the stream; the
subscription filters by channel. When Redis or the flag is absent, the same API
works in-process (the historical single-node behaviour).

Events are at-least-once: consumers deduplicate by event id.
"""

import asyncio
import fnmatch
import json
import logging
import time
import uuid
from collections import OrderedDict
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

from redis.exceptions import RedisError, ResponseError

from app.core.config import get_settings
from app.core.redis import get_redis

log = logging.getLogger("aurex.realtime")

STREAM = "aurex:stream:events"
MAXLEN = 5000
_SEEN_LIMIT = 10000


@dataclass(eq=False)
class Subscription:
    channels: set[str]
    queue: asyncio.Queue[dict] = field(default_factory=asyncio.Queue)


class EventBus:
    def __init__(self, enabled: bool, node_id: str, stream: str = STREAM, fingerprint: tuple = ()):
        self.enabled = enabled
        self.node_id = node_id
        self.fingerprint = fingerprint
        self.stream = stream
        self.group = f"aurex-node-{node_id}"
        self.consumer = uuid.uuid4().hex[:12]
        self._subs: set[Subscription] = set()
        self._seen: OrderedDict[str, None] = OrderedDict()
        self._local_leases: dict[str, tuple[str, float]] = {}
        self._task: asyncio.Task | None = None

    # -- local subscriptions -----------------------------------------------------
    @asynccontextmanager
    async def subscribe(self, *channels: str):
        """Yield a subscription whose `queue` receives matching events."""
        sub = Subscription(set(channels))
        self._subs.add(sub)
        try:
            yield sub
        finally:
            self._subs.discard(sub)

    def set_channels(self, sub: Subscription, channels: list[str]) -> None:
        sub.channels = set(channels)

    def _deliver(self, event_id: str, channel: str, data: dict) -> None:
        if event_id in self._seen:
            return
        self._seen[event_id] = None
        if len(self._seen) > _SEEN_LIMIT:
            self._seen.popitem(last=False)
        for sub in tuple(self._subs):
            if any(fnmatch.fnmatchcase(channel, pattern) for pattern in sub.channels):
                sub.queue.put_nowait({"id": event_id, "channel": channel, "data": data})

    # -- publishing --------------------------------------------------------------
    async def publish(self, channel: str, payload: dict) -> str:
        event_id = uuid.uuid4().hex
        if self.enabled:
            r = get_redis()
            if r is not None:
                try:
                    raw_id = await r.xadd(
                        self.stream,
                        {"channel": channel, "publisher": self.node_id,
                         "data": json.dumps(payload, default=str)},
                        maxlen=MAXLEN, approximate=True)
                    event_id = raw_id.decode() if isinstance(raw_id, bytes) else str(raw_id)
                except (RedisError, OSError) as e:
                    log.warning("event publish failed, delivering locally: %s", e)
        # Immediate local delivery keeps latency low; the stream read skips this id.
        self._deliver(event_id, channel, payload)
        return event_id

    # -- shared read loop --------------------------------------------------------
    async def run(self) -> None:
        if not self.enabled:
            return
        while True:
            r = get_redis()
            if r is None:
                await asyncio.sleep(1)
                continue
            try:
                try:
                    await r.xgroup_create(self.stream, self.group, id="$", mkstream=True)
                except ResponseError as e:
                    if "BUSYGROUP" not in str(e):
                        raise
                while True:
                    rows = await r.xreadgroup(
                        # Keep the block below get_redis()'s 0.5s socket timeout.
                        self.group, self.consumer, {self.stream: ">"}, count=100, block=200)
                    for _, messages in rows:
                        for mid, fields in messages:
                            try:
                                # redis-py returns byte keys and values unless decode_responses.
                                values = {
                                    (k.decode() if isinstance(k, bytes) else str(k)):
                                    (v.decode() if isinstance(v, bytes) else v)
                                    for k, v in fields.items()
                                }
                                event_id = mid.decode() if isinstance(mid, bytes) else str(mid)
                                self._deliver(event_id, values.get("channel", ""),
                                              json.loads(values.get("data", "{}")))
                            except (ValueError, TypeError, UnicodeError) as e:
                                log.warning("bad stream event %s: %s", mid, e)
                            finally:
                                await r.xack(self.stream, self.group, mid)
            except asyncio.CancelledError:
                raise
            except (RedisError, OSError) as e:
                log.warning("event stream read failed, retrying: %s", e)
                await asyncio.sleep(1)

    async def start(self) -> None:
        if self.enabled and (self._task is None or self._task.done()):
            r = get_redis()
            if r is not None:
                try:
                    await r.xgroup_create(self.stream, self.group, id="$", mkstream=True)
                except ResponseError as e:
                    if "BUSYGROUP" not in str(e):
                        raise
            self._task = asyncio.create_task(self.run(), name="aurex-event-bus")

    async def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None

    async def acquire_lease(self, key: str, ttl_seconds: float, owner: str | None = None) -> bool:
        """True if this subscriber should poll/publish a shared topic right now.

        A short Redis lease avoids N replicas hammering the same provider for the
        same symbol. Fail open to local polling if Redis is unavailable.
        """
        ttl = max(1, int(ttl_seconds))
        owner = owner or self.consumer
        if not self.enabled:
            # Single process: still elect one poller per topic so several sockets
            # on the same symbol/user do not publish duplicate events.
            now = time.monotonic()
            for key_, (_, until) in tuple(self._local_leases.items()):
                if until <= now:
                    self._local_leases.pop(key_, None)
            entry = self._local_leases.get(key)
            if entry is not None and entry[0] != owner:
                return False
            self._local_leases[key] = (owner, now + ttl)
            return True
        r = get_redis()
        if r is None:
            return True
        try:
            current = await r.get(key)
            if isinstance(current, bytes):
                current = current.decode()
            if current is not None and str(current) == owner:
                await r.expire(key, ttl)
                return True
            return bool(await r.set(key, owner, ex=ttl, nx=True))
        except (RedisError, OSError) as e:
            log.debug("lease %s failed: %s", key, e)
            return True


_bus: EventBus | None = None


def get_bus() -> EventBus:
    global _bus
    s = get_settings()
    fingerprint = (s.stream_fanout_enabled, s.redis_url, s.stream_node_id)
    if _bus is None or _bus.fingerprint != fingerprint:
        _bus = EventBus(
            enabled=bool(s.stream_fanout_enabled and s.redis_url),
            node_id=s.stream_node_id or uuid.uuid4().hex[:12], fingerprint=fingerprint)
    return _bus


async def start_bus() -> None:
    await get_bus().start()


async def stop_bus() -> None:
    if _bus is not None:
        await _bus.stop()
