"""soft-launch feedback inbox

Revision ID: 0015
Revises: 0014
Create Date: 2026-11-25 15:00:00.000000

Stores feedback submitted from the public Feedback page. No raw IP address is stored in
this table; the audit log records the request context separately.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "feedback_submissions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("category", sa.String(32), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("reply_email", sa.String(320), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="new"),
    )
    op.create_index("ix_feedback_submissions_created_at", "feedback_submissions", ["created_at"])
    op.create_index("ix_feedback_submissions_status", "feedback_submissions", ["status"])


def downgrade() -> None:
    op.drop_index("ix_feedback_submissions_status", table_name="feedback_submissions")
    op.drop_index("ix_feedback_submissions_created_at", table_name="feedback_submissions")
    op.drop_table("feedback_submissions")
