from fastapi import APIRouter

from app.api.v1 import (
    accounts,
    admin,
    ai,
    analytics,
    auth,
    backtests,
    binary,
    feedback,
    markets,
    ml,
    ops,
    research,
    risk,
    stream,
    system,
    trading,
    users,
)

api_router = APIRouter()
MODULES = (system, auth, users, accounts, markets, research, ai, ml, backtests, trading, binary, feedback, risk,
           analytics, admin, ops, stream)
for module in MODULES:
    api_router.include_router(module.router)
