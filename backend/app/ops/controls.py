"""Small key/value operational state in `system_controls` (heartbeats, last backup, attestations)."""

from datetime import UTC, datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import SystemControl

HEARTBEAT = "worker_heartbeat"
LAST_BACKUP = "last_backup"
LAST_RESTORE_DRILL = "last_restore_drill"
LAST_OFFSITE_BACKUP = "last_offsite_backup"
LAST_OFFSITE_ANCHOR = "last_offsite_anchor"
ATTEST_PREFIX = "attestation:"


async def get(db: AsyncSession, key: str) -> dict[str, Any] | None:
    row = await db.get(SystemControl, key)
    return row.value if row else None


async def put(db: AsyncSession, key: str, value: dict[str, Any], actor=None) -> None:
    row = await db.get(SystemControl, key, with_for_update=True)
    if row is None:
        db.add(SystemControl(key=key, value=value, updated_by=actor))
    else:
        row.value, row.updated_by = value, actor
    await db.flush()


def age_seconds(value: dict[str, Any] | None, field: str = "at") -> float | None:
    if not value or not value.get(field):
        return None
    return (datetime.now(UTC) - datetime.fromisoformat(value[field])).total_seconds()
