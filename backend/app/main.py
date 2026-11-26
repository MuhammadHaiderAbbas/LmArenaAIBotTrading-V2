import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api.router import api_router
from app.core.config import get_settings
from app.core.errors import register_error_handlers
from app.core.middleware import BodySizeLimitMiddleware, RateLimitMiddleware, RequestContextMiddleware

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


log = logging.getLogger("aurex.matcher")


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.core.redis import close_redis
    from app.ops import worker
    from app.realtime.bus import start_bus, stop_bus

    s = get_settings()
    interval = s.order_matcher_interval_seconds
    task = asyncio.create_task(worker.run(interval)) if interval > 0 and s.background_worker else None
    await start_bus()
    yield
    await stop_bus()
    if task:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    await close_redis()


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(
        lifespan=lifespan,
        title=f"{s.app_name} API",
        version=__version__,
        description=(
            "AUREX AI — autonomous multi-market research & paper-trading platform.\n\n"
            "**Stage 1: paper trading only. Virtual capital; no real money is moved.**"
        ),
        openapi_url=f"{s.api_prefix}/openapi.json" if s.docs_enabled else None,
        docs_url=f"{s.api_prefix}/docs" if s.docs_enabled else None,
        redoc_url=f"{s.api_prefix}/redoc" if s.docs_enabled else None,
    )
    # Starlette applies the last-added middleware outermost: rate limit -> body size -> CORS -> context.
    app.add_middleware(RequestContextMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=s.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "X-Request-ID"],
        expose_headers=["X-Request-ID", "Idempotent-Replay"],
    )
    app.add_middleware(BodySizeLimitMiddleware)
    app.add_middleware(RateLimitMiddleware)
    register_error_handlers(app)
    from app.ops.metrics import endpoint as metrics_endpoint
    app.add_api_route("/metrics", metrics_endpoint, methods=["GET"], include_in_schema=False)
    app.include_router(api_router, prefix=s.api_prefix)
    return app


app = create_app()
