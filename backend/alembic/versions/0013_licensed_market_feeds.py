"""licensed market feeds for stocks/ETFs and tradable FX

Revision ID: 0013
Revises: 0012
Create Date: 2026-11-25 12:00:00.000000

In live mode instruments must name a real provider. Stocks/ETFs move to Finnhub
(licensed US/UK equity and ETF quotes/candles) and spot FX to OANDA v20 (real
bid/ask). The public ECB fixing feed remains available as an explicitly named,
non-tradable source. Synthetic mode ignores this column, so public demos are
unchanged.
"""
from collections.abc import Sequence

from alembic import op

revision: str = '0013'
down_revision: str | None = '0012'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("UPDATE instruments SET data_provider = 'finnhub', provider_symbol = symbol "
               "WHERE asset_class IN ('STOCK','ETF')")
    op.execute("UPDATE instruments SET data_provider = 'oanda', "
               "provider_symbol = replace(symbol, '/', '_') WHERE asset_class = 'FX'")


def downgrade() -> None:
    op.execute("UPDATE instruments SET data_provider = 'synthetic', provider_symbol = symbol "
               "WHERE asset_class IN ('STOCK','ETF')")
    op.execute("UPDATE instruments SET data_provider = 'frankfurter', "
               "provider_symbol = replace(provider_symbol, '_', '/') WHERE asset_class = 'FX'")
